import { Types } from "mongoose";
import { WhatsAppMessageEvent } from "../models/WhatsAppMessageEvent";
import { WhatsAppOptOut } from "../models/WhatsAppOptOut";
import { WhatsAppWebhookEvent } from "../models/WhatsAppWebhookEvent";
import { toPhone10 } from "./gupshup";
import {
  classifyCampaignFailure,
  RETRY_EXCLUSION_REASON,
} from "./whatsappRetryRules";
import { maybeSettleRetryGroup, scheduleRetryPromotion } from "./whatsappSend";

const SUCCESS_RANK: Record<string, number> = {
  queued: 1,
  submitted: 3,
  sent: 4,
  delivered: 5,
  read: 6,
};

export const mapStageToDbStatus = (stage: unknown) => {
  const v = String(stage || "").toLowerCase();
  if (v === "enqueued") return "submitted";
  if (v === "sent") return "sent";
  if (v === "delivered") return "delivered";
  if (v === "read") return "read";
  if (v === "failed") return "failed";
  return null;
};

export const canApplyWebhookStatus = (currentStatus: string, newStatus: string) => {
  if (!newStatus) return false;
  const cur = String(currentStatus || "").toLowerCase();
  const next = String(newStatus).toLowerCase();
  if (cur === "retry_exhausted") return next === "delivered" || next === "read";
  if (next === "failed") {
    if (cur === "failed" || cur === "retry_exhausted") return false;
    if ((SUCCESS_RANK[cur] || 0) >= 5) return false;
    return true;
  }
  if (cur === "failed") return next === "delivered" || next === "read";
  return (SUCCESS_RANK[next] || 0) > (SUCCESS_RANK[cur] || 0);
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export const parseWebhookRoot = (body: unknown): Record<string, unknown> => {
  let root: unknown = body;
  if (typeof root === "string") {
    try {
      root = JSON.parse(root);
    } catch {
      return {};
    }
  }
  const rec = asRecord(root);
  if (typeof rec.payload === "string") {
    try {
      const parsed = JSON.parse(rec.payload);
      if (parsed && typeof parsed === "object") {
        const parsedRec = asRecord(parsed);
        if (parsedRec.type) return parsedRec;
        return { ...rec, payload: parsed };
      }
    } catch {
      return rec;
    }
  }
  return rec;
};

const snippet = (data: unknown) => {
  try {
    return JSON.stringify(data).slice(0, 2000);
  } catch {
    return String(data ?? "").slice(0, 2000);
  }
};

const recordWebhook = async (fields: {
  type: "message" | "message-event" | "unknown";
  webhookDedupeKey: string;
  gsId?: string | null;
  providerId?: string | null;
  eventStage?: string | null;
  destination?: string | null;
  sourcePhone?: string | null;
  inboundText?: string | null;
  matchedMessageEventId?: Types.ObjectId | null;
  payloadSnippet?: string | null;
}) => {
  try {
    await WhatsAppWebhookEvent.create(fields);
    return { duplicate: false };
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? (err as { code?: number }).code : undefined;
    if (code === 11000) return { duplicate: true };
    throw err;
  }
};

const matchOutboundEvent = async (ids: string[], destination: string) => {
  const unique = [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];
  if (unique.length) {
    const byId = await WhatsAppMessageEvent.findOne({
      $or: unique.flatMap((id) => [
        { gupshupMessageId: id },
        { gupshupInternalMessageId: id },
        { whatsappWaMessageId: id },
      ]),
    }).sort({ createdAt: -1 });
    if (byId) return byId;
  }
  const phone = toPhone10(destination);
  if (!/^\d{10}$/.test(phone)) return null;
  return WhatsAppMessageEvent.findOne({
    phone,
    status: { $in: ["queued", "submitted", "sent", "failed"] },
  }).sort({ createdAt: -1 });
};

export const handleInboundMessage = async (root: Record<string, unknown>) => {
  const payload = asRecord(root.payload);
  const inner = asRecord(payload.payload);
  const from = toPhone10(String(payload.source || payload.sender || ""));
  const text = String(inner.text || inner.title || inner.postbackText || payload.text || "").trim();
  const providerId = String(payload.id || root.id || "").trim();
  const dedupeKey = `message:${providerId || `${from}:${text.slice(0, 40)}`}`;

  const recorded = await recordWebhook({
    type: "message",
    webhookDedupeKey: dedupeKey.slice(0, 256),
    providerId: providerId || null,
    sourcePhone: from || null,
    inboundText: text.slice(0, 4096) || null,
    payloadSnippet: snippet(root),
  });
  if (recorded.duplicate) return { received: true, duplicate: true };

  if (/^\d{10}$/.test(from) && /^\s*stop\s*$/i.test(text)) {
    await WhatsAppOptOut.updateOne(
      { phone: from },
      { $set: { phone: from, reason: "STOP", inboundText: text, optedOutAt: new Date() } },
      { upsert: true }
    );
    return { received: true, optedOut: true };
  }

  return { received: true };
};

export const handleDeliveryEvent = async (root: Record<string, unknown>) => {
  const payload = asRecord(root.payload);
  const inner = asRecord(payload.payload);
  const stage = String(payload.type || inner.type || "").toLowerCase();
  const gsId = String(payload.gsId || payload.gsid || inner.gsId || payload.id || "").trim();
  const destination = String(payload.destination || inner.destination || "").trim();
  const errorCode = String(payload.errorCode || inner.errorCode || payload.code || "").trim();
  const errorReason = String(
    payload.reason || payload.errorReason || inner.reason || payload.failedReason || ""
  ).trim();
  const newStatus = mapStageToDbStatus(stage);
  const dedupeKey = `message-event:${gsId}:${stage}:${destination}`.slice(0, 256);

  const recorded = await recordWebhook({
    type: "message-event",
    webhookDedupeKey: dedupeKey,
    gsId: gsId || null,
    providerId: String(payload.id || "").trim() || null,
    eventStage: stage || null,
    destination: destination || null,
    payloadSnippet: snippet(root),
  });
  if (recorded.duplicate) return { received: true, duplicate: true };
  if (!newStatus) return { received: true, ignored: true };

  const doc = await matchOutboundEvent([gsId, String(payload.id || "")], destination);
  if (!doc) return { received: true, unmatched: true };

  await WhatsAppWebhookEvent.updateOne(
    { webhookDedupeKey: dedupeKey },
    { $set: { matchedMessageEventId: doc._id } }
  );

  if (!canApplyWebhookStatus(String(doc.status), newStatus)) {
    return { received: true, skipped: true };
  }

  const set: Record<string, unknown> = {
    status: newStatus,
    updatedAt: new Date(),
  };
  if (gsId && !doc.gupshupMessageId) set.gupshupMessageId = gsId;
  if (newStatus === "sent") set.sentAt = doc.sentAt || new Date();
  if (newStatus === "delivered") set.deliveredAt = new Date();
  if (newStatus === "read") {
    set.readAt = new Date();
    if (!doc.deliveredAt) set.deliveredAt = new Date();
  }

  if (newStatus === "delivered" || newStatus === "read") {
    set.retryEligible = false;
    set.retryExclusionReason = RETRY_EXCLUSION_REASON.alreadyDeliveredOrRead;
    set.retryExclusionAt = new Date();
    set.terminalFailureKind = null;
  }

  if (newStatus === "failed") {
    const afterProviderAccept = Boolean(doc.providerAcceptedAt) || ["submitted", "sent"].includes(String(doc.status));
    const classification = classifyCampaignFailure(
      { errorCode, errorReason, errorText: errorReason, errorMessage: errorReason },
      { afterProviderAccept, attemptNumber: doc.attemptNumber }
    );
    set.failedAt = new Date();
    set.errorMessage = (errorReason || errorCode || "Delivery failed").slice(0, 2000);
    set.webhookErrorCode = errorCode.slice(0, 32) || null;
    set.webhookErrorReason = errorReason.slice(0, 2000) || null;
    set.retryEligible = classification.retryable;
    set.terminalFailureKind = classification.terminalFailureKind;
    set.retryExclusionReason = classification.retryable ? null : classification.exclusionReason;
    set.retryExclusionAt = classification.retryable ? null : new Date();
    if (classification.metaNote) {
      set.retryExclusionMeta = { note: classification.metaNote };
    }
    await WhatsAppMessageEvent.updateOne({ _id: doc._id }, { $set: set });
    if (classification.retryable) {
      await scheduleRetryPromotion(doc.retryGroupId as Types.ObjectId, doc.attemptNumber);
    } else {
      await maybeSettleRetryGroup(doc.retryGroupId as Types.ObjectId);
    }
    return { received: true, status: newStatus };
  }

  await WhatsAppMessageEvent.updateOne({ _id: doc._id }, { $set: set });
  if (newStatus === "delivered" || newStatus === "read") {
    await maybeSettleRetryGroup(doc.retryGroupId as Types.ObjectId);
  }
  return { received: true, status: newStatus };
};

const metaTextFromMessage = (message: Record<string, unknown>) => {
  const text = asRecord(message.text);
  const button = asRecord(message.button);
  const interactive = asRecord(message.interactive);
  const buttonReply = asRecord(interactive.button_reply);
  return String(
    text.body || button.text || button.payload || buttonReply.title || buttonReply.id || message.body || ""
  ).trim();
};

export const isMetaV3Payload = (root: Record<string, unknown>) => Array.isArray(root.entry);

export const handleMetaV3Payload = async (root: Record<string, unknown>) => {
  const entries = Array.isArray(root.entry) ? root.entry : [];
  for (const entry of entries) {
    const changes = asRecord(entry).changes;
    const changeList = Array.isArray(changes) ? changes : [];
    for (const change of changeList) {
      const value = asRecord(asRecord(change).value);
      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const raw of messages) {
        const message = asRecord(raw);
        const from = toPhone10(String(message.from || ""));
        const text = metaTextFromMessage(message);
        const providerId = String(message.id || "").trim();
        const synthetic: Record<string, unknown> = {
          type: "message",
          payload: { id: providerId, source: from, payload: { type: "text", text } },
        };
        await handleInboundMessage(synthetic);
      }
      const statuses = Array.isArray(value.statuses) ? value.statuses : [];
      for (const raw of statuses) {
        const st = asRecord(raw);
        const ids = [st.gs_id, st.gsId, st.meta_msg_id, st.id].map((v) => String(v || "").trim()).filter(Boolean);
        const destination = String(st.recipient_id || "");
        const stage = String(st.status || "").toLowerCase();
        const errors = Array.isArray(st.errors) ? st.errors : [];
        const err = asRecord(errors[0]);
        const errorData = asRecord(err.error_data);
        const errorCode = String(err.code || "").trim();
        const errorReason = String(err.message || err.title || errorData.details || "").trim();
        const synthetic: Record<string, unknown> = {
          type: "message-event",
          payload: {
            type: stage,
            gsId: ids[0] || "",
            id: String(st.id || ""),
            destination,
            errorCode,
            reason: errorReason,
          },
        };
        await handleDeliveryEvent(synthetic);
        if (ids.length > 1) {
          const doc = await matchOutboundEvent(ids, destination);
          if (doc) {
            const extra: Record<string, unknown> = { updatedAt: new Date() };
            if (ids.find((id) => id.startsWith("wamid.")) && !doc.whatsappWaMessageId) {
              extra.whatsappWaMessageId = ids.find((id) => id.startsWith("wamid.")) || null;
            }
            await WhatsAppMessageEvent.updateOne({ _id: doc._id }, { $set: extra });
          }
        }
      }
    }
  }
  return { received: true };
};
