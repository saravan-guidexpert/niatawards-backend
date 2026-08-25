import { Schema, model } from "mongoose";
import { randomUUID } from "crypto";

const jsonTransform = (_doc: unknown, ret: Record<string, unknown>) => {
  ret.id = ret._id;
  delete ret._id;
  delete ret.__v;
  return ret;
};

const voteSchema = new Schema(
  {
    _id: { type: String, default: () => randomUUID() },
    created_at: { type: Date, default: Date.now },
    nomination_id: { type: String, required: true, ref: "Nomination" },
    voter_phone: { type: String, required: true },
  },
  {
    toJSON: { transform: jsonTransform },
    toObject: { transform: jsonTransform },
  }
);

voteSchema.index({ nomination_id: 1, voter_phone: 1 }, { unique: true });
voteSchema.index({ voter_phone: 1 });
voteSchema.index({ nomination_id: 1 });

export const Vote = model("Vote", voteSchema);
