import { SmsMessage } from "../models/SmsMessage";

export type DlrPayload = Record<string, unknown>;

// Karix does not publish the field names it posts to a delivery report callback,
// and they differ between accounts, so every field is located by pattern rather
// than by a fixed key. The full payload is stored either way.
const REQUEST_ID_KEYS = /req(uest)?[_-]?id|msg[_-]?id|message[_-]?id|guid|^id$/i;
const DEST_KEYS = /dest|msisdn|mobile|^to$|number|phone/i;
const STATUS_KEYS = /status|dlr|state|desc|reason|info|error/i;

const pick = (payload: DlrPayload, pattern: RegExp) => {
  const key = Object.keys(payload).find((k) => pattern.test(k));
  if (!key) return "";
  const value = payload[key];
  if (value === null || value === undefined || typeof value === "object") return "";
  return String(value).trim();
};

export const classifyDlrStatus = (status: string) => {
  if (!status) return "unknown" as const;
  // "undelivered" contains "delivered", so failure patterns are tested first.
  if (/un[\s_-]?deliv|not[\s_-]?deliv|fail|reject|expir|scrub|block|dnd|invalid/i.test(status)) {
    return "failed" as const;
  }
  if (/deliv|success|^dl$|^0$/i.test(status)) return "delivered" as const;
  return "unknown" as const;
};

export const recordDeliveryReport = async (payload: DlrPayload) => {
  const requestId = pick(payload, REQUEST_ID_KEYS);
  const dest = pick(payload, DEST_KEYS).replace(/\D/g, "").slice(-10);
  const statusText = pick(payload, STATUS_KEYS);
  const status = classifyDlrStatus(statusText);

  const update = {
    status,
    gateway_status: statusText || "(no status field)",
    dlr_payload: payload,
    dlr_received_at: new Date(),
  };

  let matched = false;
  if (requestId) {
    const existing = await SmsMessage.findOneAndUpdate({ request_id: requestId }, update);
    matched = Boolean(existing);
  }

  // A report with no matching send row is still worth keeping: it may belong to
  // a send from another environment sharing this database.
  if (!matched) {
    await SmsMessage.create({
      ...update,
      request_id: requestId || undefined,
      phone: dest || "unknown",
    });
  }

  const summary = `request_id=${requestId || "?"} dest=${dest || "?"} status=${status} raw="${statusText}"`;
  if (status === "delivered") {
    console.log(`SMS delivered: ${summary}`);
  } else {
    console.warn(`SMS not delivered: ${summary}`);
  }

  return { requestId, status, matched };
};
