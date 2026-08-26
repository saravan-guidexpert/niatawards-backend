import { Schema, model } from "mongoose";
import { randomUUID, createHash, randomBytes } from "crypto";

const jsonTransform = (_doc: unknown, ret: Record<string, unknown>) => {
  ret.id = ret._id;
  delete ret._id;
  delete ret.__v;
  delete ret.token_hash;
  return ret;
};

const adminSessionSchema = new Schema(
  {
    _id: { type: String, default: () => randomUUID() },
    created_at: { type: Date, default: Date.now },
    expires_at: { type: Date, required: true },
    admin_user_id: { type: String, required: true, index: true },
    token_hash: { type: String, required: true, unique: true },
  },
  {
    toJSON: { transform: jsonTransform },
    toObject: { transform: jsonTransform },
  }
);

adminSessionSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

export const hashSessionToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export const createSessionToken = () => randomBytes(32).toString("hex");

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const AdminSession = model("AdminSession", adminSessionSchema);
