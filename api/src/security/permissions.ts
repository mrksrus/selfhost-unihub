// What each role may do beyond its own data. A route that needs more than a
// signed-in user declares `auth: 'admin'` and the permission it needs
// (http/route.ts); the boundary asks can() for the caller's role. A new role
// (for example a company owner) or a narrower grant is one entry here instead
// of a search through the routes.
const PERMISSIONS = ['users.read', 'users.manage', 'server.settings', 'storage.read', 'audit.read'] as const;
type Permission = typeof PERMISSIONS[number];

const ROLE_PERMISSIONS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: PERMISSIONS,
  user: [],
});

function can(role: string | null | undefined, permission: Permission) {
  return !!role && (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

function isPermission(value: unknown): value is Permission {
  return (PERMISSIONS as readonly unknown[]).includes(value);
}

export { PERMISSIONS, ROLE_PERMISSIONS, can, isPermission };
export type { Permission };
