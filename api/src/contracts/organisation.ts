// Request and response shapes of the organisation (0.30, F3 and the first
// slice of F4, F11): people, roles, groups and their managers, setup links,
// and an administrator's view of a person's devices. One organisation per
// installation: the installation is the company, so nothing carries an
// organisation id. The frontend imports these as types only.
//
// Errors, besides those of every route: 400 ADMIN_PASSWORD_REQUIRED, 403
// ADMIN_PASSWORD_INCORRECT and 429 where a change carries the administrator's
// password; 404 USER_NOT_FOUND; 404 GROUP_NOT_FOUND for a group the caller
// cannot see; 403 GROUP_FORBIDDEN for one they can see but not manage; 400
// OWNER_PROTECTED for demoting, deactivating or deleting the owner; 404
// INVITE_INVALID for a setup link that is unknown, used, expired or revoked
// (one answer for all of them).
import type { AdminReauthentication } from './admin-accounts';
import type { DeviceSummary } from './devices';
import type { Permission } from '../security/permissions';

export type { Permission };

/** Stored roles: the one owner, administrators, and members (stored as 'user'). */
export type Role = 'owner' | 'admin' | 'user';

/**
 * Who something is for (F3): one person, one group, or everyone active on
 * the installation. Features store principals, never lists of user ids.
 * Everyone has no row: its policies are the installation's.
 */
export type Principal =
  | { kind: 'user'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'everyone' };

/** A person's role inside one group. */
export type GroupRole = 'member' | 'manager';

/** What the signed-in person's own principals are (services/access.ts principalsOf). */
export interface Principals {
  user: string;
  groups: string[];
  everyone: true;
}

// --- Access (F4) -------------------------------------------------------------

/** The kinds of resource the access service answers for; 0.31 adds shared ones. */
export type AccessKind = 'group';

/** Permissions on each kind, from the least to the most. */
export interface AccessPermissions {
  group: 'read' | 'manage';
}

// --- The signed-in person ------------------------------------------------------

/** The person in GET /api/auth/me and the sign-in answers gains, from 0.30, what their role grants and whether they manage a group. */
export interface MeOrganisation {
  permissions: Permission[];
  manages_groups: boolean;
}

// --- People (Server › People) -------------------------------------------------------

/**
 * active: can sign in; inactive: deactivated by an administrator or waiting
 * for approval; invited: no password yet, a setup link is live; not_set_up: no
 * password yet and no live link.
 */
export type PersonStatus = 'active' | 'inactive' | 'invited' | 'not_set_up';

export interface PersonGroup { id: string; name: string; role: GroupRole }

/** One row of GET /api/admin/users (permission users.read). */
export interface Person {
  id: string;
  email: string;
  full_name: string | null;
  role: Role;
  status: PersonStatus;
  is_active: boolean;
  two_factor_enabled: boolean;
  /** While two-factor authentication is required and not set up: when the person's grace ends. */
  two_factor_grace_ends_at: string | null;
  groups: PersonGroup[];
  created_at: string;
  /** The last use of any of the person's devices; null when none. */
  last_active_at: string | null;
}

export interface PeopleResponse { users: Person[] }

/**
 * POST /api/admin/users (users.manage; admins.manage for role 'admin'): the
 * account exists at once. Without `password` the answer carries a setup
 * link; with it, the person can sign in with that password (no forced
 * change). The password must meet the person's auth.password_min_length.
 */
export interface AddPersonRequest extends AdminReauthentication {
  email: string;
  full_name?: string | null;
  role: Exclude<Role, 'owner'>;
  group_ids?: string[];
  password?: string;
}

/** A setup link, shown once to copy: `${origin}/invite#<token>`. Only its hash is stored. */
export interface SetupLink {
  url: string;
  expires_at: string;
}

export interface AddPersonResponse {
  user: Person;
  setup_link: SetupLink | null;
}

/** POST /api/admin/users/:id/setup-link (users.manage): a new link; the earlier one stops working. */
export type SetupLinkRequest = AdminReauthentication;
export interface SetupLinkResponse { setup_link: SetupLink }

/** POST /api/admin/owner/transfer (owner.transfer): to an active administrator. */
export interface OwnerTransferRequest extends AdminReauthentication { user_id: string }

/** GET /api/admin/users/:id/devices (users.read): the person's devices with a live session. */
export interface PersonDevicesResponse { devices: Omit<DeviceSummary, 'current'>[] }

/** DELETE /api/admin/users/:id/devices[/:deviceId] (users.manage): signs them out; no data is deleted. */
export type EndDevicesRequest = AdminReauthentication;
export interface EndDevicesResponse { ended: number }

// --- Setup links (public) ---------------------------------------------------------

/** POST /api/auth/invite/check: what the link is for, before a password is chosen. */
export interface InviteCheckRequest { token: string }
export interface InviteCheckResponse {
  email: string;
  full_name: string | null;
  expires_at: string;
  /** The rules that will apply to this person (their groups' included), in plain words. */
  data_rules: string[];
  rules_revision: number;
}

/** POST /api/auth/invite/accept: sets the password and signs in, as sign-up does. */
export interface InviteAcceptRequest {
  token: string;
  password: string;
  full_name?: string | null;
  device?: { key: string; kind: string };
  rules_revision?: number;
}

// --- Groups -------------------------------------------------------------------------

export interface GroupSummary {
  id: string;
  name: string;
  description: string | null;
  member_count: number;
  manager_count: number;
  /** The group sets at least one policy. */
  has_policies: boolean;
}

/** GET /api/admin/groups (users.read): every group. */
export interface GroupsAdminResponse { groups: GroupSummary[] }

/** GET /api/groups: the signed-in person's groups and their role in each. */
export interface MyGroupsResponse { groups: (GroupSummary & { role: GroupRole })[] }

export interface GroupMember {
  id: string;
  email: string;
  full_name: string | null;
  role: GroupRole;
  added_at: string;
}

/** GET /api/groups/:id: members are listed for those who may manage the group; others see its managers. */
export interface GroupResponse {
  group: GroupSummary;
  can_manage: boolean;
  members: GroupMember[];
}

/** POST /api/admin/groups (groups.manage); PUT /api/groups/:id (manage). */
export interface GroupInput { name: string; description?: string | null }

/** POST /api/groups/:id/members (manage): at most 200 people at once. */
export interface AddMembersRequest { user_ids: string[] }

/** PUT /api/admin/groups/:id/managers/:userId (groups.manage); a person who is not yet a member becomes one. */
export interface SetManagerRequest { manager: boolean }

/** GET /api/groups/:id/candidates?q= (manage): active people not in the group, at most 20. */
export interface GroupCandidate { id: string; email: string; full_name: string | null }
export interface GroupCandidatesResponse { people: GroupCandidate[] }

/** DELETE /api/admin/groups/:id (groups.manage): the group, its memberships and its policies; no person's data. */
export type DeleteGroupRequest = AdminReauthentication;
