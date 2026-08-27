import { Schema, model } from "mongoose";

const whatsAppOptOutSchema = new Schema({
  phone: { type: String, required: true, unique: true, match: [/^\d{10}$/, "10-digit phone"] },
  reason: { type: String, trim: true, maxlength: 64, default: "STOP" },
  inboundText: { type: String, trim: true, maxlength: 4096, default: null },
  optedOutAt: { type: Date, default: Date.now },
});

export const WhatsAppOptOut = model("WhatsAppOptOut", whatsAppOptOutSchema);
