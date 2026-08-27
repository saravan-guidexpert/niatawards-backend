const GUPSHUP_TEMPLATE_URL = "https://api.gupshup.io/wa/api/v1/template/msg";

export const toPhone10 = (phone: string) => String(phone ?? "").replace(/\D/g, "").slice(-10);

export const formatPhoneE16491 = (phone: string) => `91${toPhone10(phone)}`;

export const maskPhone = (phone: string) => {
  const digits = toPhone10(phone);
  if (digits.length < 4) return "****";
  return `****${digits.slice(-4)}`;
};

export const isWhatsAppEnabled = () => {
  const v = process.env.ENABLE_WHATSAPP;
  if (v == null || String(v).trim() === "") return false;
  const lower = String(v).toLowerCase().trim();
  return !["0", "false", "no", "off"].includes(lower);
};

export const isGupshupOutboundConfigured = () => {
  const apiKey = process.env.GUPSHUP_API_KEY?.trim();
  const source = String(process.env.GUPSHUP_SOURCE ?? "").replace(/\D/g, "");
  return Boolean(apiKey) && source.length >= 10;
};

export const isGupshupConfigured = () => isWhatsAppEnabled() && isGupshupOutboundConfigured();

const kindSlug = (kind: string) =>
  String(kind || "generic")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "") || "GENERIC";

export const templateEnvKeyForKind = (kind: string) => `GUPSHUP_TEMPLATE_${kindSlug(kind)}`;

export const templateIdForKind = (kind: string) => {
  const key = templateEnvKeyForKind(kind);
  const value = process.env[key]?.trim();
  return value || null;
};

export const listedConfiguredTemplateEnvKeys = () =>
  Object.keys(process.env)
    .filter((key) => key.startsWith("GUPSHUP_TEMPLATE_") && Boolean(process.env[key]?.trim()))
    .sort();

export const WHATSAPP_ENV_HINT_KEYS = [
  "ENABLE_WHATSAPP",
  "GUPSHUP_API_KEY",
  "GUPSHUP_SOURCE",
  "GUPSHUP_SRC_NAME",
  "GUPSHUP_WEBHOOK_SECRET",
  "GUPSHUP_WEBHOOK_AUTH_REQUIRED",
  "GUPSHUP_TEMPLATE_TEACHER_SUBMIT",
] as const;

export const listedWhatsAppEnvHints = () => {
  const keys = [...WHATSAPP_ENV_HINT_KEYS, ...listedConfiguredTemplateEnvKeys()];
  const extra = Object.keys(process.env).filter(
    (key) => key.startsWith("GUPSHUP_TEMPLATE_") && !keys.includes(key)
  );
  return [...new Set([...keys, ...extra])].map((key) => ({
    key,
    configured: Boolean(process.env[key]?.trim()),
  }));
};

const asRecord = (body: unknown) =>
  body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

const trimStr = (value: unknown) => {
  if (value == null) return "";
  const s = String(value).trim();
  return s;
};

const isLikelyGupshupInternalId = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);

const isLikelyWaMessageId = (s: string) => {
  if (!s) return false;
  return s.startsWith("wamid.") || s.startsWith("gBEG") || s.startsWith("ABEG");
};

const collectIdCandidates = (data: unknown): string[] => {
  if (!data || typeof data !== "object") return [];
  const rec = asRecord(data);
  const keys = ["messageId", "message_id", "id", "msgId", "gsId", "gs_id", "requestId", "request_id"];
  const out: string[] = [];
  for (const key of keys) {
    const t = trimStr(rec[key]);
    if (t) out.push(t);
  }
  for (const value of Object.values(rec)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const inner = asRecord(value);
      for (const key of keys) {
        const t = trimStr(inner[key]);
        if (t) out.push(t);
      }
    }
  }
  return [...new Set(out)];
};

export const parseGupshupTemplateSendResponse = (data: unknown) => {
  const candidates = collectIdCandidates(data);
  let internal: string | null = null;
  let wa: string | null = null;
  for (const c of candidates) {
    if (!internal && isLikelyGupshupInternalId(c)) internal = c;
    if (!wa && isLikelyWaMessageId(c)) wa = c;
  }
  const canonical = internal || wa || candidates[0] || null;
  return {
    gupshupInternalMessageId: internal,
    whatsappWaMessageId: wa,
    canonicalMessageId: canonical,
  };
};

export type GupshupSendResult = {
  success: boolean;
  error?: string;
  data?: unknown;
  httpStatus?: number | null;
  ids: {
    gupshupInternalMessageId: string | null;
    whatsappWaMessageId: string | null;
    canonicalMessageId: string | null;
  };
};

const snippet = (data: unknown) => {
  try {
    return JSON.stringify(data).slice(0, 1200);
  } catch {
    return String(data).slice(0, 1200);
  }
};

export const sendTemplateMessage = async (
  phone: string,
  templateId: string,
  params: string[] = [],
  opts: { headerImageUrl?: string | null; templateEnvKey?: string | null } = {}
): Promise<GupshupSendResult> => {
  const emptyIds = {
    gupshupInternalMessageId: null,
    whatsappWaMessageId: null,
    canonicalMessageId: null,
  };

  if (!isWhatsAppEnabled()) {
    return { success: false, error: "WhatsApp disabled (ENABLE_WHATSAPP)", ids: emptyIds };
  }

  const apiKey = process.env.GUPSHUP_API_KEY?.trim();
  const source = String(process.env.GUPSHUP_SOURCE ?? "").replace(/\D/g, "");
  if (!apiKey || source.length < 10) {
    return { success: false, error: "Gupshup not configured", ids: emptyIds };
  }
  if (!templateId) {
    return { success: false, error: "template id missing", ids: emptyIds };
  }

  const destination = formatPhoneE16491(phone);
  const body = new URLSearchParams();
  body.append("source", source);
  body.append("destination", destination);
  body.append("channel", "whatsapp");
  body.append("template", JSON.stringify({ id: templateId, params: params.map((p) => String(p)) }));
  if (opts.headerImageUrl?.trim()) {
    body.append("message", JSON.stringify({ type: "image", image: { link: opts.headerImageUrl.trim() } }));
  }
  if (process.env.GUPSHUP_SRC_NAME?.trim()) {
    body.append("src.name", process.env.GUPSHUP_SRC_NAME.trim());
  }

  console.log(
    JSON.stringify({
      event: "gupshup_template_send",
      mask: maskPhone(phone),
      templateEnvKey: opts.templateEnvKey || null,
      templateId,
      paramCount: params.length,
    })
  );

  let res: Response;
  try {
    res = await fetch(GUPSHUP_TEMPLATE_URL, {
      method: "POST",
      headers: {
        apikey: apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Gupshup request failed";
    console.error("[Gupshup] Template send exception", maskPhone(phone), message);
    return { success: false, error: message, ids: emptyIds, httpStatus: null };
  }

  const raw = (await res.text()).trim();
  let data: unknown = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { message: raw };
  }

  const ids = parseGupshupTemplateSendResponse(data);
  const rec = asRecord(data);
  const errMsg = String(rec.message || rec.error || "").trim() || `HTTP ${res.status}`;

  if (res.status >= 400 || String(rec.status).toLowerCase() === "error" || rec.success === false) {
    if (ids.canonicalMessageId) {
      console.warn("[Gupshup] Template HTTP error but message id present", maskPhone(phone), errMsg);
      return { success: true, data, ids, httpStatus: res.status };
    }
    console.error("[Gupshup] Template send failed", maskPhone(phone), errMsg, snippet(data));
    return { success: false, error: errMsg, data, ids, httpStatus: res.status };
  }

  console.log("[Gupshup] Template submitted", maskPhone(phone), templateId);
  return { success: true, data, ids, httpStatus: res.status };
};
