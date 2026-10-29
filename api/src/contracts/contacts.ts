// Request and response shapes of the contacts API (F11, F12, D6, D17). The
// frontend and the later contact services import these as types only; the
// rules are in services/contacts.ts and docs/CONTACTS.md.
//
// The model is vCard 4.0 (RFC 6350) without anything UniHub-specific (P-30):
// typed name parts and single values, labelled multi-values, and every other
// vCard property kept and written back ("kept properties").

/** The kinds of labelled values; each is a list on the contact. */
export type ContactValueKind = 'email' | 'phone' | 'address' | 'url' | 'impp' | 'related' | 'nickname' | 'category';

/**
 * The labels a value may carry, per kind. '' is "no label" (values from
 * before 0.26 have none; the page shows "Email" or "Phone"). 'custom' needs a
 * `custom_label`. The phone list follows Android's types, the relation list
 * RFC 6350 RELATED types plus Android's relations.
 */
export type EmailLabel = '' | 'home' | 'work' | 'mobile' | 'other' | 'custom';
export type PhoneLabel = '' | 'mobile' | 'home' | 'work' | 'main' | 'home_fax' | 'work_fax' | 'other_fax' | 'pager' | 'work_mobile' | 'work_pager'
  | 'callback' | 'car' | 'company_main' | 'isdn' | 'radio' | 'telex' | 'tty_tdd' | 'assistant' | 'mms' | 'other' | 'custom';
export type AddressLabel = '' | 'home' | 'work' | 'other' | 'custom';
export type UrlLabel = '' | 'homepage' | 'blog' | 'profile' | 'home' | 'work' | 'ftp' | 'other' | 'custom';
export type ImppLabel = '' | 'home' | 'work' | 'other' | 'custom';
export type RelatedLabel = '' | 'assistant' | 'brother' | 'child' | 'domestic_partner' | 'father' | 'friend' | 'manager' | 'mother' | 'parent'
  | 'partner' | 'referred_by' | 'relative' | 'sister' | 'spouse' | 'contact' | 'acquaintance' | 'met' | 'co_worker' | 'colleague'
  | 'co_resident' | 'neighbor' | 'sibling' | 'kin' | 'muse' | 'crush' | 'date' | 'sweetheart' | 'me' | 'agent' | 'emergency' | 'other' | 'custom';
export type NicknameLabel = '' | 'other_name' | 'maiden_name' | 'short_name' | 'initials' | 'custom';

/** One labelled value. `id` is the stored row's; send it back to keep the row (and its import details). */
export interface LabelledValue<Label extends string = string> {
  id?: string;
  value: string;
  label: Label;
  custom_label?: string | null;
  preferred: boolean;
}

/** A postal address. `value` is its formatted text (read-only; written from the parts). */
export interface Address extends LabelledValue<AddressLabel> {
  po_box: string | null;
  extended: string | null;
  street: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
}

/** A birthday or anniversary; without `year` when the year is unknown. */
export interface PartialDate {
  year?: number | null;
  month: number;
  day: number;
}

export interface ContactName {
  /** FN as written by the person or the import; null means "derived from the parts". */
  display: string | null;
  given: string | null;
  family: string | null;
  middle: string | null;
  prefix: string | null;
  suffix: string | null;
}

/** The contact photo's identity; the picture itself comes from the photo routes. */
export interface ContactPhoto {
  etag: string;
  width: number;
  height: number;
}

/** A property kept from an import that UniHub does not show as a field (read-only). */
export interface KeptProperty {
  name: string;
  group: string | null;
  params: Record<string, string | string[]> | null;
  value: string;
}

export interface Contact {
  id: string;
  /** vCard UID: kept from an import, else `urn:uuid:<id>`. */
  uid: string;
  /** Incremented on every write; send it back on a full PUT (or as If-Match). */
  version: number;
  /** What UniHub shows as the name: FN, else the name parts, else organisation, email or phone ('' if none). */
  display_name: string;
  name: ContactName;
  organization: { name: string | null; department: string | null };
  job_title: string | null;
  birthday: PartialDate | null;
  anniversary: PartialDate | null;
  notes: string | null;
  is_favorite: boolean;
  emails: LabelledValue<EmailLabel>[];
  phones: LabelledValue<PhoneLabel>[];
  addresses: Address[];
  urls: LabelledValue<UrlLabel>[];
  impp: LabelledValue<ImppLabel>[];
  related: LabelledValue<RelatedLabel>[];
  nicknames: LabelledValue<NicknameLabel>[];
  categories: string[];
  photo: ContactPhoto | null;
  /** How many other details are kept from imports ("Other details kept from imports (n)"). */
  kept_properties: number;
  created_at: string;
  updated_at: string;
}

/**
 * @deprecated The 3+3 projection for the Android apps 0.24.3 to 0.25.1 and
 * hand-written 0.23 clients (P-21): the first three emails and phones by
 * position, the given and family name and the organisation. Removed when the
 * last 3+3 app leaves the support window (ANDROID_COMPATIBILITY.md).
 */
export interface LegacyContactFields {
  first_name: string;
  last_name: string | null;
  email: string | null;
  email2: string | null;
  email3: string | null;
  phone: string | null;
  phone2: string | null;
  phone3: string | null;
  company: string | null;
}

/** A contact as the contacts API answers it: the model plus the legacy projection. */
export type ContactRecord = Contact & LegacyContactFields;

/** GET /api/contacts/:id: the contact with its kept properties listed. */
export interface ContactDetail extends ContactRecord {
  properties: KeptProperty[];
}

/** A merge of the last 30 days that was not undone (GET /api/contacts?include=merged). */
export interface MergedAway {
  id: string;
  into: string;
  at: string;
}

/** GET /api/contacts?q=&group=all|name_only|number_or_email_only&limit=1..2000&offset=&include=merged */
export interface ContactListResponse {
  contacts: ContactRecord[];
  has_more: boolean;
  offset: number;
  merged?: MergedAway[];
}

/** One answer of POST /api/contacts and PUT /api/contacts/:id, and 409 VERSION_CONFLICT (the current contact). */
export interface ContactResponse {
  contact: ContactRecord;
}

/** A value as sent: a plain string is a value without label. */
export type LabelledValueInput = string | {
  id?: string | null;
  value?: string | number | null;
  label?: string | null;
  custom_label?: string | null;
  preferred?: boolean;
};

export type AddressInput = {
  id?: string | null;
  label?: string | null;
  custom_label?: string | null;
  preferred?: boolean;
  po_box?: string | null;
  extended?: string | null;
  street?: string | null;
  locality?: string | null;
  region?: string | null;
  postal_code?: string | null;
  country?: string | null;
};

/** `YYYY-MM-DD`, `--MM-DD` or the object form. */
export type PartialDateInput = string | PartialDate | null;

/**
 * The full body of POST /api/contacts and PUT /api/contacts/:id. It replaces
 * the contact's content: an absent field or list is empty afterwards.
 * `is_favorite` and the kept properties stay as they are unless given
 * (`kept_properties: 'clear'` removes them). A PUT needs `version` or an
 * `If-Match: "<version>"` header and answers 409 VERSION_CONFLICT with the
 * current contact when it is stale. Input rules (D17) are in docs/CONTACTS.md.
 */
export interface ContactInput {
  version?: number;
  name?: Partial<Record<keyof ContactName, string | number | null>>;
  organization?: { name?: string | number | null; department?: string | number | null };
  job_title?: string | number | null;
  birthday?: PartialDateInput;
  anniversary?: PartialDateInput;
  notes?: string | number | null;
  is_favorite?: boolean;
  emails?: LabelledValueInput[];
  phones?: LabelledValueInput[];
  addresses?: AddressInput[];
  urls?: LabelledValueInput[];
  impp?: LabelledValueInput[];
  related?: LabelledValueInput[];
  nicknames?: LabelledValueInput[];
  categories?: (string | number)[];
  kept_properties?: 'clear';
}

/**
 * @deprecated The flat body of the 3+3 clients. A PUT applies it as a diff:
 * names, company, title and notes are set as given; emails and phones
 * missing from the body are removed from the first three, new ones are
 * added there, and every value from the fourth on keeps its place and label.
 * A body mixing both shapes is refused.
 */
export type LegacyContactInput = Partial<Record<keyof LegacyContactFields | 'job_title' | 'notes', string | number | null>>;

/** POST /api/contacts/bulk-update: one field for many contacts; null clears it. */
export interface BulkContactUpdate {
  ids: string[];
  contact: Partial<Record<'company' | 'department' | 'job_title', string | null>>;
}

/** The export formats (GET /api/contacts/export?format=). */
export type ExportFormat = 'vcard4' | 'vcard3' | 'google-csv' | 'outlook-csv';

// ── Duplicates, merges and import (slices 3, 5 and 6) ─────────────────
// Drafted with the model so the page and the services share one shape; the
// owners of those routes may refine them before the page is wired to them.

/** The single-value fields a merge or an import may have to choose between ('name' is all name parts together). */
export type ContactSingleField = 'name' | 'display_name' | 'organization' | 'department' | 'job_title' | 'birthday' | 'anniversary' | 'photo';

export type DuplicateConfidence = 'high' | 'medium' | 'low';

/** Why two contacts look alike; `detail` names the shared value ("anna@example.com"), never a note. */
export interface DuplicateReason {
  kind: 'uid' | 'email' | 'phone' | 'name' | 'name_order' | 'name_subset' | 'initial' | 'organization';
  detail: string;
}

export interface DuplicateMember {
  id: string;
  version: number;
  display_name: string;
  organization: string | null;
  emails: string[];
  phones: string[];
  photo: ContactPhoto | null;
}

/**
 * GET /api/contacts/duplicates?min=low|medium|high. `id` hashes the sorted
 * member ids and versions, so an action on an outdated group answers 409.
 * Low-confidence matches come as groups of two. A `large` group (over 10
 * members) is never part of "Merge all".
 */
export interface DuplicateGroup {
  id: string;
  confidence: DuplicateConfidence;
  large: boolean;
  members: DuplicateMember[];
  reasons: (DuplicateReason & { a: string; b: string })[];
  conflicts: ContactSingleField[];
}

export interface DuplicatesResponse {
  groups: DuplicateGroup[];
}

/** POST /api/contacts/duplicates/dismiss: "Not the same person" for every pair of the group. */
export interface DismissDuplicatesRequest {
  contact_ids: string[];
}

/**
 * POST /api/contacts/merges. `versions` holds each member's version as shown;
 * `choices` names, per conflicting field, the contact whose value wins
 * (400 CHOICE_REQUIRED when one is missing). Every email, phone and other
 * list value of every member is kept.
 */
export interface MergeRequest {
  contact_ids: string[];
  survivor_id?: string;
  choices?: Partial<Record<ContactSingleField, string>>;
  versions: Record<string, number>;
}

export interface MergeResult {
  merge_id: string;
  contact: ContactRecord;
  merged_ids: string[];
}

/** POST /api/contacts/merges/auto */
export interface AutoMergeRequest {
  group_ids: string[];
  min: 'high';
}

export interface AutoMergeResult {
  results: { group_id: string; status: 'merged' | 'changed' | 'needs_choice'; merge_id?: string }[];
}

/** GET /api/contacts/merges: "Recently merged" (30 days). */
export interface MergeRecord {
  id: string;
  survivor_id: string;
  survivor_name: string;
  merged: { id: string; display_name: string }[];
  created_at: string;
  purge_after: string;
  undone_at: string | null;
}

/** POST /api/contacts/merges/:id/undo */
export interface UndoMergeResult {
  restored_ids: string[];
  /** False when the survivor changed after the merge and was kept as it is. */
  survivor_restored: boolean;
}

export type ImportFormat = 'vcard4' | 'vcard3' | 'vcard21' | 'google-csv' | 'outlook-csv';
export type ImportDecisionKind = 'add' | 'merge' | 'skip';

/** A problem with one card; names the card number and property, never a value. */
export interface ImportWarning {
  /** The card's number in the file, counting from 1; null for the whole file. */
  card: number | null;
  property: string | null;
  code: string;
  message: string;
}

/** What a card of the file holds, for "Review conflicts" to show next to the existing contact. */
export interface ImportCardSummary {
  card: number;
  display_name: string;
  name: ContactName;
  organization: { name: string | null; department: string | null };
  job_title: string | null;
  birthday: PartialDate | null;
  anniversary: PartialDate | null;
  emails: string[];
  phones: string[];
  has_photo: boolean;
}

/**
 * Cards of the file that belong together: new, the same as existing contacts
 * (same UID, or identical content), or likely duplicates of existing contacts
 * or of each other. `cards` are card numbers (from 1). `existing_ids` are the
 * contacts a merge would go into (the first one). `summaries` describe the
 * group's cards; they are given for every group that is not 'new'.
 */
export interface ImportGroup {
  id: string;
  cards: number[];
  match: 'new' | 'uid' | 'identical' | 'duplicate';
  confidence: DuplicateConfidence | null;
  existing_ids: string[];
  reasons: DuplicateReason[];
  /** Single values that differ between the cards and the existing contact; a merge keeps the existing contact's. */
  conflicts: ContactSingleField[];
  default_decision: ImportDecisionKind;
  summaries?: ImportCardSummary[];
}

/** POST /api/contacts/imports (raw file): what would happen, before anything is written. */
export interface ImportSummary {
  id: string;
  format: ImportFormat;
  expires_at: string;
  /** cards: contacts read from the file; new, present (same UID or identical) and duplicates count cards. */
  counts: { cards: number; new: number; present: number; duplicates: number };
  groups: ImportGroup[];
  warnings: ImportWarning[];
  /** The first names of the file, to spot a wrong character set before writing. */
  sample_names: string[];
}

/**
 * POST /api/contacts/imports/:id/commit. A group without a decision takes its
 * default. The first commit's decisions hold: committing again (a retry after
 * a lost answer) changes nothing and answers the status. A failed import (for
 * example a restore started) resumes where it stopped when committed again.
 */
export interface ImportCommitRequest {
  decisions: { group_id: string; decision: ImportDecisionKind }[];
}

/**
 * GET /api/contacts/imports/:id (and the commit's answer). The field is
 * `state`, not `status`: a route answer's top-level `status` is its HTTP
 * status at the request boundary.
 */
export interface ImportStatus {
  id: string;
  state: 'staged' | 'committing' | 'committed' | 'failed' | 'expired';
  /** 0 to 1. */
  progress: number;
  expires_at: string;
  /** What was written so far; null before the commit started. */
  result: {
    added: number;
    merged: number;
    skipped: number;
    /** Single values that differed: UniHub's value was kept. */
    kept_conflicts: { contact_id: string; field: ContactSingleField }[];
    warnings: ImportWarning[];
  } | null;
  /** Why a failed import stopped; commit again to resume. */
  error: { code: string; message: string } | null;
}
