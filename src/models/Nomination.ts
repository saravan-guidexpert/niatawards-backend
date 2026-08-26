import { Schema, model } from "mongoose";
import { randomUUID } from "crypto";

const jsonTransform = (_doc: unknown, ret: Record<string, unknown>) => {
  ret.id = ret._id;
  delete ret._id;
  delete ret.__v;
  return ret;
};

const nominationSchema = new Schema(
  {
    _id: { type: String, default: () => randomUUID() },
    created_at: { type: Date, default: Date.now },
    type: { type: String, required: true, enum: ["student", "teacher"] },
    student_name: { type: String, default: null },
    student_class: { type: String, default: null },
    class_group: { type: String, default: null },
    school_name: { type: String, default: null },
    phone: { type: String, required: true },
    teacher_name: { type: String, default: null },
    award_category: { type: String, required: true, default: "General Nomination" },
    special_thing: { type: String, default: null },
    subject: { type: String, default: null },
    impact_story: { type: String, default: null },
    board: { type: String, default: null },
    care_rating: { type: Number, default: null },
    clarity_rating: { type: Number, default: null },
    motivation_rating: { type: Number, default: null },
    support_rating: { type: Number, default: null },
    full_name: { type: String, default: null },
    experience: { type: String, default: null },
    photo_url: { type: String, default: null },
    status: {
      type: String,
      required: true,
      enum: ["pending", "shortlisted", "winner", "rejected"],
      default: "pending",
    },
  },
  {
    toJSON: { transform: jsonTransform },
    toObject: { transform: jsonTransform },
  }
);

nominationSchema.index({ status: 1 });
nominationSchema.index({ award_category: 1 });

export const Nomination = model("Nomination", nominationSchema);
