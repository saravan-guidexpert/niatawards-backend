import { Types } from "mongoose";
import { WhatsAppMessageEvent } from "../models/WhatsAppMessageEvent";
import { WhatsAppOptOut } from "../models/WhatsAppOptOut";
import { WhatsAppRetryGroup } from "../models/WhatsAppRetryGroup";
import {
  sendTemplateMessage,
  templateEnvKeyForKind,
  templateIdForKind,
  toPhone10,
} from "./gupshup";
import {
  classifyCampaignFailure,
  getRetryDelayMsAfterAttempt,
  MAX_AUTO_ATTEMPTS,
  RETRY_EXCLUSION_REASON,
  retrySourceFromAttemptNumber,
  TERMINAL_SUCCESS_STATUSES,
} from "./whatsappRetryRules";

export type SendWhatsAppInput = {
  kind: string;
  phone: string;
  params?: string[];
  source?: "api" | "retry_cron" | "admin_manual";
  attemptNumber?: number;
  retryGroupId?: string | Types.ObjectId | null;
  parentMessageEventId?: string | Types.ObjectId | null;
  attemptBatchId?: string | Types.ObjectId | null;
  headerImageUrl?: string | null;
};

export type SendWhatsAppResult = {
  success: boolean;
  eventId: string | null;
  retryGroupId: string | null;
  status: string;
  error?: string;
  duplicate?: boolean;
};

const toOid = (value: string | Types.ObjectId | null | undefined) => {
  if (!value) return null;
  const s = String(value);
  return Types.ObjectId.isValid(s) ? new Types.ObjectId(s) : null;
};

const snippet = (data: unknown) => {
  try {
    return JSON.stringify(data).slice(0, 1200);
  } catch {
    return String(data ?? "").slice(0, 1200);
  }
};

const normalizeParams = (params: string[] | undefined) =>
  (Array.isArray(params) ? params : []).map((p) => String(p ?? "").slice(0, 1024));

const normalizeKind = (kind: string) => {
  const k = String(kind || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_|_$/g, "");
  return k || "generic";
};

export const scheduleRetryPromotion = async (
  retryGroupId: Types.ObjectId,
  fromAttempt: number
) => {
  if (fromAttempt >= MAX_AUTO_ATTEMPTS) {
    await WhatsAppRetryGroup.updateOne(
      { _id: retryGroupId, status: "open" },
      { $set: { status: "exhausted", nextPromotionDueAt: null, updatedAt: new Date() } }
    );
    return;
  }
  const due = new Date(Date.now() + getRetryDelayMsAfterAttempt(fromAttempt));
  await WhatsAppRetryGroup.updateOne(
    {
      _id: retryGroupId,
      status: "open",
      $or: [{ nextPromotionDueAt: null }, { nextPromotionDueAt: { $gt: due } }],
    },
    { $set: { nextPromotionDueAt: due, updatedAt: new Date() } }
  );
};

export const maybeSettleRetryGroup = async (retryGroupId: Types.ObjectId) => {
  const delivered = await WhatsAppMessageEvent.exists({
    retryGroupId,
    status: { $in: [...TERMINAL_SUCCESS_STATUSES] },
  });
  if (delivered) {
    await WhatsAppRetryGroup.updateOne(
      { _id: retryGroupId, status: "open" },
      { $set: { status: "closed_no_more_retries", nextPromotionDueAt: null, updatedAt: new Date() } }
    );
    return;
  }

  const eligible = await WhatsAppMessageEvent.exists({
    retryGroupId,
    retryEligible: true,
    status: "failed",
    attemptNumber: { $lt: MAX_AUTO_ATTEMPTS },
  });
  if (eligible) return;

  const maxRow = await WhatsAppMessageEvent.findOne({ retryGroupId }).sort({ attemptNumber: -1 }).lean();
  const maxAttempt = Number(maxRow?.attemptNumber || 1);
  if (maxAttempt >= MAX_AUTO_ATTEMPTS) {
    await WhatsAppRetryGroup.updateOne(
      { _id: retryGroupId, status: "open" },
      { $set: { status: "exhausted", nextPromotionDueAt: null, updatedAt: new Date() } }
    );
    return;
  }

  const anyOpenFailure = await WhatsAppMessageEvent.exists({
    retryGroupId,
    status: "failed",
  });
  if (!anyOpenFailure) {
    await WhatsAppRetryGroup.updateOne(
      { _id: retryGroupId, status: "open" },
      { $set: { status: "closed_no_more_retries", nextPromotionDueAt: null, updatedAt: new Date() } }
    );
  }
};

const applyClassification = async (
  eventId: Types.ObjectId,
  retryGroupId: Types.ObjectId,
  classification: ReturnType<typeof classifyCampaignFailure>,
  extra: Record<string, unknown>
) => {
  const set: Record<string, unknown> = {
    status: "failed",
    failedAt: new Date(),
    updatedAt: new Date(),
    retryEligible: classification.retryable,
    terminalFailureKind: classification.terminalFailureKind,
    retryExclusionReason: classification.retryable ? null : classification.exclusionReason,
    retryExclusionAt: classification.retryable ? null : new Date(),
    retryExclusionMeta: classification.metaNote ? { note: classification.metaNote } : undefined,
    ...extra,
  };
  await WhatsAppMessageEvent.updateOne({ _id: eventId }, { $set: set });
  if (classification.retryable) {
    const event = await WhatsAppMessageEvent.findById(eventId).lean();
    await scheduleRetryPromotion(retryGroupId, Number(event?.attemptNumber || 1));
  } else {
    await maybeSettleRetryGroup(retryGroupId);
  }
};

export const sendWhatsApp = async (input: SendWhatsAppInput): Promise<SendWhatsAppResult> => {
  const phone = toPhone10(input.phone);
  const kind = normalizeKind(input.kind);
  const params = normalizeParams(input.params);
  const source = input.source || "api";
  const attemptNumber = Math.min(6, Math.max(1, Number(input.attemptNumber) || 1));
  const templateIdEnvKey = templateEnvKeyForKind(kind);
  const templateId = templateIdForKind(kind);
  const headerImageUrl = input.headerImageUrl?.trim() || null;

  if (!/^\d{10}$/.test(phone)) {
    return { success: false, eventId: null, retryGroupId: null, status: "failed", error: "Invalid phone" };
  }

  let retryGroupId = toOid(input.retryGroupId);
  if (!retryGroupId) {
    const group = await WhatsAppRetryGroup.create({
      messageKind: kind,
      trigger: source,
      status: "open",
    });
    retryGroupId = group._id as Types.ObjectId;
  }

  const optedOut = await WhatsAppOptOut.exists({ phone });
  if (optedOut) {
    try {
      const event = await WhatsAppMessageEvent.create({
        retryGroupId,
        attemptNumber,
        parentMessageEventId: toOid(input.parentMessageEventId),
        attemptBatchId: toOid(input.attemptBatchId),
        retrySource: retrySourceFromAttemptNumber(attemptNumber),
        phone,
        messageKind: kind,
        source,
        templateIdEnvKey,
        templateId,
        params,
        headerImageUrl,
        status: "failed",
        failedAt: new Date(),
        errorMessage: "Recipient opted out (STOP)",
        retryEligible: false,
        terminalFailureKind: "permanent",
        retryExclusionReason: RETRY_EXCLUSION_REASON.permanentFailure,
        retryExclusionAt: new Date(),
        retryExclusionMeta: { note: "opted_out" },
      });
      await maybeSettleRetryGroup(retryGroupId);
      return {
        success: false,
        eventId: String(event._id),
        retryGroupId: String(retryGroupId),
        status: "failed",
        error: "Recipient opted out (STOP)",
      };
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code?: number }).code : undefined;
      if (code === 11000) {
        const existing = await WhatsAppMessageEvent.findOne({ retryGroupId, phone, attemptNumber }).lean();
        return {
          success: existing?.status === "delivered" || existing?.status === "read" || existing?.status === "submitted" || existing?.status === "sent",
          eventId: existing ? String(existing._id) : null,
          retryGroupId: String(retryGroupId),
          status: String(existing?.status || "failed"),
          duplicate: true,
        };
      }
      throw err;
    }
  }

  let eventId: Types.ObjectId;
  try {
    const event = await WhatsAppMessageEvent.create({
      retryGroupId,
      attemptNumber,
      parentMessageEventId: toOid(input.parentMessageEventId),
      attemptBatchId: toOid(input.attemptBatchId),
      retrySource: retrySourceFromAttemptNumber(attemptNumber),
      phone,
      messageKind: kind,
      source,
      templateIdEnvKey,
      templateId,
      params,
      headerImageUrl,
      status: "queued",
      retryEligible: false,
    });
    eventId = event._id as Types.ObjectId;
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? (err as { code?: number }).code : undefined;
    if (code === 11000) {
      const existing = await WhatsAppMessageEvent.findOne({ retryGroupId, phone, attemptNumber }).lean();
      return {
        success: ["submitted", "sent", "delivered", "read"].includes(String(existing?.status)),
        eventId: existing ? String(existing._id) : null,
        retryGroupId: String(retryGroupId),
        status: String(existing?.status || "queued"),
        duplicate: true,
        error: "duplicate_retry_prevented",
      };
    }
    throw err;
  }

  const result = await sendTemplateMessage(phone, templateId || "", params, {
    headerImageUrl,
    templateEnvKey: templateIdEnvKey,
  });

  if (result.success) {
    const canonical = result.ids.canonicalMessageId;
    await WhatsAppMessageEvent.updateOne(
      { _id: eventId },
      {
        $set: {
          status: "submitted",
          gupshupMessageId: canonical,
          gupshupInternalMessageId: result.ids.gupshupInternalMessageId,
          whatsappWaMessageId: result.ids.whatsappWaMessageId,
          providerAcceptedAt: new Date(),
          providerPayloadSnippet: snippet(result.data),
          retryEligible: true,
          sentAt: new Date(),
          updatedAt: new Date(),
        },
      }
    );
    return {
      success: true,
      eventId: String(eventId),
      retryGroupId: String(retryGroupId),
      status: "submitted",
    };
  }

  const classification = classifyCampaignFailure(
    { errorMessage: result.error, errorText: result.error, errorCode: result.httpStatus ? String(result.httpStatus) : null },
    { attemptNumber }
  );
  await applyClassification(eventId, retryGroupId, classification, {
    errorMessage: String(result.error || "Gupshup send failed").slice(0, 2000),
    sendErrorCode: result.httpStatus ? String(result.httpStatus) : null,
    providerPayloadSnippet: snippet(result.data),
  });

  return {
    success: false,
    eventId: String(eventId),
    retryGroupId: String(retryGroupId),
    status: "failed",
    error: result.error,
  };
};
