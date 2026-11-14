// What each role may do beyond its own data. A route that needs more than a
// signed-in user declares `auth: 'admin'` and the permission it needs
// (http/route.ts); the boundary asks can() for the caller's role. A new role
// or a narrower grant is one entry here instead of a search through the
// routes. Rights are checked by permission, never by role name.
//
// Roles (0.30): the one owner of the installation, admins, and members
// (stored as 'user'). Only the owner makes or removes admins and hands
// ownership on. A group manager is no role: managing a group is a right on
// that group, answered by services/access.ts.
const PERMISSIONS = [
  'users.read', 'users.manage', 'server.settings', 'storage.read', 'audit.read',
  'groups.manage', 'admins.manage', 'owner.transfer',
] as const;
type Permission = typeof PERMISSIONS[number];

const OWNER_ONLY: readonly Permission[] = ['admins.manage', 'owner.transfer'];

const ROLE_PERMISSIONS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  owner: PERMISSIONS,
  admin: PERMISSIONS.filter(permission => !OWNER_ONLY.includes(permission)),
  user: [],
});

function can(role: string | null | undefined, permission: Permission) {
  return !!role && (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

function permissionsOf(role: string | null | undefined): Permission[] {
  return [...(role ? ROLE_PERMISSIONS[role] ?? [] : [])];
}

function isPermission(value: unknown): value is Permission {
  return (PERMISSIONS as readonly unknown[]).includes(value);
}

export { PERMISSIONS, ROLE_PERMISSIONS, can, permissionsOf, isPermission };
export type { Permission };
