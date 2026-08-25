import { Request, Response, NextFunction } from "express";

const expectedSecret =
  (process.env.ADMIN_SECRET || "").trim() || "niat_admin_2026_secret";

export const adminAuth = (req: Request, res: Response, next: NextFunction) => {
  const secret = req.headers["x-admin-secret"];
  if (secret !== expectedSecret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};
