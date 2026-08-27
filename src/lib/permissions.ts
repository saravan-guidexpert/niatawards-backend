export const PANEL_PERMISSIONS = ["nominations", "campaigns", "digital", "whatsapp"] as const;

export type PanelPermission = (typeof PANEL_PERMISSIONS)[number];
export type AdminRole = "super_admin" | "staff";

export const ALL_PANEL_PERMISSIONS: PanelPermission[] = [...PANEL_PERMISSIONS];

export type AdminIdentity = {
  id: string;
  username: string;
  name: string;
  role: AdminRole;
  permissions: PanelPermission[];
};

export const isPanelPermission = (value: unknown): value is PanelPermission =>
  typeof value === "string" && (PANEL_PERMISSIONS as readonly string[]).includes(value);

export const normalizePermissions = (value: unknown): PanelPermission[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isPanelPermission))];
};

export const hasPermission = (admin: AdminIdentity, permission: PanelPermission) => {
  if (admin.role === "super_admin") return true;
  return admin.permissions.includes(permission);
};

export const hasAnyPermission = (admin: AdminIdentity, permissions: PanelPermission[]) => {
  if (admin.role === "super_admin") return true;
  return permissions.some((permission) => admin.permissions.includes(permission));
};
