import type { Permission } from '../../api/src/contracts/organisation';

export type { Permission };

// What the signed-in person may do beyond their own data, as the server
// reported it (GET /api/auth/me `permissions`, 0.30). The page only shows or
// greys out what the API decides anyway; rights are read by permission,
// never by role name. A session without the list (an offline copy saved
// before 0.30) has none.
type WithPermissions = { permissions?: readonly string[] | null } | null | undefined;

export function can(user: WithPermissions, permission: Permission) {
  return !!user?.permissions?.includes(permission);
}

/** Whether any Server page is open to the person. */
export function canSeeServer(user: WithPermissions) {
  return can(user, 'users.read') || can(user, 'server.settings') || can(user, 'storage.read') || can(user, 'audit.read');
}

/** Whether the person manages at least one group (My groups), as /api/auth/me reported it. */
export function managesGroups(user: { manages_groups?: boolean | null } | null | undefined) {
  return !!user?.manages_groups;
}
