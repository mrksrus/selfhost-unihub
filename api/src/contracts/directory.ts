// Request and response shapes of the company directory (0.31, F11): every
// active person with the name and email of their account and the phone,
// job title and department they fill in. It is computed, not stored as
// contacts, and shown as the read-only address book `company`. A
// deactivated person leaves it at once. The frontend imports these as
// types only.
//
// Errors, besides those of every route: 400 DIRECTORY_INVALID for a field
// that is too long; 404 USER_NOT_FOUND on the administrator's path.

export interface DirectoryEntry {
  user_id: string;
  full_name: string | null;
  email: string;
  phone: string | null;
  job_title: string | null;
  department: string | null;
  /** The person's groups, by name. */
  groups: { id: string; name: string }[];
  /** Changes whenever a field shown here changes, so phones notice a new name or email too. */
  version: number;
}

/** GET /api/directory (Contacts module): every active person, by name. */
export interface DirectoryResponse { entries: DirectoryEntry[] }

/**
 * GET and PUT /api/directory/me (open with Contacts off, under Settings › Profile):
 * the caller's own fields; GET and PUT /api/admin/users/:id/directory
 * (users.manage): an administrator's correction, recorded in the activity
 * log. Null or empty clears a field. Phone at most 64 characters, job title
 * and department at most 255.
 */
export interface DirectoryEntryInput { phone?: string | null; job_title?: string | null; department?: string | null }
export interface DirectoryEntryResponse { entry: DirectoryEntry }
