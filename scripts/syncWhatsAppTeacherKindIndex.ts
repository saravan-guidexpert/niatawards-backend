import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

import mongoose from "mongoose";
import { connectDB } from "../src/db/connect";
import { WhatsAppMessageEvent } from "../src/models/WhatsAppMessageEvent";

const main = async () => {
  await connectDB();
  await WhatsAppMessageEvent.syncIndexes();
  const indexes = await WhatsAppMessageEvent.collection.indexes();
  console.log(
    JSON.stringify(
      indexes.map((item) => ({
        name: item.name,
        unique: item.unique,
        key: item.key,
        partial: item.partialFilterExpression,
      })),
      null,
      2
    )
  );
  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
