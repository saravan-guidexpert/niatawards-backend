import { Types } from "mongoose";
import { WhatsAppMessageEvent } from "../models/WhatsAppMessageEvent";
import { WhatsAppRetryGroup } from "../models/WhatsAppRetryGroup";
import { maybeSettleRetryGroup, sendWhatsApp } from "./whatsappSend";
import { ensureTeacherSubmitParams } from "./teacherSubmitWhatsApp";
import {
  isMetaPermanentProviderError,
  MAX_AUTO_ATTEMPTS,
  RETRY_EXCLUSION_REASON,
  TERMINAL_SUCCESS_STATUSES,
} from "./whatsappRetryRules";

const CRON_BUDGET_MS = 25_000;
const GROUP_LIMIT = 50;

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

const isHardSkip = (row: {
  status?: string;
  retryExclusionReason?: string | null;
  retryExclusionMeta?: { note?: string } | null;
  webhookErrorCode?: string | null;
  errorMessage?: string | null;
  sendErrorCode?: string | null;
}) => {
  if (TERMINAL_SUCCESS_STATUSES.includes(row.status as (typeof TERMINAL_SUCCESS_STATUSES)[number])) {
    return RETRY_EXCLUSION_REASON.alreadyDeliveredOrRead;
  }
  const exclusion = String(row.retryExclusionReason || "");
  const note = String(row.retryExclusionMeta?.note || "");
  if (note === "opted_out" || /opt.?out/i.test(String(row.errorMessage || ""))) {
    return RETRY_EXCLUSION_REASON.permanentFailure;
  }
  if (
    exclusion === RETRY_EXCLUSION_REASON.alreadyDeliveredOrRead ||
    exclusion === RETRY_EXCLUSION_REASON.duplicateRetryPrevented ||
    exclusion === RETRY_EXCLUSION_REASON.missingPhone
  ) {
    return exclusion;
  }
  if (
    isMetaPermanentProviderError({
      errorCode: row.webhookErrorCode || row.sendErrorCode,
      errorMessage: row.errorMessage,
    })
  ) {
    return RETRY_EXCLUSION_REASON.permanentFailure;
  }
  return null;
};

const splitForRetry = (previous: Array<Record<string, unknown>>) => {
  const toSend: typeof previous = [];
  const excluded: { id: Types.ObjectId; reason: string }[] = [];
  for (const row of previous) {
    const hard = isHardSkip(row as Parameters<typeof isHardSkip>[0]);
    if (hard) {
      excluded.push({ id: row._id as Types.ObjectId, reason: hard });
      continue;
    }
    if (row.status !== "failed") continue;
    toSend.push(row);
  }
  return { toSend, excluded };
};

const claimBatch = async (groupId: Types.ObjectId, batchField: string, triggeredField: string, batchId: Types.ObjectId, now: Date) => {
  const cas = await WhatsAppRetryGroup.updateOne(
    { _id: groupId, status: "open", [batchField]: null },
    {
      $set: {
        [batchField]: batchId,
        [triggeredField]: now,
        nextPromotionDueAt: null,
        updatedAt: now,
      },
    }
  );
  return Boolean(cas.modifiedCount);
};

const unstickEmptyBatch = async (groupId: Types.ObjectId, nextAttempt: number, batchField: string) => {
  const existing = await WhatsAppMessageEvent.exists({
    retryGroupId: groupId,
    attemptNumber: nextAttempt,
  });
  if (existing) return false;
  const cleared = await WhatsAppRetryGroup.updateOne(
    { _id: groupId, status: "open", [batchField]: { $ne: null } },
    { $set: { [batchField]: null, updatedAt: new Date() } }
  );
  return Boolean(cleared.modifiedCount);
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
  if (latest && latest.status !== "failed") {
    return { outcome: "waiting" as const, sent: 0 };
  }
  const nextAttempt = fromAttempt + 1;
  if (nextAttempt > MAX_AUTO_ATTEMPTS) {
    await WhatsAppRetryGroup.updateOne(
      { _id: group._id, status: "open" },
      { $set: { status: "exhausted", nextPromotionDueAt: null, updatedAt: now } }
    );
    return { outcome: "exhausted" as const, sent: 0 };
  }

  const previous = await WhatsAppMessageEvent.find({
    retryGroupId: group._id,
    attemptNumber: fromAttempt,
  }).lean();
  const { toSend, excluded } = splitForRetry(previous);

  const batchField = nextAttempt === 2 ? "attempt2BatchId" : "attempt3BatchId";
  const triggeredField = nextAttempt === 2 ? "attempt2TriggeredAt" : "attempt3TriggeredAt";
  const completedField = nextAttempt === 2 ? "attempt1CompletedAt" : "attempt2CompletedAt";
  const batchId = new Types.ObjectId();

  const excludedByReason = new Map<string, Types.ObjectId[]>();
  for (const item of excluded) {
    const list = excludedByReason.get(item.reason) || [];
    list.push(item.id);
    excludedByReason.set(item.reason, list);
  }
  for (const [reason, ids] of excludedByReason) {
    await persistExclusion(ids, reason, nextAttempt, batchId);
  }

  if (!toSend.length) {
    await WhatsAppRetryGroup.updateOne(
      { _id: group._id, status: "open" },
      { $set: { status: "closed_no_more_retries", nextPromotionDueAt: null, updatedAt: now } }
    );
    return { outcome: "nothing_to_send" as const, sent: 0 };
  }

  let claimed = await claimBatch(group._id, batchField, triggeredField, batchId, now);
  if (!claimed) {
    const unstuck = await unstickEmptyBatch(group._id, nextAttempt, batchField);
    if (unstuck) claimed = await claimBatch(group._id, batchField, triggeredField, batchId, now);
  }
  if (!claimed) {
    return { outcome: "idempotent_race" as const, sent: 0 };
  }

  let sent = 0;
  for (const row of toSend) {
    const result = await sendWhatsApp({
      kind: String(row.messageKind),
      phone: String(row.phone),
      params: ensureTeacherSubmitParams(
        String(row.messageKind),
        Array.isArray(row.params) ? row.params.map((p) => String(p ?? "")) : []
      ),
      source: "retry_cron",
      attemptNumber: nextAttempt,
      retryGroupId: group._id,
      parentMessageEventId: row._id as Types.ObjectId,
      attemptBatchId: batchId,
      headerImageUrl: row.headerImageUrl ? String(row.headerImageUrl) : null,
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

export const promoteRetryGroupNow = async (retryGroupId: Types.ObjectId) => {
  const group = await WhatsAppRetryGroup.findById(retryGroupId).lean();
  if (!group) return { outcome: "missing" as const, sent: 0 };
  if (group.status !== "open") return { outcome: "not_open" as const, sent: 0 };
  return promoteGroup(group as GroupLean, new Date());
};

export const scanGroupsNeedingRetries = async () => {
  const started = Date.now();
  const now = new Date();

  const failedLatest = await WhatsAppMessageEvent.aggregate<{ _id: Types.ObjectId }>([
    { $match: { retryGroupId: { $ne: null } } },
    { $sort: { attemptNumber: -1 } },
    {
      $group: {
        _id: "$retryGroupId",
        status: { $first: "$status" },
        attemptNumber: { $first: "$attemptNumber" },
      },
    },
    { $match: { status: "failed", attemptNumber: { $lt: MAX_AUTO_ATTEMPTS } } },
    { $project: { _id: 1 } },
  ]);
  const failedGroupIds = failedLatest.map((row) => row._id);

  const groups = await WhatsAppRetryGroup.find({
    status: "open",
    $or: [
      { nextPromotionDueAt: { $ne: null, $lte: now } },
      { _id: { $in: failedGroupIds } },
    ],
  })
    .sort({ nextPromotionDueAt: 1, updatedAt: 1 })
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
