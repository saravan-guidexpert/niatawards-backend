import { AdminUser } from "../models/AdminUser";
import { ALL_PANEL_PERMISSIONS } from "./permissions";
import { hashPassword, verifyPassword } from "./passwords";

// No fallback values: a hardcoded default here would be a published credential,
// since this repository is public. An unset variable skips seeding instead.
export const superAdminUsername = () => (process.env.ADMIN_USERNAME || "").trim();
export const superAdminPassword = () => (process.env.ADMIN_PASSWORD || "").trim();

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const findAdminByUsername = (username: string) =>
  AdminUser.findOne({
    username: { $regex: new RegExp(`^${escapeRegex(username.trim())}$`, "i") },
  });

export const seedSuperAdmin = async () => {
  await AdminUser.collection.updateMany(
    {},
    { $pull: { permissions: "votes" } } as Record<string, unknown>
  );

  const username = superAdminUsername();
  const password = superAdminPassword();
  if (!username || !password) {
    console.warn("Skipping super admin seed: ADMIN_USERNAME or ADMIN_PASSWORD is empty");
    return;
  }

  let user = await AdminUser.findOne({ role: "super_admin" });
  if (!user) user = await findAdminByUsername(username);

  if (!user) {
    await AdminUser.create({
      username,
      password_hash: await hashPassword(password),
      name: "Super Admin",
      role: "super_admin",
      permissions: [...ALL_PANEL_PERMISSIONS],
      active: true,
    });
    console.log(`Seeded super admin account: ${username}`);
    return;
  }

  let changed = false;
  if (user.username !== username) {
    user.username = username;
    changed = true;
  }
  if (user.role !== "super_admin") {
    user.role = "super_admin";
    user.permissions = [...ALL_PANEL_PERMISSIONS];
    changed = true;
  }
  if (!user.active) {
    user.active = true;
    changed = true;
  }
  const passwordOk = typeof user.password_hash === "string"
    ? await verifyPassword(password, user.password_hash)
    : false;
  if (!passwordOk) {
    user.password_hash = await hashPassword(password);
    changed = true;
  }
  if (changed) {
    user.set("updated_at", new Date());
    await user.save();
    console.log(`Synced super admin credentials: ${username}`);
  }
};
