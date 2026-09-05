/**
 * Nomination-level WhatsApp video delivery via Gupshup.
 *
 * One teacher phone + one nomination kind = one delivery.
 * Multiple NominationVideos for the same teacher/type share that single message.
 * Destination is always Nomination.phone (teacher). Never student/nominator/colleague phones.
 * AfterSessionNomination is never queried or queued.
 * Does not generate, regenerate, or crop videos.
 */
import { randomUUID } from "crypto";
import { Types } from "mongoose";
import { Nomination } from "../models/Nomination";
import { NominationVideo } from "../models/NominationVideo";
import { WhatsAppMessageEvent } from "../models/WhatsAppMessageEvent";
import { WhatsAppOptOut } from "../models/WhatsAppOptOut";
import { WhatsAppRetryGroup } from "../models/WhatsAppRetryGroup";
import {
  KIND_GROUP_LABEL,
  nominationKind,
  photoStateOf,
  teacherDisplayName,
  usableTeacherPhone,
  type NominationKind,
} from "./nominationKind";

/** Authorized repeatable test destination. Production phones are never rewritten to this. */
export const VIDEO_MESSAGING_TEST_PHONE = "9347763131";

export const isWhatsAppTestRecipient = (phone: unknown) =>
  usableTeacherPhone(phone) === VIDEO_MESSAGING_TEST_PHONE;

export const teacherKindKey = (phone: unknown, kind: unknown) =>
  `${usableTeacherPhone(phone)}:${String(kind || "").trim()}`;

import {
  maskPhone,
  sendTemplateMessage,
  templateEnvKeyForKind,
  templateIdForKind,
} from "./gupshup";
import { isMetaPermanentProviderError, RETRY_EXCLUSION_REASON } from "./whatsappRetryRules";
import { videoProductionValid } from "./videoIdentity";

export const NOMINATION_VIDEO_WHATSAPP_KIND: Record<NominationKind, string> = {
  student: "student_nominated_teacher",
  teacher: "teacher_nominated",
  colleague: "teacher_nominated_other",
};

export const NOMINATION_VIDEO_WHATSAPP_KINDS = Object.values(NOMINATION_VIDEO_WHATSAPP_KIND);

export const ACTIVE_VIDEO_WHATSAPP_STATUSES = ["queued", "submitted", "sent", "delivered", "read"] as const;

export type NominationVideoWhatsAppFailReason =
  | "nomination_not_found"
  | "nomination_draft"
  | "after_session_excluded"
  | "missing_teacher_phone"
  | "video_not_found"
  | "video_nomination_mismatch"
  | "video_not_generated"
  | "invalid_video_url"
  | "video_category_mismatch"
  | "not_ready_for_message"
  | "review_blocked"
  | "template_id_missing"
  | "opted_out"
  | "duplicate_active_send"
  | "duplicate_teacher_kind"
  | "gupshup_not_configured"
  | "invalid_destination";

export type EligibleNominationVideoWhatsApp = {
  nominationId: string;
  nominationVideoId: string;
  nominationKind: NominationKind;
  nominationTypeLabel: string;
  whatsappKind: string;
  templateEnvKey: string;
  templateId: string;
  teacherPhone: string;
  teacherName: string;
  videoUrl: string;
};

const text = (value: unknown) => String(value ?? "").trim();

export const isNominationVideoWhatsAppKind = (kind: unknown) =>
  NOMINATION_VIDEO_WHATSAPP_KINDS.includes(String(kind || "").trim());

export const whatsappKindForNominationKind = (kind: NominationKind) => NOMINATION_VIDEO_WHATSAPP_KIND[kind];

export const templateEnvKeyForNominationKind = (kind: NominationKind) =>
  templateEnvKeyForKind(whatsappKindForNominationKind(kind));

export const isActiveVideoWhatsAppStatus = (status: unknown) =>
  ACTIVE_VIDEO_WHATSAPP_STATUSES.includes(
    String(status || "") as (typeof ACTIVE_VIDEO_WHATSAPP_STATUSES)[number]
  );

export const existingVideoDeliveryDecision = (
  existing: { status?: unknown; phone?: unknown } | null | undefined,
  allowRetry: boolean,
  opts?: { teacherPhone?: unknown }
): "send" | "duplicate" | "retry" => {
  if (!existing) return "send";
  const status = String(existing.status || "");
  const testRecipient = isWhatsAppTestRecipient(opts?.teacherPhone ?? existing.phone);
  // Test number 9347763131 may be resent after webhook delivery. One active queued send still blocks.
  if (testRecipient) {
    if (status === "queued") return "duplicate";
    return "retry";
  }
  if (status === "delivered" || status === "read") return "duplicate";
  if (status === "queued") return "duplicate";
  if (
    allowRetry &&
    (status === "failed" || status === "retry_exhausted" || status === "submitted" || status === "sent")
  ) {
    return "retry";
  }
  if (isActiveVideoWhatsAppStatus(status)) return "duplicate";
  return "duplicate";
};

/** Deterministic pick: ready_for_message, then approved, then newest generated_at, then id. */
export const comparePreferredVideos = (
  a: { ready_for_message?: unknown; review_status?: unknown; generated_at?: unknown; _id?: unknown },
  b: { ready_for_message?: unknown; review_status?: unknown; generated_at?: unknown; _id?: unknown }
) => {
  const ready = Number(b.ready_for_message === true) - Number(a.ready_for_message === true);
  if (ready) return ready;
  const approved = Number(String(b.review_status || "") === "approved") - Number(String(a.review_status || "") === "approved");
  if (approved) return approved;
  const tb = new Date(String(b.generated_at || 0)).getTime() || 0;
  const ta = new Date(String(a.generated_at || 0)).getTime() || 0;
  if (tb !== ta) return tb - ta;
  return String(b._id || "").localeCompare(String(a._id || ""));
};

export const findTeacherKindWhatsAppEvent = (phone: string, kind: NominationKind) =>
  WhatsAppMessageEvent.findOne({
    phone,
    nominationKind: kind,
  }).sort({ createdAt: -1 });

const httpsVideoUrl = (url: unknown) => {
  const value = text(url);
  if (!/^https:\/\//i.test(value)) return "";
  return value;
};

export const evaluateNominationVideoWhatsAppFromDocs = (opts: {
  nomination: {
    _id?: unknown;
    id?: unknown;
    type?: unknown;
    student_class?: unknown;
    phone?: unknown;
    nominator_phone?: unknown;
    teacher_name?: unknown;
    full_name?: unknown;
    nominator_name?: unknown;
    photo_url?: unknown;
    status?: unknown;
  } | null;
  video: {
    _id?: unknown;
    id?: unknown;
    nomination_id?: unknown;
    generation_status?: unknown;
    video_url?: unknown;
    ready_for_message?: unknown;
    review_status?: unknown;
    video_template?: unknown;
    nomination_kind?: unknown;
    photo_used?: unknown;
    video_category?: unknown;
  } | null;
  fromAfterSession?: boolean;
}): { ok: true; value: EligibleNominationVideoWhatsApp } | { ok: false; reason: NominationVideoWhatsAppFailReason } => {
  if (opts.fromAfterSession) return { ok: false, reason: "after_session_excluded" };
  const nomination = opts.nomination;
  if (!nomination) return { ok: false, reason: "nomination_not_found" };

  const nominationId = text(nomination._id ?? nomination.id);
  if (!nominationId) return { ok: false, reason: "nomination_not_found" };
  if (String(nomination.status || "") === "draft") return { ok: false, reason: "nomination_draft" };

  const kind = nominationKind(nomination);
  const teacherPhone = usableTeacherPhone(nomination.phone);
  if (!teacherPhone) return { ok: false, reason: "missing_teacher_phone" };

  const video = opts.video;
  if (!video) return { ok: false, reason: "video_not_found" };

  const nominationVideoId = text(video._id ?? video.id);
  if (!nominationVideoId) return { ok: false, reason: "video_not_found" };
  if (text(video.nomination_id) !== nominationId) return { ok: false, reason: "video_nomination_mismatch" };

  const videoUrl = httpsVideoUrl(video.video_url);
  if (String(video.generation_status || "") !== "generated") return { ok: false, reason: "video_not_generated" };
  if (!videoUrl) return { ok: false, reason: "invalid_video_url" };

  const productionOk = videoProductionValid({
    video,
    nominationId,
    expectedKind: kind,
    expectedPhoto: photoStateOf(nomination.photo_url),
  });
  if (!productionOk) return { ok: false, reason: "video_category_mismatch" };

  const reviewStatus = String(video.review_status || "");
  if (
    (reviewStatus === "rejected" || reviewStatus === "regeneration_required") &&
    video.ready_for_message !== true
  ) {
    return { ok: false, reason: "review_blocked" };
  }

  const whatsappKind = whatsappKindForNominationKind(kind);
  const templateEnvKey = templateEnvKeyForNominationKind(kind);
  const templateId = templateIdForKind(whatsappKind);
  if (!templateId) return { ok: false, reason: "template_id_missing" };

  return {
    ok: true,
    value: {
      nominationId,
      nominationVideoId,
      nominationKind: kind,
      nominationTypeLabel: KIND_GROUP_LABEL[kind],
      whatsappKind,
      templateEnvKey,
      templateId,
      teacherPhone,
      teacherName: teacherDisplayName(nomination) || "Teacher",
      videoUrl,
    },
  };
};

export const logNominationVideoWhatsAppPlan = (value: EligibleNominationVideoWhatsApp) => {
  console.log(
    JSON.stringify({
      event: "nomination_video_whatsapp_plan",
      nominationId: value.nominationId,
      nominationKind: value.nominationKind,
      nominationTypeLabel: value.nominationTypeLabel,
      teacherPhone: maskPhone(value.teacherPhone),
      nominationVideoId: value.nominationVideoId,
      videoUrl: value.videoUrl,
      templateEnvKey: value.templateEnvKey,
    })
  );
};

export const loadEligibleNominationVideoWhatsApp = async (opts: {
  nominationId?: string;
  nominationVideoId?: string;
}): Promise<{ ok: true; value: EligibleNominationVideoWhatsApp } | { ok: false; reason: NominationVideoWhatsAppFailReason }> => {
  const nominationId = text(opts.nominationId);
  const nominationVideoId = text(opts.nominationVideoId);

  let nomination = nominationId ? await Nomination.findById(nominationId).lean() : null;
  let video = nominationVideoId ? await NominationVideo.findById(nominationVideoId).lean() : null;

  if (!nomination && video) {
    nomination = await Nomination.findById(text(video.nomination_id)).lean();
  }
  if (!video && nomination) {
    video = await NominationVideo.findOne({ nomination_id: String(nomination._id) }).lean();
  }

  // AfterSessionNomination is a different collection and is never loaded here.
  return evaluateNominationVideoWhatsAppFromDocs({
    nomination: nomination as Parameters<typeof evaluateNominationVideoWhatsAppFromDocs>[0]["nomination"],
    video: video as Parameters<typeof evaluateNominationVideoWhatsAppFromDocs>[0]["video"],
  });
};

const snippet = (data: unknown) => {
  try {
    return JSON.stringify(data).slice(0, 1200);
  } catch {
    return String(data ?? "").slice(0, 1200);
  }
};

export type EnqueueNominationVideoWhatsAppResult = {
  ok: boolean;
  eventId: string | null;
  retryGroupId: string | null;
  status: string;
  duplicate?: boolean;
  shouldSend?: boolean;
  error?: string;
  reason?: NominationVideoWhatsAppFailReason;
  plan?: EligibleNominationVideoWhatsApp;
};

const retryFromStatusesForPhone = (phone: string) =>
  isWhatsAppTestRecipient(phone)
    ? ["failed", "retry_exhausted", "submitted", "sent", "delivered", "read"]
    : ["failed", "retry_exhausted", "submitted", "sent"];

const queuedEventFields = (
  plan: EligibleNominationVideoWhatsApp,
  opts: { source: "api" | "admin_manual"; campaignId?: string | null }
) => ({
  phone: plan.teacherPhone,
  messageKind: plan.whatsappKind,
  templateIdEnvKey: plan.templateEnvKey,
  templateId: plan.templateId,
  nominationId: plan.nominationId,
  nominationVideoId: plan.nominationVideoId,
  nominationKind: plan.nominationKind,
  teacherName: plan.teacherName,
  videoUrl: plan.videoUrl,
  headerVideoUrl: plan.videoUrl,
  retryEligible: false,
  errorMessage: null,
  sendErrorCode: null,
  webhookErrorCode: null,
  webhookErrorReason: null,
  failedAt: null,
  sentAt: null,
  deliveredAt: null,
  readAt: null,
  gupshupMessageId: null,
  gupshupInternalMessageId: null,
  whatsappWaMessageId: null,
  providerAcceptedAt: null,
  providerPayloadSnippet: null,
  source: opts.source,
  campaignId: opts.campaignId || null,
  updatedAt: new Date(),
});

export const enqueueNominationVideoWhatsApp = async (opts: {
  nominationId?: string;
  nominationVideoId?: string;
  allowRetry?: boolean;
  source?: "api" | "admin_manual";
  campaignId?: string | null;
}): Promise<EnqueueNominationVideoWhatsAppResult> => {
  const loaded = await loadEligibleNominationVideoWhatsApp(opts);
  if (!loaded.ok) {
    return {
      ok: false,
      eventId: null,
      retryGroupId: null,
      status: "failed",
      reason: loaded.reason,
      error: loaded.reason,
    };
  }
  const plan = loaded.value;
  logNominationVideoWhatsAppPlan(plan);

  const optedOut = await WhatsAppOptOut.exists({ phone: plan.teacherPhone });
  if (optedOut) {
    return {
      ok: false,
      eventId: null,
      retryGroupId: null,
      status: "failed",
      reason: "opted_out",
      error: "Recipient opted out (STOP)",
      plan,
    };
  }

  const existing =
    (await findTeacherKindWhatsAppEvent(plan.teacherPhone, plan.nominationKind)) ||
    (await WhatsAppMessageEvent.findOne({ nominationVideoId: plan.nominationVideoId }));
  const decision = existingVideoDeliveryDecision(existing, Boolean(opts.allowRetry), {
    teacherPhone: plan.teacherPhone,
  });
  if (decision === "duplicate") {
    return {
      ok: false,
      eventId: existing ? String(existing._id) : null,
      retryGroupId: existing?.retryGroupId ? String(existing.retryGroupId) : null,
      status: String(existing?.status || "queued"),
      duplicate: true,
      shouldSend: false,
      reason: "duplicate_teacher_kind",
      error: "Already queued/sent for this teacher and nomination type.",
      plan,
    };
  }

  const source = opts.source || "admin_manual";

  if (decision === "retry" && existing) {
    const updated = await WhatsAppMessageEvent.updateOne(
      { _id: existing._id, status: { $in: retryFromStatusesForPhone(plan.teacherPhone) } },
      {
        $set: {
          status: "queued",
          ...queuedEventFields(plan, { source, campaignId: opts.campaignId }),
        },
        $inc: { retryCount: 1 },
      }
    );
    if (!updated.matchedCount) {
      return {
        ok: false,
        eventId: String(existing._id),
        retryGroupId: existing.retryGroupId ? String(existing.retryGroupId) : null,
        status: String(existing.status || "queued"),
        duplicate: true,
        shouldSend: false,
        reason: "duplicate_teacher_kind",
        error: "Already queued/sent for this teacher and nomination type.",
        plan,
      };
    }
    return {
      ok: true,
      eventId: String(existing._id),
      retryGroupId: existing.retryGroupId ? String(existing.retryGroupId) : null,
      status: "queued",
      shouldSend: true,
      plan,
    };
  }

  const group = await WhatsAppRetryGroup.create({
    messageKind: plan.whatsappKind,
    trigger: source,
    status: "closed_no_more_retries",
    nextPromotionDueAt: null,
  });

  try {
    const event = await WhatsAppMessageEvent.create({
      retryGroupId: group._id,
      attemptNumber: 1,
      retrySource: "initial",
      params: [],
      retryCount: 0,
      status: "queued",
      ...queuedEventFields(plan, { source, campaignId: opts.campaignId }),
    });
    return {
      ok: true,
      eventId: String(event._id),
      retryGroupId: String(group._id),
      status: "queued",
      shouldSend: true,
      plan,
    };
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? (err as { code?: number }).code : undefined;
    if (code === 11000) {
      const raced = await WhatsAppMessageEvent.findOne({
        $or: [
          { phone: plan.teacherPhone, nominationKind: plan.nominationKind },
          { nominationVideoId: plan.nominationVideoId },
        ],
      }).lean();
      return {
        ok: false,
        eventId: raced ? String(raced._id) : null,
        retryGroupId: raced?.retryGroupId ? String(raced.retryGroupId) : null,
        status: String(raced?.status || "queued"),
        duplicate: true,
        shouldSend: false,
        reason: "duplicate_teacher_kind",
        error: "Already queued/sent for this teacher and nomination type.",
        plan,
      };
    }
    throw err;
  }
};

export type ProcessNominationVideoWhatsAppResult = {
  ok: boolean;
  eventId: string | null;
  status: string;
  gupshupMessageId: string | null;
  duplicate?: boolean;
  error?: string;
  reason?: NominationVideoWhatsAppFailReason;
  plan?: EligibleNominationVideoWhatsApp;
};

export const processNominationVideoWhatsAppDelivery = async (
  eventId: string
): Promise<ProcessNominationVideoWhatsAppResult> => {
  if (!Types.ObjectId.isValid(eventId)) {
    return { ok: false, eventId: null, status: "failed", gupshupMessageId: null, error: "invalid_event" };
  }

  const event = await WhatsAppMessageEvent.findById(eventId);
  if (!event) {
    return { ok: false, eventId: null, status: "failed", gupshupMessageId: null, error: "event_not_found" };
  }
  if (!isNominationVideoWhatsAppKind(event.messageKind)) {
    return {
      ok: false,
      eventId: String(event._id),
      status: String(event.status),
      gupshupMessageId: event.gupshupMessageId || null,
      error: "not_nomination_video_kind",
    };
  }
  if (isActiveVideoWhatsAppStatus(event.status) && event.status !== "queued") {
    return {
      ok: false,
      eventId: String(event._id),
      status: String(event.status),
      gupshupMessageId: event.gupshupMessageId || null,
      duplicate: true,
      reason: "duplicate_active_send",
      error: "duplicate_active_send",
    };
  }
  if (String(event.status) !== "queued") {
    return {
      ok: false,
      eventId: String(event._id),
      status: String(event.status),
      gupshupMessageId: event.gupshupMessageId || null,
      error: "not_queued",
    };
  }

  const loaded = await loadEligibleNominationVideoWhatsApp({
    nominationId: event.nominationId || undefined,
    nominationVideoId: event.nominationVideoId || undefined,
  });
  if (!loaded.ok) {
    await WhatsAppMessageEvent.updateOne(
      { _id: event._id },
      {
        $set: {
          status: "failed",
          failedAt: new Date(),
          errorMessage: loaded.reason,
          retryEligible: false,
          updatedAt: new Date(),
        },
      }
    );
    return {
      ok: false,
      eventId: String(event._id),
      status: "failed",
      gupshupMessageId: null,
      reason: loaded.reason,
      error: loaded.reason,
    };
  }

  const plan = loaded.value;
  if (plan.teacherPhone !== event.phone) {
    await WhatsAppMessageEvent.updateOne(
      { _id: event._id },
      {
        $set: {
          status: "failed",
          failedAt: new Date(),
          errorMessage: "invalid_destination",
          retryEligible: false,
          updatedAt: new Date(),
        },
      }
    );
    return {
      ok: false,
      eventId: String(event._id),
      status: "failed",
      gupshupMessageId: null,
      reason: "invalid_destination",
      error: "Teacher phone on the delivery record does not match the nomination teacher phone",
      plan,
    };
  }

  logNominationVideoWhatsAppPlan(plan);

  const result = await sendTemplateMessage(plan.teacherPhone, plan.templateId, [], {
    headerVideoUrl: plan.videoUrl,
    templateEnvKey: plan.templateEnvKey,
  });

  if (result.success && result.ids.canonicalMessageId) {
    const canonical = result.ids.canonicalMessageId;
    await WhatsAppMessageEvent.updateOne(
      { _id: event._id },
      {
        $set: {
          status: "submitted",
          gupshupMessageId: canonical,
          gupshupInternalMessageId: result.ids.gupshupInternalMessageId,
          whatsappWaMessageId: result.ids.whatsappWaMessageId,
          providerAcceptedAt: new Date(),
          providerPayloadSnippet: snippet(result.data),
          phone: plan.teacherPhone,
          templateId: plan.templateId,
          templateIdEnvKey: plan.templateEnvKey,
          videoUrl: plan.videoUrl,
          headerVideoUrl: plan.videoUrl,
          retryEligible: false,
          sentAt: new Date(),
          errorMessage: null,
          updatedAt: new Date(),
        },
      }
    );
    return {
      ok: true,
      eventId: String(event._id),
      status: "submitted",
      gupshupMessageId: canonical,
      plan,
    };
  }

  await WhatsAppMessageEvent.updateOne(
    { _id: event._id },
    {
      $set: {
        status: "failed",
        failedAt: new Date(),
        errorMessage: String(result.error || "Gupshup send failed").slice(0, 2000),
        sendErrorCode: result.httpStatus ? String(result.httpStatus) : null,
        providerPayloadSnippet: snippet(result.data),
        retryEligible: false,
        updatedAt: new Date(),
      },
    }
  );
  return {
    ok: false,
    eventId: String(event._id),
    status: "failed",
    gupshupMessageId: result.ids.canonicalMessageId,
    error: result.error || "Gupshup send failed",
    plan,
  };
};

export const queueNominationVideoWhatsAppJob = (eventId: string) => {
  queueNominationVideoWhatsAppJobs([eventId]);
};

const VIDEO_SEND_CONCURRENCY = 2;
const pendingVideoSendIds: string[] = [];
let videoSendActive = 0;

export const queueNominationVideoWhatsAppJobs = (eventIds: string[]) => {
  for (const id of eventIds) {
    const value = String(id || "").trim();
    if (value && !pendingVideoSendIds.includes(value)) pendingVideoSendIds.push(value);
  }
  pumpVideoSendQueue();
};

export const findQueuedNominationVideoWhatsAppEventId = async (nominationVideoId: string) => {
  const event = await WhatsAppMessageEvent.findOne({
    nominationVideoId: text(nominationVideoId),
    status: "queued",
    messageKind: { $in: NOMINATION_VIDEO_WHATSAPP_KINDS },
    gupshupMessageId: null,
  })
    .select("_id")
    .lean();
  return event ? String(event._id) : null;
};

const queuedVideoWhatsAppQuery = (eventIds?: string[]) => {
  const ids = (eventIds || []).map((id) => String(id || "").trim()).filter((id) => Types.ObjectId.isValid(id));
  return {
    status: "queued" as const,
    messageKind: { $in: NOMINATION_VIDEO_WHATSAPP_KINDS },
    gupshupMessageId: null,
    ...(ids.length ? { _id: { $in: ids } } : {}),
  };
};

const VIDEO_DRAIN_LIMIT = process.env.VERCEL ? 40 : 400;
const VIDEO_DRAIN_CONCURRENCY = process.env.VERCEL ? 4 : VIDEO_SEND_CONCURRENCY;

export const drainQueuedNominationVideoWhatsAppJobs = async (eventIds?: string[], limit = VIDEO_DRAIN_LIMIT) => {
  const docs = await WhatsAppMessageEvent.find(queuedVideoWhatsAppQuery(eventIds))
    .select("_id")
    .sort({ createdAt: 1 })
    .limit(Math.max(1, limit))
    .lean();
  const queuedIds = docs.map((doc) => String(doc._id));
  let submitted = 0;
  let failed = 0;
  console.log(`[WhatsApp] draining ${queuedIds.length} queued nomination video message(s)`);
  for (let i = 0; i < queuedIds.length; i += VIDEO_DRAIN_CONCURRENCY) {
    const chunk = queuedIds.slice(i, i + VIDEO_DRAIN_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (eventId) => {
        try {
          return await processNominationVideoWhatsAppDelivery(eventId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[WhatsApp] nomination video drain failed", message);
          await markQueuedEventFailed(eventId, message).catch(() => undefined);
          return { ok: false, status: "failed" as const };
        }
      })
    );
    for (const result of results) {
      if (result.ok || result.status === "submitted") submitted += 1;
      else failed += 1;
    }
  }
  const remaining = await WhatsAppMessageEvent.countDocuments(queuedVideoWhatsAppQuery(eventIds));
  return { resumed: queuedIds.length, submitted, failed, remaining };
};

const VIDEO_RETRY_CAP = 16;
const OUTSTANDING_VIDEO_STATUSES = ["failed", "retry_exhausted", "submitted", "sent"] as const;
const NON_RETRYABLE_VIDEO_FAIL =
  /opted_out|Recipient opted out|missing_teacher_phone|invalid_destination|invalid_video_url|video_not_generated|video_category_mismatch|review_blocked|nomination_not_found|nomination_draft|after_session_excluded|template_id_missing|not whatsapp|no whatsapp|not.*registered|blocked|blacklist|unregistered|ecosystem engagement|healthy ecosystem|re-engagement|131047|131048|131049/i;

const isNonRetryableVideoFailure = (doc: {
  errorMessage?: string | null;
  webhookErrorReason?: string | null;
  webhookErrorCode?: string | null;
  sendErrorCode?: string | null;
}) => {
  const hay = [doc.errorMessage, doc.webhookErrorReason, doc.webhookErrorCode, doc.sendErrorCode]
    .filter(Boolean)
    .join(" | ");
  if (hay && NON_RETRYABLE_VIDEO_FAIL.test(hay)) return true;
  return isMetaPermanentProviderError({
    errorCode: doc.webhookErrorCode || doc.sendErrorCode,
    errorMessage: doc.errorMessage || doc.webhookErrorReason,
  });
};

const outstandingVideoRetryQuery = () => {
  const staleBefore = new Date(Date.now() - 30 * 60 * 1000);
  return {
    messageKind: { $in: NOMINATION_VIDEO_WHATSAPP_KINDS },
    retryCount: { $lt: VIDEO_RETRY_CAP },
    retryExclusionReason: { $nin: [RETRY_EXCLUSION_REASON.permanentFailure] },
    $or: [
      { status: { $in: ["failed", "retry_exhausted"] } },
      {
        status: { $in: ["submitted", "sent"] },
        $or: [
          { providerAcceptedAt: { $lte: staleBefore } },
          { providerAcceptedAt: null, updatedAt: { $lte: staleBefore } },
        ],
      },
    ],
  };
};

export const retryFailedNominationVideoWhatsAppJobs = async (limit = VIDEO_DRAIN_LIMIT) => {
  const docs = await WhatsAppMessageEvent.find(outstandingVideoRetryQuery())
    .select("_id nominationVideoId nominationId errorMessage webhookErrorReason webhookErrorCode sendErrorCode retryCount")
    .sort({ failedAt: 1, updatedAt: 1, createdAt: 1 })
    .limit(Math.max(40, limit * 3))
    .lean();

  const nonRetryable = docs.filter((doc) => isNonRetryableVideoFailure(doc));
  if (nonRetryable.length) {
    await WhatsAppMessageEvent.updateMany(
      { _id: { $in: nonRetryable.map((doc) => doc._id) } },
      {
        $set: {
          retryCount: VIDEO_RETRY_CAP,
          retryExclusionReason: RETRY_EXCLUSION_REASON.permanentFailure,
          retryExclusionAt: new Date(),
          updatedAt: new Date(),
        },
      }
    );
  }
  const retryable = docs.filter((doc) => !isNonRetryableVideoFailure(doc)).slice(0, Math.max(1, limit));
  let requeued = 0;
  let skipped = nonRetryable.length;
  const eventIds: string[] = [];
  for (const doc of retryable) {
    const result = await enqueueNominationVideoWhatsApp({
      nominationVideoId: String(doc.nominationVideoId || ""),
      nominationId: String(doc.nominationId || ""),
      allowRetry: true,
      source: "admin_manual",
    });
    if (result.ok && result.shouldSend && result.eventId) {
      requeued += 1;
      eventIds.push(result.eventId);
    } else {
      skipped += 1;
      if (!result.duplicate) {
        await WhatsAppMessageEvent.updateOne(
          { _id: doc._id },
          {
            $set: {
              retryCount: VIDEO_RETRY_CAP,
              retryExclusionReason: RETRY_EXCLUSION_REASON.permanentFailure,
              retryExclusionAt: new Date(),
              errorMessage: (result.error || doc.errorMessage || "not_retryable").toString().slice(0, 2000),
              updatedAt: new Date(),
            },
          }
        );
      }
    }
  }
  const drained = eventIds.length
    ? await drainQueuedNominationVideoWhatsAppJobs(eventIds)
    : { resumed: 0, submitted: 0, failed: 0, remaining: 0 };
  const remainingFailed = await WhatsAppMessageEvent.countDocuments(outstandingVideoRetryQuery());
  return { requeued, skipped, ...drained, remainingFailed };
};

export const resumeQueuedNominationVideoWhatsAppJobs = async (eventIds?: string[]) => {
  // Vercel has no durable in-memory queue. Startup resume is a no-op; cron/admin drain instead.
  if (process.env.VERCEL) return 0;
  const docs = await WhatsAppMessageEvent.find(queuedVideoWhatsAppQuery(eventIds)).select("_id").lean();
  const queuedIds = docs.map((doc) => String(doc._id));
  if (!queuedIds.length) return 0;
  console.log(`[WhatsApp] resuming ${queuedIds.length} queued nomination video message(s)`);
  queueNominationVideoWhatsAppJobs(queuedIds);
  return queuedIds.length;
};

const markQueuedEventFailed = async (eventId: string, error: string) => {
  if (!Types.ObjectId.isValid(eventId)) return;
  await WhatsAppMessageEvent.updateOne(
    { _id: eventId, status: "queued" },
    {
      $set: {
        status: "failed",
        failedAt: new Date(),
        errorMessage: error.slice(0, 2000),
        retryEligible: false,
        updatedAt: new Date(),
      },
    }
  );
};

const pumpVideoSendQueue = () => {
  while (videoSendActive < VIDEO_SEND_CONCURRENCY && pendingVideoSendIds.length) {
    const eventId = pendingVideoSendIds.shift();
    if (!eventId) break;
    videoSendActive += 1;
    void processNominationVideoWhatsAppDelivery(eventId)
      .catch(async (err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[WhatsApp] nomination video job failed", message);
        await markQueuedEventFailed(eventId, message).catch(() => undefined);
      })
      .finally(() => {
        videoSendActive -= 1;
        pumpVideoSendQueue();
      });
  }
};

export type BulkEnqueueNominationVideoWhatsAppResult = {
  campaignId: string;
  queued: number;
  skipped: number;
  eventIds: string[];
  dryRun?: boolean;
  wouldCreate?: number;
  wouldRetry?: number;
};

export const bulkEnqueueNominationVideoWhatsApp = async (opts: {
  nominationVideoIds: string[];
  allowRetry?: boolean;
  source?: "api" | "admin_manual";
  campaignId?: string;
  dryRun?: boolean;
}): Promise<BulkEnqueueNominationVideoWhatsAppResult> => {
  const campaignId = text(opts.campaignId) || randomUUID();
  const source = opts.source || "admin_manual";
  const ids = [...new Set(opts.nominationVideoIds.map((id) => text(id)).filter(Boolean))].slice(0, 8000);
  const empty = { campaignId, queued: 0, skipped: 0, eventIds: [] as string[] };
  if (!ids.length) return empty;

  const videos = await NominationVideo.find({ _id: { $in: ids } }).lean();
  const videoById = new Map(videos.map((video) => [String(video._id), video]));
  const nomIds = [...new Set(videos.map((video) => String(video.nomination_id || "")).filter(Boolean))];
  const noms = nomIds.length ? await Nomination.find({ _id: { $in: nomIds } }).lean() : [];
  const nomById = new Map(noms.map((nom) => [String(nom._id), nom]));

  const plans: EligibleNominationVideoWhatsApp[] = [];
  const seenKeys = new Set<string>();
  let skipped = 0;

  for (const id of ids) {
    const video = videoById.get(id) || null;
    const nom = video ? nomById.get(String(video.nomination_id || "")) || null : null;
    const loaded = evaluateNominationVideoWhatsAppFromDocs({
      nomination: nom as Parameters<typeof evaluateNominationVideoWhatsAppFromDocs>[0]["nomination"],
      video: video as Parameters<typeof evaluateNominationVideoWhatsAppFromDocs>[0]["video"],
    });
    if (!loaded.ok) {
      skipped += 1;
      continue;
    }
    const key = teacherKindKey(loaded.value.teacherPhone, loaded.value.nominationKind);
    if (seenKeys.has(key)) {
      skipped += 1;
      continue;
    }
    seenKeys.add(key);
    plans.push(loaded.value);
  }

  const phones = [...new Set(plans.map((plan) => plan.teacherPhone))];
  const [optOuts, existingEvents] = phones.length
    ? await Promise.all([
        WhatsAppOptOut.find({ phone: { $in: phones } }).select("phone").lean(),
        WhatsAppMessageEvent.find({
          phone: { $in: phones },
          nominationKind: { $in: ["student", "teacher", "colleague"] },
        }).lean(),
      ])
    : [[], []];
  const optedOut = new Set(optOuts.map((row) => String(row.phone)));
  const existingByKey = new Map<string, (typeof existingEvents)[number]>(
    existingEvents.map((row) => [`${row.phone}:${row.nominationKind}`, row])
  );
  const existingByVideo = new Map(
    existingEvents
      .filter((row) => row.nominationVideoId)
      .map((row) => [String(row.nominationVideoId), row] as const)
  );

  const toCreate: EligibleNominationVideoWhatsApp[] = [];
  const toRetry: Array<{ plan: EligibleNominationVideoWhatsApp; existingId: unknown }> = [];

  for (const plan of plans) {
    if (optedOut.has(plan.teacherPhone)) {
      skipped += 1;
      continue;
    }
    const existing =
      existingByKey.get(teacherKindKey(plan.teacherPhone, plan.nominationKind)) ||
      existingByVideo.get(plan.nominationVideoId);
    const decision = existingVideoDeliveryDecision(existing, Boolean(opts.allowRetry), {
      teacherPhone: plan.teacherPhone,
    });
    if (decision === "duplicate") {
      skipped += 1;
      continue;
    }
    if (decision === "retry" && existing?._id) {
      toRetry.push({ plan, existingId: existing._id });
      continue;
    }
    toCreate.push(plan);
  }

  if (opts.dryRun) {
    return {
      campaignId,
      queued: toCreate.length + toRetry.length,
      skipped,
      eventIds: [],
      dryRun: true,
      wouldCreate: toCreate.length,
      wouldRetry: toRetry.length,
    };
  }

  if (!toCreate.length && !toRetry.length) {
    return { campaignId, queued: 0, skipped, eventIds: [] };
  }

  const group = await WhatsAppRetryGroup.create({
    messageKind: "teacher_video_campaign",
    trigger: source,
    status: "closed_no_more_retries",
    nextPromotionDueAt: null,
  });

  const now = new Date();
  const docs = toCreate.map((plan) => ({
    retryGroupId: group._id,
    attemptNumber: 1,
    retrySource: "initial" as const,
    params: [] as string[],
    retryCount: 0,
    status: "queued" as const,
    createdAt: now,
    ...queuedEventFields(plan, { source, campaignId }),
  }));

  for (let i = 0; i < docs.length; i += 250) {
    try {
      await WhatsAppMessageEvent.insertMany(docs.slice(i, i + 250), { ordered: false });
    } catch {
      // Unique races are recovered below by reading campaignId.
    }
  }

  if (toRetry.length) {
    await WhatsAppMessageEvent.bulkWrite(
      toRetry.map(({ plan, existingId }) => ({
        updateOne: {
          filter: { _id: existingId, status: { $in: retryFromStatusesForPhone(plan.teacherPhone) } },
          update: {
            $set: {
              status: "queued",
              retryGroupId: group._id,
              ...queuedEventFields(plan, { source, campaignId }),
            },
            $inc: { retryCount: 1 },
          },
        },
      })),
      { ordered: false }
    );
  }

  const queuedDocs = await WhatsAppMessageEvent.find({ campaignId, status: "queued" }).select("_id").lean();
  const eventIds = queuedDocs.map((doc) => String(doc._id));
  queueNominationVideoWhatsAppJobs(eventIds);
  return {
    campaignId,
    queued: eventIds.length,
    skipped: Math.max(skipped, ids.length - eventIds.length),
    eventIds,
  };
};

/** Enqueue + process exactly one nomination video. Never scans other nominations. */
export const sendOneNominationVideoWhatsApp = async (opts: {
  nominationId?: string;
  nominationVideoId?: string;
  allowRetry?: boolean;
  source?: "api" | "admin_manual";
}): Promise<ProcessNominationVideoWhatsAppResult & { queuedEventId?: string | null }> => {
  const queued = await enqueueNominationVideoWhatsApp(opts);
  if (!queued.ok || !queued.eventId || !queued.shouldSend) {
    return {
      ok: false,
      eventId: queued.eventId,
      status: queued.status,
      gupshupMessageId: null,
      duplicate: queued.duplicate,
      error: queued.error,
      reason: queued.reason,
      plan: queued.plan,
      queuedEventId: queued.eventId,
    };
  }
  const processed = await processNominationVideoWhatsAppDelivery(queued.eventId);
  return { ...processed, queuedEventId: queued.eventId };
};
