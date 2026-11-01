// Request and response shapes of the bin (F11). The frontend imports these as
// types only; the rules are in services/bin.ts. Deleted contacts, events,
// tasks (also CalDAV ones), recordings and local calendars wait here for the
// person's retention; mail keeps its Trash folders.

/** The modules whose items go to the bin. Each item is gated by its own module's switch and restore lock. */
export type BinModule = 'contacts' | 'calendar' | 'recordings';
export type BinItemType = 'contact' | 'event' | 'task' | 'recording' | 'calendar';
/** deleted: by the person; merged: a contact merged into another; calendar_deleted: with its local calendar. */
export type BinReason = 'deleted' | 'merged' | 'calendar_deleted';

/** How long the bin keeps an item (the user setting bin_retention); an administrator can set a minimum. */
export type BinRetention = '7' | '30' | '90' | 'forever';

export interface BinItem {
  id: string;
  module: BinModule;
  item_type: BinItemType;
  title: string;
  reason: BinReason;
  /** Items deleted together (a merge, a calendar with its events) are restored together. */
  group_id: string | null;
  deleted_at: string;
  /** When the purge removes it for good; null keeps it until it is restored or deleted. */
  purge_after: string | null;
  /** A synced item: restoring it creates it at its provider again. */
  provider: 'local' | 'caldav';
  /** The list or account it came from, in plain words, when that helps to tell items apart. */
  origin: string | null;
}

/** GET /api/bin?module= */
export interface BinListResponse {
  items: BinItem[];
  retention: BinRetention;
}

/** POST /api/bin/restore (POST /api/bin/:id/restore takes no body). A group is restored as a unit. */
export interface BinRestoreRequest { ids: string[] }

export interface BinRestored {
  id: string;
  item_type: BinItemType;
  /** The restored record's id; it is new when the old one was taken. */
  item_id: string;
  /** For example "The calendar is gone; restored to your default list." */
  note: string | null;
}

export interface BinRestoreResponse {
  restored: BinRestored[];
  failed: { id: string; error: string; code?: string }[];
}

/** POST /api/bin/empty: the whole bin, or one module's part of it. */
export interface BinEmptyRequest { module?: BinModule }

/** DELETE /api/bin/:id and POST /api/bin/empty (both under the bin.delete policy). */
export interface BinDeleteResponse { deleted: number }
