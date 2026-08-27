import { Types } from "mongoose";
import { WhatsAppMessageEvent } from "../models/WhatsAppMessageEvent";
import { WhatsAppRetryGroup } from "../models/WhatsAppRetryGroup";
import { maybeSettleRetryGroup, sendWhatsApp } from "./whatsappSend";
import {
  MAX_AUTO_ATTEMPTS,
  RETRY_EXCLUSION_REASON,
  TERMINAL_SUCCESS_STATUSES,
} from "./whatsappRetryRules";

const CRON_BUDGET_MS = 25_000;
const GROUP_LIMIT = 20;

type GroupLean = {
  _id: Types.ObjectId;
  messageKind: string;
  attempt2BatchId: Types.ObjectId | null;
  attempt3BatchId: Types.ObjectId | null;
};

const persistExclusion = async (
  eventIds: Types.ObjectId[],
  reason: string,
  nextAttempt: number,
  attemptBatchId: Types.ObjectId
) => {
  if (!eventIds.length) return;
  await WhatsAppMessageEvent.updateMany(
    { _id: { $in: eventIds } },
    {
      $set: {
        retryEligible: false,
        retryExclusionReason: reason,
        retryExclusionAt: new Date(),
        retryExclusionMeta: { nextAttempt, attemptBatchId, note: reason },
        updatedAt: new Date(),
      },
    }
  );
};

const promoteGroup = async (group: GroupLean, now: Date) => {
  const delivered = await WhatsAppMessageEvent.exists({
    retryGroupId: group._id,
    status: { $in: [...TERMINAL_SUCCESS_STATUSES] },
  });
  if (delivered) {
    await WhatsAppRetryGroup.updateOne(
      { _id: group._id },
      { $set: { status: "closed_no_more_retries", nextPromotionDueAt: null, updatedAt: now } }
    );
    return { outcome: "closed_delivered" as const, sent: 0 };
  }

  const latest = await WhatsAppMessageEvent.findOne({ retryGroupId: group._id })
    .sort({ attemptNumber: -1 })
    .lean();
  const fromAttempt = Number(latest?.attemptNumber || 1);
  const nextAttempt = fromAttempt + 1;
  if (nextAttempt > MAX_AUTO_ATTEMPTS) {
    await WhatsAppRetryGroup.updateOne(
      { _id: group._id, status: "open" },
      { $set: { status: "exhausted", nextPromotionDueAt: null, updatedAt: now } }
    );
    return { outcome: "exhausted" as const, sent: 0 };
  }

  const batchField = nextAttempt === 2 ? "attempt2BatchId" : "attempt3BatchId";
  const triggeredField = nextAttempt === 2 ? "attempt2TriggeredAt" : "attempt3TriggeredAt";
  const completedField = nextAttempt === 2 ? "attempt1CompletedAt" : "attempt2CompletedAt";
  const batchId = new Types.ObjectId();

  const cas = await WhatsAppRetryGroup.updateOne(
    { _id: group._id, status: "open", [batchField]: null },
    {
      $set: {
        [batchField]: batchId,
        [triggeredField]: now,
        nextPromotionDueAt: null,
        updatedAt: now,
      },
    }
  );
  if (!cas.modifiedCount) {
    return { outcome: "idempotent_race" as const, sent: 0 };
  }

  const previous = await WhatsAppMessageEvent.find({
    retryGroupId: group._id,
    attemptNumber: fromAttempt,
  }).lean();

  const toSend: typeof previous = [];
  const excluded: { id: Types.ObjectId; reason: string }[] = [];

  for (const row of previous) {
    if (TERMINAL_SUCCESS_STATUSES.includes(row.status as (typeof TERMINAL_SUCCESS_STATUSES)[number])) {
      excluded.push({ id: row._id as Types.ObjectId, reason: RETRY_EXCLUSION_REASON.alreadyDeliveredOrRead });
      continue;
    }
    if (row.retryEligible === false) {
      excluded.push({
        id: row._id as Types.ObjectId,
        reason: row.retryExclusionReason || RETRY_EXCLUSION_REASON.retryEligibilityDisabled,
      });
      continue;
    }
    if (row.status !== "failed") {
      excluded.push({ id: row._id as Types.ObjectId, reason: RETRY_EXCLUSION_REASON.inFlightTimeout });
      continue;
    }
    toSend.push(row);
  }

  const excludedByReason = new Map<string, Types.ObjectId[]>();
  for (const item of excluded) {
    const list = excludedByReason.get(item.reason) || [];
    list.push(item.id);
    excludedByReason.set(item.reason, list);
  }
  for (const [reason, ids] of excludedByReason) {
    await persistExclusion(ids, reason, nextAttempt, batchId);
  }

  let sent = 0;
  for (const row of toSend) {
    const result = await sendWhatsApp({
      kind: row.messageKind,
      phone: row.phone,
      params: Array.isArray(row.params) ? row.params : [],
      source: "retry_cron",
      attemptNumber: nextAttempt,
      retryGroupId: group._id,
      parentMessageEventId: row._id as Types.ObjectId,
      attemptBatchId: batchId,
      headerImageUrl: row.headerImageUrl,
    });
    if (result.duplicate) {
      await WhatsAppMessageEvent.updateOne(
        { _id: row._id },
        {
          $set: {
            retryEligible: false,
            retryExclusionReason: RETRY_EXCLUSION_REASON.duplicateRetryPrevented,
            retryExclusionAt: new Date(),
            updatedAt: new Date(),
          },
        }
      );
    } else {
      sent += 1;
    }
  }

  await WhatsAppRetryGroup.updateOne(
    { _id: group._id },
    { $set: { [completedField]: new Date(), updatedAt: new Date() } }
  );
  await maybeSettleRetryGroup(group._id);
  return { outcome: "promoted" as const, sent, nextAttempt };
};

export const scanGroupsNeedingRetries = async () => {
  const started = Date.now();
  const now = new Date();
  const groups = await WhatsAppRetryGroup.find({
    status: "open",
    nextPromotionDueAt: { $ne: null, $lte: now },
  })
    .sort({ nextPromotionDueAt: 1 })
    .limit(GROUP_LIMIT)
    .lean();

  const results: Array<{ groupId: string; outcome: string; sent: number }> = [];
  for (const group of groups) {
    if (Date.now() - started > CRON_BUDGET_MS) break;
    const result = await promoteGroup(group as GroupLean, now);
    results.push({ groupId: String(group._id), outcome: result.outcome, sent: result.sent });
  }

  return {
    scanned: groups.length,
    processed: results.length,
    sent: results.reduce((sum, r) => sum + r.sent, 0),
    results,
    elapsedMs: Date.now() - started,
  };
};
