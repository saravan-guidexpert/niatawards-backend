import { Schema, model } from "mongoose";
import { randomUUID } from "crypto";
import { PANEL_PERMISSIONS } from "../lib/permissions";

const jsonTransform = (_doc: unknown, ret: Record<string, unknown>) => {
  ret.id = ret._id;
  delete ret._id;
  delete ret.__v;
  delete ret.password_hash;
  return ret;
};

const adminUserSchema = new Schema(
  {
    _id: { type: String, default: () => randomUUID() },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
    username: { type: String, required: true, unique: true, trim: true },
    password_hash: { type: String, required: true },
    name: { type: String, default: "" },
    role: { type: String, required: true, enum: ["super_admin", "staff"], default: "staff" },
    permissions: {
      type: [String],
      enum: PANEL_PERMISSIONS,
      default: [],
    },
    active: { type: Boolean, required: true, default: true },
  },
  {
    toJSON: { transform: jsonTransform },
    toObject: { transform: jsonTransform },
  }
);

adminUserSchema.index({ role: 1 });

export const AdminUser = model("AdminUser", adminUserSchema);
