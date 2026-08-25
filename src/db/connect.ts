import mongoose from "mongoose";

export const connectDB = async (): Promise<void> => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MongoDB connection failed: MONGODB_URI is not set");
    process.exit(1);
  }

  try {
    const conn = await mongoose.connect(uri, { dbName: "niat_awards_2026" });
    console.log(`MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("MongoDB connection failed:", message);
    process.exit(1);
  }
};
