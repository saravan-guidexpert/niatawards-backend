import mongoose, { Document, Schema } from "mongoose";

export const FDP_STATUSES = ["draft", "submitted", "cancelled"] as const;
export type FdpStatus = (typeof FDP_STATUSES)[number];

export const FDP_ADMIN_STATUSES = ["NEW", "CONTACTED", "CONFIRMED", "ARCHIVED"] as const;
export type FdpAdminStatus = (typeof FDP_ADMIN_STATUSES)[number];

export interface IFdpRegistration extends Document {
  registration_id: string;
  full_name: string;
  phone: string;
  phone_verified: boolean;
  teaching_subject?: string;
  institution_name?: string;
  city?: string;
  experience_years?: string;
  receive_updates: boolean;
  status: FdpStatus;
  admin_status: FdpAdminStatus;
  admin_notes?: string;
  utm?: {
    source?: string;
    medium?: string;
    campaign?: string;
    term?: string;
    content?: string;
  };
  created_at: Date;
  updated_at: Date;
}

const FdpRegistrationSchema = new Schema<IFdpRegistration>(
  {
    registration_id: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    full_name: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    phone_verified: {
      type: Boolean,
      default: false,
    },
    teaching_subject: {
      type: String,
      trim: true,
      default: "",
    },
    institution_name: {
      type: String,
      trim: true,
      default: "",
    },
    city: {
      type: String,
      trim: true,
      default: "",
    },
    experience_years: {
      type: String,
      trim: true,
      default: "",
    },
    receive_updates: {
      type: Boolean,
      default: true,
    },
    status: {
      type: String,
      enum: FDP_STATUSES,
      default: "draft",
      index: true,
    },
    admin_status: {
      type: String,
      enum: FDP_ADMIN_STATUSES,
      default: "NEW",
      index: true,
    },
    admin_notes: {
      type: String,
      default: "",
    },
    utm: {
      source: { type: String, default: "" },
      medium: { type: String, default: "" },
      campaign: { type: String, default: "" },
      term: { type: String, default: "" },
      content: { type: String, default: "" },
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

FdpRegistrationSchema.index({ created_at: -1 });

export const FdpRegistration =
  mongoose.models.FdpRegistration ||
  mongoose.model<IFdpRegistration>("FdpRegistration", FdpRegistrationSchema);
