import { SmsMessage } from "../models/SmsMessage";

export class Msg91Error extends Error {
  status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "Msg91Error";
    this.status = status;
  }
}

export const toMsg91Mobile = (phone: string) => {
  const digits = String(phone ?? "").replace(/\D/g, "").slice(-10);
  return `91${digits}`;
};

export const maskPhone = (phone: string) => {
  const digits = String(phone ?? "").replace(/\D/g, "").slice(-10);
  if (digits.length < 4) return "****";
  return `****${digits.slice(-4)}`;
};

const asRecord = (body: unknown) =>
  body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

const isErrorPayload = (body: unknown) => {
  const rec = asRecord(body);
  const type = String(rec.type ?? rec.status ?? "").toLowerCase();
  if (type === "error" || type === "fail" || type === "failed") return true;
  const message = String(rec.message ?? "");
  return /invalid|not found|inactive|reject|fail/i.test(message) && type !== "success";
};

const requestIdFrom = (body: unknown) => {
  const rec = asRecord(body);
  for (const key of ["request_id", "requestId", "messageId", "message_id"]) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
};

const publicMsg91Summary = (httpStatus: number, body: unknown) => {
  const rec = asRecord(body);
  const type = String(rec.type ?? rec.status ?? "");
  const message = String(rec.message ?? "").slice(0, 160);
  return `http=${httpStatus} type=${type || "?"} message=${message || "(none)"}`;
};

export const sendMsg91Otp = async (phone: string, otp: string) => {
  const authkey = process.env.MSG91_AUTH_KEY?.trim();
  const templateId = process.env.MSG91_TEMPLATE_ID?.trim();
  if (!authkey || !templateId) {
    throw new Msg91Error("SMS is not configured", 500);
  }

  const expiry = Number(process.env.OTP_EXPIRY_MINUTES);
  const otpExpiry = Number.isFinite(expiry) && expiry > 0 ? String(expiry) : "10";
  const mobile = toMsg91Mobile(phone);
  const params = new URLSearchParams({
    mobile,
    otp_expiry: otpExpiry,
    template_id: templateId,
    otp,
    realTimeResponse: "1",
  });

  const url = `https://control.msg91.com/api/v5/otp?${params}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authkey,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.error("MSG91 OTP request failed:", maskPhone(phone), err instanceof Error ? err.message : err);
    throw new Msg91Error("Could not send OTP.", 502);
  }

  const raw = (await res.text()).trim();
  let body: unknown = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { message: raw };
  }

  if (res.status >= 400 || isErrorPayload(body)) {
    console.error("MSG91 OTP rejected:", maskPhone(phone), publicMsg91Summary(res.status, body));
    throw new Msg91Error("Could not send OTP.", 502);
  }

  const requestId = requestIdFrom(body);
  console.log(`MSG91 OTP accepted: phone=${maskPhone(phone)} ${publicMsg91Summary(res.status, body)}${requestId ? ` request_id=${requestId}` : ""}`);

  try {
    await SmsMessage.create({
      request_id: requestId || undefined,
      phone: mobile.slice(-10),
      sender: "MSG91",
      status: "accepted",
      gateway_status: raw.slice(0, 200),
    });
  } catch (err) {
    console.warn("Could not record SMS send:", err instanceof Error ? err.message : err);
  }

  return { requestId };
};
