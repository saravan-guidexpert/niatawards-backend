/**
 * Teacher Video Messaging: NominationVideo is the source of truth.
 * AfterSessionNomination is never queried. No automatic sending.
 */
import { Nomination } from "../models/Nomination";
import { NominationVideo } from "../models/NominationVideo";
import { WhatsAppMessageEvent } from "../models/WhatsAppMessageEvent";
import {
  TEACHER_COLLEAGUE_EDUCATION,
  nominationKind,
  photoStateOf,
  teacherDisplayName,
  usableTeacherPhone,
  type NominationKind,
} from "./nominationKind";

export const MESSAGING_KIND_LABEL: Record<NominationKind, string> = {
  student: "Student Nominated Teacher",
  teacher: "Teacher Nominated Teacher",
  colleague: "Teacher Nominated Other Teacher",
};
import { videoProductionValid } from "./videoIdentity";
import {
  bulkEnqueueNominationVideoWhatsApp,
  teacherKindKey,
  templateEnvKeyForNominationKind,
  VIDEO_MESSAGING_TEST_PHONE,
} from "./nominationVideoWhatsApp";

export { VIDEO_MESSAGING_TEST_PHONE };
export const MAX_BULK_IDS = 8000;

export type MessagingRowStatus =
  | "ready"
  | "queued"
  | "submitted"
  | "sent"
  | "delivered"
  | "read"
  | "failed";

const ACTIVE = new Set(["queued", "submitted", "sent", "delivered", "read"]);

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const text = (value: unknown) => String(value ?? "").trim();

export const messagingStatusOf = (deliveryStatus: unknown): MessagingRowStatus => {
  const status = String(deliveryStatus || "").trim();
  if (!status) return "ready";
  if (status === "queued") return "queued";
  if (status === "submitted") return "submitted";
  if (status === "sent") return "sent";
  if (status === "delivered") return "delivered";
  if (status === "read") return "read";
  if (status === "failed" || status === "retry_exhausted") return "failed";
  return "ready";
};

const photoStateFromVideo = (video: { photo_used?: unknown; video_category?: unknown }) =>
  video.photo_used === true || String(video.video_category || "") === "with_photo"
    ? "with_photo"
    : "without_photo";

const blockedReview = (reviewStatus: unknown, readyForMessage: unknown) => {
  const status = String(reviewStatus || "");
  if ((status === "rejected" || status === "regeneration_required") && readyForMessage !== true) {
    return true;
  }
  return false;
};

type ListOpts = {
  kind?: NominationKind | "";
  photo?: "with_photo" | "without_photo" | "";
  status?: MessagingRowStatus | "";
  q?: string;
  testOnly?: boolean;
  page?: number;
  limit?: number;
};

const kindMatch = (kind?: string) => {
  if (kind === "teacher") return { "nom.type": "teacher" };
  if (kind === "colleague") {
    return { "nom.type": "student", "nom.student_class": TEACHER_COLLEAGUE_EDUCATION };
  }
  if (kind === "student") {
    return {
      "nom.type": "student",
      "nom.student_class": { $ne: TEACHER_COLLEAGUE_EDUCATION },
    };
  }
  return {};
};

const candidatePipeline = (opts: ListOpts) => {
  const matchKind = kindMatch(opts.kind);
  const photoMatch =
    opts.photo === "with_photo"
      ? { $or: [{ photo_used: true }, { video_category: "with_photo" }] }
      : opts.photo === "without_photo"
        ? {
            $and: [
              { photo_used: { $ne: true } },
              { video_category: { $ne: "with_photo" } },
            ],
          }
        : null;

  const reviewMatch = {
    $or: [
      { review_status: { $nin: ["rejected", "regeneration_required"] } },
      { ready_for_message: true },
    ],
  };

  const search = text(opts.q);
  const searchMatch = search
    ? {
        $or: [
          { nomination_id: { $regex: escapeRegex(search), $options: "i" } },
          { _id: { $regex: escapeRegex(search), $options: "i" } },
          { "nom.phone": { $regex: escapeRegex(search) } },
          { "nom.teacher_name": { $regex: escapeRegex(search), $options: "i" } },
          { "nom.full_name": { $regex: escapeRegex(search), $options: "i" } },
          { "nom.nominator_name": { $regex: escapeRegex(search), $options: "i" } },
          { "nom.student_name": { $regex: escapeRegex(search), $options: "i" } },
        ],
      }
    : null;

  return [
    {
      $match: {
        $and: [
          { generation_status: "generated" },
          { video_url: { $regex: /^https:\/\//i } },
          reviewMatch,
        ],
      },
    },
    {
      $lookup: {
        from: Nomination.collection.name,
        localField: "nomination_id",
        foreignField: "_id",
        as: "nom",
      },
    },
    { $unwind: "$nom" },
    {
      $match: {
        $and: [
          { "nom.status": { $ne: "draft" } },
          ...(Object.keys(matchKind).length ? [matchKind] : []),
          ...(searchMatch ? [searchMatch] : []),
        ],
      },
    },
    {
      $addFields: {
        teacherPhone: {
          $substrCP: [
            { $ifNull: ["$nom.phone", ""] },
            { $max: [0, { $subtract: [{ $strLenCP: { $ifNull: ["$nom.phone", ""] } }, 10] }] },
            10,
          ],
        },
        messagingKind: {
          $cond: [
            { $eq: ["$nom.type", "teacher"] },
            "teacher",
            {
              $cond: [
                { $eq: ["$nom.student_class", TEACHER_COLLEAGUE_EDUCATION] },
                "colleague",
                "student",
              ],
            },
          ],
        },
        _prefReady: { $cond: [{ $eq: ["$ready_for_message", true] }, 1, 0] },
        _prefApproved: { $cond: [{ $eq: ["$review_status", "approved"] }, 1, 0] },
      },
    },
    { $match: { teacherPhone: { $regex: /^\d{10}$/ } } },
    {
      $group: {
        _id: { phone: "$teacherPhone", kind: "$messagingKind" },
        doc: {
          $top: {
            sortBy: { _prefReady: -1, _prefApproved: -1, generated_at: -1, _id: -1 },
            output: "$$ROOT",
          },
        },
        videoCount: { $sum: 1 },
      },
    },
    {
      $replaceRoot: {
        newRoot: { $mergeObjects: ["$doc", { videoCount: "$videoCount", teacherPhone: "$_id.phone", messagingKind: "$_id.kind" }] },
      },
    },
    ...(photoMatch ? [{ $match: photoMatch }] : []),
    {
      $lookup: {
        from: WhatsAppMessageEvent.collection.name,
        let: { phone: "$teacherPhone", kind: "$messagingKind" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$phone", "$$phone"] },
                  { $eq: ["$nominationKind", "$$kind"] },
                ],
              },
            },
          },
          { $sort: { updatedAt: -1 } },
          { $limit: 1 },
        ],
        as: "deliveries",
      },
    },
    {
      $addFields: {
        delivery: { $arrayElemAt: ["$deliveries", 0] },
      },
    },
  ];
};

const statusMatchExpr = (status?: string) => {
  if (!status) return {};
  if (status === "ready") {
    return {
      $or: [{ delivery: { $exists: false } }, { delivery: null }, { "delivery.status": { $exists: false } }],
    };
  }
  if (status === "failed") {
    return { "delivery.status": { $in: ["failed", "retry_exhausted"] } };
  }
  if (status === "sent") {
    return { "delivery.status": { $in: ["submitted", "sent"] } };
  }
  return { "delivery.status": status };
};

const aggregateVideos = <T>(pipeline: unknown[]) =>
  NominationVideo.aggregate<T>(pipeline as Parameters<typeof NominationVideo.aggregate>[0], { allowDiskUse: true });

export type TeacherVideoMessageRow = {
  nominationId: string;
  nominationVideoId: string;
  nominationKind: NominationKind;
  nominationTypeLabel: string;
  teacherName: string;
  teacherPhone: string;
  isTest: boolean;
  photoState: "with_photo" | "without_photo";
  nominatorName: string | null;
  videoUrl: string;
  generationStatus: string;
  reviewStatus: string;
  readyForMessage: boolean;
  templateEnvKey: string;
  messageStatus: MessagingRowStatus;
  deliveryId: string | null;
  gupshupMessageId: string | null;
  failureReason: string | null;
  retryCount: number;
  generatedAt: string | null;
  updatedAt: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  canSend: boolean;
  canRetry: boolean;
  videoCount: number;
  messagingKey: string;
};

const toRow = (
  video: Record<string, unknown>,
  nom: Record<string, unknown>,
  delivery?: Record<string, unknown> | null,
  videoCount = 1
): TeacherVideoMessageRow | null => {
  const nominationId = text(nom._id);
  const kind = nominationKind(nom);
  if (!videoProductionValid({
    video,
    nominationId,
    expectedKind: kind,
    expectedPhoto: photoStateOf(nom.photo_url),
  })) {
    return null;
  }
  if (blockedReview(video.review_status, video.ready_for_message)) return null;
  const teacherPhone = usableTeacherPhone(nom.phone);
  const messageStatus = messagingStatusOf(delivery?.status);
  const templateEnvKey = templateEnvKeyForNominationKind(kind);
  return {
    nominationId,
    nominationVideoId: text(video._id),
    nominationKind: kind,
    nominationTypeLabel: MESSAGING_KIND_LABEL[kind],
    teacherName: teacherDisplayName(nom) || "Teacher",
    teacherPhone,
    isTest: teacherPhone === VIDEO_MESSAGING_TEST_PHONE,
    photoState: photoStateFromVideo(video),
    nominatorName: text(nom.student_name) || text(nom.nominator_name) || null,
    videoUrl: text(video.video_url),
    generationStatus: text(video.generation_status),
    reviewStatus: text(video.review_status),
    readyForMessage: video.ready_for_message === true,
    templateEnvKey,
    messageStatus,
    deliveryId: delivery?._id ? String(delivery._id) : null,
    gupshupMessageId: delivery?.gupshupMessageId ? String(delivery.gupshupMessageId) : null,
    failureReason: delivery?.errorMessage ? String(delivery.errorMessage) : null,
    retryCount: Number(delivery?.retryCount || 0),
    generatedAt: video.generated_at ? new Date(String(video.generated_at)).toISOString() : null,
    updatedAt: delivery?.updatedAt
      ? new Date(String(delivery.updatedAt)).toISOString()
      : video.generated_at
        ? new Date(String(video.generated_at)).toISOString()
        : null,
    sentAt: delivery?.sentAt ? new Date(String(delivery.sentAt)).toISOString() : null,
    deliveredAt: delivery?.deliveredAt ? new Date(String(delivery.deliveredAt)).toISOString() : null,
    readAt: delivery?.readAt ? new Date(String(delivery.readAt)).toISOString() : null,
    canSend: Boolean(teacherPhone) && (messageStatus === "ready" || (teacherPhone === VIDEO_MESSAGING_TEST_PHONE && messageStatus !== "queued")),
    canRetry: messageStatus === "failed",
    videoCount: Math.max(1, Number(videoCount) || 1),
    messagingKey: teacherKindKey(teacherPhone, kind),
  };
};

export const listTeacherVideoMessages = async (opts: ListOpts) => {
  const page = Math.max(1, Number(opts.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(opts.limit) || 25));
  const pipeline = [
    ...candidatePipeline(opts),
    ...(opts.testOnly ? [{ $match: { "nom.phone": { $regex: `${VIDEO_MESSAGING_TEST_PHONE}$` } } }] : []),
    { $match: statusMatchExpr(opts.status) },
    { $sort: { generated_at: -1 as const, _id: -1 as const } },
  ];

  const [countRow, docs] = await Promise.all([
    aggregateVideos<{ n: number }>([...pipeline, { $count: "n" }]),
    aggregateVideos([
      ...pipeline,
      { $skip: (page - 1) * limit },
      { $limit: limit * 3 },
    ]),
  ]);

  const rows: TeacherVideoMessageRow[] = [];
  for (const doc of docs) {
    const row = toRow(
      doc as Record<string, unknown>,
      (doc as { nom: Record<string, unknown> }).nom,
      (doc as { delivery?: Record<string, unknown> }).delivery || null,
      Number((doc as { videoCount?: number }).videoCount || 1)
    );
    if (!row) continue;
    if (opts.testOnly && !row.isTest) continue;
    rows.push(row);
    if (rows.length >= limit) break;
  }

  rows.sort((a, b) => Number(b.isTest) - Number(a.isTest) || String(b.generatedAt || "").localeCompare(String(a.generatedAt || "")));

  return {
    page,
    limit,
    total: countRow[0]?.n || 0,
    items: rows,
  };
};

export const listTeacherVideoMessageIds = async (opts: Omit<ListOpts, "page" | "limit">) => {
  const docs = await aggregateVideos([
    ...candidatePipeline(opts),
    ...(opts.testOnly ? [{ $match: { "nom.phone": { $regex: `${VIDEO_MESSAGING_TEST_PHONE}$` } } }] : []),
    { $match: statusMatchExpr(opts.status) },
    { $project: { deliveries: 0 } },
  ]);

  const ids: string[] = [];
  const failedIds: string[] = [];
  const readyIds: string[] = [];
  const recipients = new Set<string>();
  const byKind = { student: 0, teacher: 0, colleague: 0 };
  const byPhoto = { with_photo: 0, without_photo: 0 };
  let testCount = 0;
  for (const doc of docs) {
    const row = toRow(
      doc as Record<string, unknown>,
      (doc as { nom: Record<string, unknown> }).nom,
      (doc as { delivery?: Record<string, unknown> }).delivery || null,
      Number((doc as { videoCount?: number }).videoCount || 1)
    );
    if (!row) continue;
    if (opts.testOnly && !row.isTest) continue;
    ids.push(row.nominationVideoId);
    byKind[row.nominationKind] += 1;
    byPhoto[row.photoState] += 1;
    if (row.teacherPhone) recipients.add(row.teacherPhone);
    if (row.isTest) testCount += 1;
    if (row.canRetry) failedIds.push(row.nominationVideoId);
    if (row.canSend) readyIds.push(row.nominationVideoId);
  }

  const alreadySent = Math.max(0, ids.length - readyIds.length - failedIds.length);
  return {
    total: ids.length,
    ids,
    failedIds,
    readyIds,
    testCount,
    recipientCount: recipients.size,
    alreadySent,
    byKind,
    byPhoto,
    preview: {
      total: ids.length,
      ready: readyIds.length,
      alreadySent,
      failed: failedIds.length,
      invalid: 0,
      duplicate: alreadySent,
      testCount,
      recipientCount: recipients.size,
      byKind,
      byPhoto,
    },
  };
};

export const summarizeTeacherVideoMessages = async (opts: Pick<ListOpts, "kind" | "photo" | "q" | "testOnly">) => {
  const listed = await aggregateVideos<{ _id: string; n: number }>([
    ...candidatePipeline(opts),
    ...(opts.testOnly ? [{ $match: { "nom.phone": { $regex: `${VIDEO_MESSAGING_TEST_PHONE}$` } } }] : []),
    {
      $group: {
        _id: {
          $switch: {
            branches: [
              { case: { $in: ["$delivery.status", ["queued"]] }, then: "queued" },
              { case: { $in: ["$delivery.status", ["submitted"]] }, then: "submitted" },
              { case: { $in: ["$delivery.status", ["sent"]] }, then: "sent" },
              { case: { $in: ["$delivery.status", ["delivered"]] }, then: "delivered" },
              { case: { $in: ["$delivery.status", ["read"]] }, then: "read" },
              { case: { $in: ["$delivery.status", ["failed", "retry_exhausted"]] }, then: "failed" },
            ],
            default: "ready",
          },
        },
        n: { $sum: 1 },
      },
    },
  ]);

  const counts = {
    totalGenerated: 0,
    ready: 0,
    queued: 0,
    submitted: 0,
    sent: 0,
    delivered: 0,
    read: 0,
    failed: 0,
  };
  for (const row of listed) {
    const key = String(row._id || "ready") as keyof typeof counts;
    const n = Number(row.n || 0);
    if (key in counts) counts[key] += n;
    counts.totalGenerated += n;
  }
  return counts;
};

export const previewTeacherVideoQueue = async (nominationVideoIds: string[]) => {
  const ids = [...new Set(nominationVideoIds.map((id) => text(id)).filter(Boolean))].slice(0, MAX_BULK_IDS);
  const videos = await NominationVideo.find({ _id: { $in: ids } }).lean();
  const videoById = new Map(videos.map((video) => [String(video._id), video]));
  const noms = await Nomination.find({ _id: { $in: videos.map((v) => String(v.nomination_id)) } }).lean();
  const nomById = new Map(noms.map((n) => [String(n._id), n]));
  const phones = noms.map((n) => usableTeacherPhone(n.phone)).filter(Boolean);
  const deliveries = phones.length
    ? await WhatsAppMessageEvent.find({
        phone: { $in: phones },
        nominationKind: { $in: ["student", "teacher", "colleague"] },
      }).sort({ updatedAt: -1 }).lean()
    : [];
  const deliveryByKey = new Map<string, (typeof deliveries)[number]>();
  for (const delivery of deliveries) {
    const key = `${delivery.phone}:${delivery.nominationKind}`;
    if (!deliveryByKey.has(key)) deliveryByKey.set(key, delivery);
  }

  const preview = {
    total: ids.length,
    ready: 0,
    alreadyActive: 0,
    failed: 0,
    invalid: 0,
    testCount: 0,
    recipientPhones: new Set<string>(),
    byKind: { student: 0, teacher: 0, colleague: 0 },
    byPhoto: { with_photo: 0, without_photo: 0 },
  };

  const seenKeys = new Set<string>();
  for (const id of ids) {
    const video = videoById.get(id);
    if (!video) {
      preview.invalid += 1;
      continue;
    }
    const nom = nomById.get(String(video.nomination_id));
    const kind = nom ? nominationKind(nom) : "";
    const phone = nom ? usableTeacherPhone(nom.phone) : "";
    const key = `${phone}:${kind}`;
    if (phone && kind && seenKeys.has(key)) continue;
    if (phone && kind) seenKeys.add(key);
    const delivery = deliveryByKey.get(key);
    const row = nom ? toRow(video as Record<string, unknown>, nom as Record<string, unknown>, delivery as Record<string, unknown> | undefined) : null;
    if (!row) {
      preview.invalid += 1;
      continue;
    }
    preview.byKind[row.nominationKind] += 1;
    preview.byPhoto[row.photoState] += 1;
    if (row.isTest) preview.testCount += 1;
    if (row.teacherPhone) preview.recipientPhones.add(row.teacherPhone);
    if (row.canSend) preview.ready += 1;
    else if (row.messageStatus === "failed") preview.failed += 1;
    else if (ACTIVE.has(row.messageStatus)) preview.alreadyActive += 1;
  }

  return {
    total: preview.total,
    ready: preview.ready,
    alreadySent: preview.alreadyActive,
    failed: preview.failed,
    invalid: preview.invalid,
    duplicate: preview.alreadyActive,
    testCount: preview.testCount,
    recipientCount: preview.recipientPhones.size,
    byKind: preview.byKind,
    byPhoto: preview.byPhoto,
  };
};

export const previewTeacherVideoMatching = async (opts: Omit<ListOpts, "page" | "limit">) => {
  const listed = await listTeacherVideoMessageIds(opts);
  return listed.preview;
};

export const queueTeacherVideoMessages = async (nominationVideoIds: string[], allowRetry = false) => {
  const ids = [...new Set(nominationVideoIds.map((id) => text(id)).filter(Boolean))].slice(0, MAX_BULK_IDS);
  const result = await bulkEnqueueNominationVideoWhatsApp({
    nominationVideoIds: ids,
    allowRetry,
    source: "admin_manual",
  });
  return {
    queued: result.queued,
    skipped: result.skipped,
    eventIds: result.eventIds,
    campaignId: result.campaignId,
    results: [] as Array<{
      nominationVideoId: string;
      ok: boolean;
      queued?: boolean;
      duplicate?: boolean;
      status: string;
      eventId: string | null;
      error?: string;
    }>,
  };
};

export const queueTeacherVideoMatching = async (opts: Omit<ListOpts, "page" | "limit">, allowRetry = false) => {
  const listed = await listTeacherVideoMessageIds(opts);
  const ids = allowRetry ? listed.failedIds : listed.readyIds;
  return queueTeacherVideoMessages(ids, allowRetry);
};

export const progressForEventIds = async (eventIds: string[], campaignId?: string) => {
  const empty = { total: 0, queued: 0, submitted: 0, sent: 0, delivered: 0, read: 0, failed: 0, pending: 0 };
  const campaign = text(campaignId);
  const ids = eventIds.filter((id) => /^[a-f0-9]{24}$/i.test(id));
  if (!campaign && !ids.length) return empty;
  const docs = await WhatsAppMessageEvent.find(
    campaign ? { campaignId: campaign } : { _id: { $in: ids } }
  ).select("status").lean();
  const counts = { ...empty, total: docs.length };
  for (const doc of docs) {
    const mapped = messagingStatusOf(doc.status);
    if (mapped === "queued") counts.queued += 1;
    else if (mapped === "submitted") counts.submitted += 1;
    else if (mapped === "sent") counts.sent += 1;
    else if (mapped === "delivered") counts.delivered += 1;
    else if (mapped === "read") counts.read += 1;
    else if (mapped === "failed") counts.failed += 1;
  }
  counts.pending = counts.queued;
  return counts;
};
