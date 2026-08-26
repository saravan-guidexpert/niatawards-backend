import { randomInt, createHmac } from "crypto";
import { OtpVerification } from "../models/OtpVerification";

// The QueryString receiver is the only Karix transport that actually delivers on this
// account. The JSON receivers (japi and pod3) return status 200 "Request accepted" and
// then silently drop the message, so they must not be used as fallbacks.
const DEFAULT_QS_URL = "https://japi.instaalerts.zone/httpapi/QueryStringReceiver";
// Must stay character-for-character identical to the approved DLT template.
const DEFAULT_OTP_TEXT =
  "Your OTP for registering with NIAT Guru Ratna Awards 2026 is {#var#}. Valid for 5 minutes. Do not share this code with anyone.";

export class KarixError extends Error {
  status: number;
  // Karix's own Statuscode, surfaced so a gateway rejection can be diagnosed from
  // the API response without needing access to server logs.
  gatewayCode?: string;

  constructor(message: string, status = 500, gatewayCode?: string) {
    super(message);
    this.name = "KarixError";
    this.status = status;
    this.gatewayCode = gatewayCode;
  }
}

export const toKarixMobile = (phone: string) => {
  const digits = String(phone ?? "").replace(/\D/g, "").slice(-10);
  return `91${digits}`;
};

const otpPepper = () =>
  process.env.KARIX_ACCESS_KEY?.trim() || process.env.ADMIN_SECRET?.trim() || "niat-otp";

export const hashOtp = (phone: string, otp: string) =>
  createHmac("sha256", otpPepper()).update(`${toKarixMobile(phone)}:${otp}`).digest("hex");

// Escape hatch for local testing: prints the OTP and the outbound request to the
// server console. Never enabled in production.
const devConsoleOtp = () =>
  process.env.NODE_ENV !== "production" && process.env.OTP_DEV_CONSOLE === "true";

// Responses look like:
//   Request accepted for Request ID=... & Statuscode=200 & Info=Platform Accepted & Time=...
//   Invalid Credentials for Request ID=N/A & Statuscode=-108 & Info=REJECTED & Time=...
const parseQsResponse = (raw: string) => ({
  statusCode: raw.match(/Statuscode=(-?\d+)/i)?.[1] ?? "",
  requestId: raw.match(/Request ID=(\S+)/i)?.[1] ?? "",
});

export const sendKarixSms = async (phone: string, text: string) => {
  const key = process.env.KARIX_ACCESS_KEY?.trim();
  const sender = process.env.KARIX_SENDER_ID?.trim();
  if (!key || !sender) {
    const missing = [!key && "KARIX_ACCESS_KEY", !sender && "KARIX_SENDER_ID"].filter(Boolean);
    throw new KarixError("SMS is not configured", 500, `missing:${missing.join(",")}`);
  }

  const url = (process.env.KARIX_QS_URL?.trim() || DEFAULT_QS_URL).replace(/\/$/, "");
  const params = new URLSearchParams({
    ver: "1.0",
    key,
    encrpt: "0",
    dest: toKarixMobile(phone),
    send: sender,
    text,
  });

  // DLT ids are mandatory for Indian traffic; the operator scrubs messages without them.
  const templateId = process.env.KARIX_DLT_TEMPLATE_ID?.trim();
  const entityId = process.env.KARIX_DLT_ENTITY_ID?.trim();
  const tmId = process.env.KARIX_DLT_TM_ID?.trim();
  if (templateId) params.set("dlt_template_id", templateId);
  if (entityId) params.set("dlt_entity_id", entityId);
  if (tmId) params.set("dlt_tm_id", tmId);

  if (devConsoleOtp()) {
    const masked = new URLSearchParams(params);
    masked.set("key", "<KARIX_ACCESS_KEY>");
    console.log(`[karix request] GET ${url}?${masked}`);
  }

  const res = await fetch(`${url}?${params}`);
  const raw = (await res.text()).trim();
  const { statusCode, requestId } = parseQsResponse(raw);

  if (statusCode !== "200") {
    console.error("Karix SMS rejected:", raw);
    throw new KarixError(
      /credential/i.test(raw) ? "SMS gateway rejected the request" : "Could not send OTP. Please try again.",
      /invalid|credential|reject/i.test(raw) ? 400 : 500,
      statusCode || raw.slice(0, 60)
    );
  }

  console.log(`Karix SMS accepted: request_id=${requestId}`);
  return { requestId, raw };
};

// Accepts either our own {otp} marker or the DLT template's {#var#} / {#var:name#}
// form, so the approved template can be pasted into KARIX_OTP_TEXT verbatim.
const OTP_PLACEHOLDER = /\{otp\}|\{#var(?::[^#}]*)?#\}/g;

const otpMessage = (otp: string) => {
  const template = process.env.KARIX_OTP_TEXT?.trim() || DEFAULT_OTP_TEXT;
  if (!OTP_PLACEHOLDER.test(template)) {
    throw new KarixError(
      "KARIX_OTP_TEXT has no {#var#} placeholder, so the OTP cannot be inserted. " +
        "Wrap the value in double quotes if it contains a # character.",
      500
    );
  }
  return template.replace(OTP_PLACEHOLDER, otp);
};

const expiryMinutes = () => {
  const n = Number(process.env.KARIX_OTP_EXPIRY);
  return Number.isFinite(n) && n > 0 ? n : 5;
};

export const generateAndSendOtp = async (phone: string) => {
  const otp = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + expiryMinutes() * 60 * 1000);
  const devMode = devConsoleOtp();

  try {
    await sendKarixSms(phone, otpMessage(otp));
  } catch (err) {
    if (!devMode) throw err;
    console.warn("Karix send failed:", err instanceof Error ? err.message : err);
  }

  await OtpVerification.findOneAndUpdate(
    { phone: toKarixMobile(phone).slice(-10) },
    { otp: hashOtp(phone, otp), expires_at: expiresAt },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  if (devMode) {
    console.log(
      `[dev OTP] ${toKarixMobile(phone).slice(-10)} -> ${otp} (valid ${expiryMinutes()} min)`
    );
  }
};

export const verifyStoredOtp = async (phone: string, otp: string) => {
  const cleaned = String(phone ?? "").replace(/\D/g, "").slice(-10);
  const row = await OtpVerification.findOne({ phone: cleaned });
  if (!row) {
    throw new KarixError("Invalid OTP. Please try again.", 400);
  }
  if (row.expires_at.getTime() < Date.now()) {
    await OtpVerification.deleteOne({ _id: row._id });
    throw new KarixError("OTP expired. Please request a new one.", 400);
  }
  if (row.otp !== hashOtp(cleaned, String(otp))) {
    throw new KarixError("Invalid OTP. Please try again.", 400);
  }
  await OtpVerification.deleteOne({ _id: row._id });
};
