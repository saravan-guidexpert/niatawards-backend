import mongoose from "mongoose";
import dns from "dns";

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
    if (message.includes("querySrv") || message.includes("EBADRESP")) {
      try {
        dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);
        const conn = await mongoose.connect(uri, { dbName: "niat_awards_2026" });
        console.log(`MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
        return;
      } catch (retryErr) {
        const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
        console.error("MongoDB connection failed after DNS fallback:", retryMessage);
        process.exit(1);
      }
    }
    console.error("MongoDB connection failed:", message);
    process.exit(1);
  }
};
