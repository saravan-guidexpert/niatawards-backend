import { Request, Response, NextFunction } from "express";
import { AdminUser } from "../models/AdminUser";
import { AdminSession, hashSessionToken } from "../models/AdminSession";
import {
  AdminIdentity,
  PanelPermission,
  hasAnyPermission,
  hasPermission,
  isPanelPermission,
} from "../lib/permissions";

export type { AdminIdentity };

declare global {
  namespace Express {
    interface Request {
      admin?: AdminIdentity;
    }
  }
}

const toIdentity = (user: {
  id?: unknown;
  _id?: unknown;
  username: string;
  name?: string | null;
  role: string;
  permissions?: unknown;
}): AdminIdentity => ({
  id: String(user.id ?? user._id),
  username: user.username,
  name: user.name || "",
  role: user.role === "super_admin" ? "super_admin" : "staff",
  permissions: Array.isArray(user.permissions)
    ? user.permissions.filter(isPanelPermission)
    : [],
});

const legacySecret = () => (process.env.ADMIN_SECRET || "").trim();

export const adminAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const header = String(req.headers.authorization || "");
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

    if (bearer) {
      const session = await AdminSession.findOne({
        token_hash: hashSessionToken(bearer),
        expires_at: { $gt: new Date() },
      });
      if (!session) {
        res.status(401).json({ error: "Session expired. Please sign in again." });
        return;
      }

      const user = await AdminUser.findById(session.admin_user_id);
      if (!user || !user.active) {
        await AdminSession.deleteMany({ admin_user_id: session.admin_user_id });
        res.status(401).json({ error: "Account is disabled. Please contact the super admin." });
        return;
      }

      req.admin = toIdentity(user.toJSON() as Parameters<typeof toIdentity>[0]);
      next();
      return;
    }

    const secret = String(req.headers["x-admin-secret"] || "");
    const expected = legacySecret();
    if (expected && secret === expected) {
      req.admin = {
        id: "legacy",
        username: "legacy",
        name: "Legacy Admin",
        role: "super_admin",
        permissions: ["nominations", "campaigns", "digital", "whatsapp"],
      };
      next();
      return;
    }

    res.status(401).json({ error: "Unauthorized" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unauthorized";
    res.status(401).json({ error: message });
  }
};

export const requireSuperAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (req.admin?.role !== "super_admin") {
    res.status(403).json({ error: "Only the super admin can manage access." });
    return;
  }
  next();
};

export const requirePermission = (permission: PanelPermission) =>
  (req: Request, res: Response, next: NextFunction) => {
    if (!req.admin || !hasPermission(req.admin, permission)) {
      res.status(403).json({ error: "You do not have access to this section." });
      return;
    }
    next();
  };

export const requireAnyPermission = (...permissions: PanelPermission[]) =>
  (req: Request, res: Response, next: NextFunction) => {
    if (!req.admin || !hasAnyPermission(req.admin, permissions)) {
      res.status(403).json({ error: "You do not have access to this section." });
      return;
    }
    next();
  };
