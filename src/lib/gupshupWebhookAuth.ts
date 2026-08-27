import crypto from "crypto";
import type { Request } from "express";

const getConfiguredWebhookSecret = () => {
  const secret = process.env.GUPSHUP_WEBHOOK_SECRET;
  if (!secret || !String(secret).trim()) return null;
  return String(secret).trim();
};

const isWebhookAuthEnforced = () => {
  const authFlag = String(process.env.GUPSHUP_WEBHOOK_AUTH_REQUIRED || "").trim();
  if (authFlag === "0") return false;
  if (authFlag === "1") return true;
  return Boolean(getConfiguredWebhookSecret());
};

const extractWebhookCredential = (req: Request) => {
  const header = req.headers["x-gupshup-signature"] || req.headers["x-webhook-secret"] || req.query.secret;
  return header != null ? String(header) : "";
};

const timingSafeEqualStrings = (a: string, b: string) => {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
};

export const verifyGupshupWebhookRequest = (req: Request) => {
  const enforced = isWebhookAuthEnforced();
  const secret = getConfiguredWebhookSecret();

  if (enforced && !secret) {
    return { ok: false as const, statusCode: 503, error: "webhook_secret_not_configured" };
  }
  if (!enforced) {
    return { ok: true as const };
  }

  const provided = extractWebhookCredential(req);
  if (!provided || !timingSafeEqualStrings(provided, secret || "")) {
    return { ok: false as const, statusCode: 401, error: "unauthorized" };
  }
  return { ok: true as const };
};
