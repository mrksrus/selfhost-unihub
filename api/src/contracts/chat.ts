// Request and response shapes of the chat routes (F11, F14). The frontend
// imports these as types only.
//
// Chat is always end-to-end encrypted: every key, key package, Welcome,
// message, archive copy and preview is made and opened on the devices, and
// the server stores and hands out opaque bytes. Binary values travel as
// base64url text without padding. A chat device is one F5 device of the
// person that enrolled for chat (services/chat-devices.ts); the server's
// list of a person's valid chat devices is trusted.
//
// Refusals every route shares: 403 MODULE_DISABLED while Chat is off for the
// person (their switch or a policy), 403 APP_LOCK_REQUIRED for a device
// short of the lock the person's policies require for Chat, 403
// CHAT_DEVICE_WAITING for a device that has not joined Chat (below), and 404
// CONVERSATION_NOT_FOUND for a conversation the person is not a member of.
// A route only a chat's managers may use answers 403 CHAT_FORBIDDEN to its
// other members.
//
// A direct chat is two people. A group chat has a name (plain text on the
// server) and at most 100 people: either the people its managers chose, or
// everyone in one organisation group it follows (or everyone, made by an
// administrator), changing with that group. Its creator manages it; a
// followed chat is managed by the group's managers and the administrators;
// a chat with no manager left by its longest-standing active member.
// Someone added reads from the next MLS group on (joined_seq); someone
// removed, or who left, is refused at once.

/** Binary data as base64url text without padding. */
export type Base64Url = string;

import type { DeviceSummary } from './devices';

// --- The person's chat account: the history key and its backup ----------------

/**
 * The history private key wrapped with AES-GCM under a key from
 * PBKDF2-SHA-256 of the chat passphrase. The passphrase never reaches the
 * server; `wrapped` holds the IV and the ciphertext as the device wrote them.
 */
export interface ChatKeyBackup {
  format: 1;
  /** 16 to 64 random bytes. */
  salt: Base64Url;
  /** At least 600,000. */
  rounds: number;
  wrapped: Base64Url;
}

export interface ChatAccount {
  /** The public half of the person's history key (an uncompressed P-256 point): archive copies are sealed to it. */
  history_public: Base64Url;
  key_backup: ChatKeyBackup;
  updated_at: string;
}

/** GET /api/chat/account: the signed-in person's own account; null before they chose a passphrase. */
export interface ChatAccountResponse { account: ChatAccount | null }

/** POST /api/chat/account: the first passphrase; it joins the device of the request. 409 CHAT_ACCOUNT_EXISTS when the person has one. */
export interface ChatAccountCreateRequest { history_public: Base64Url; key_backup: ChatKeyBackup }

/**
 * PUT /api/chat/account/key-backup: a new passphrase for the same key, from
 * a device that holds it; the old passphrase is not needed, the account
 * password is (400 PASSWORD_REQUIRED, 403 PASSWORD_INCORRECT, 429).
 * 409 CHAT_KEY_CHANGED when history_public is no longer the account's (a
 * new key was started meanwhile); 404 CHAT_ACCOUNT_NOT_FOUND without one.
 */
export interface ChatKeyBackupUpdateRequest { current_password: string; history_public: Base64Url; key_backup: ChatKeyBackup }

/**
 * POST /api/chat/account/new-key: a new history key and passphrase when no
 * device holds the old key and its passphrase is forgotten. The account
 * password is asked as above. Every archive copy sealed to the old key is
 * dropped: nobody can open it any more. It joins the device of the request
 * and is written to the activity log (chat.new_key). Answers
 * ChatAccountResponse. 409 CHAT_DEVICE_SIGNED_IN (ChatDeviceSignedInDetails)
 * while another joined device of the person has a live session: that device
 * still holds the key, or must be signed out first.
 */
export interface ChatNewKeyRequest { current_password: string; history_public: Base64Url; key_backup: ChatKeyBackup }

// --- Chat devices and key packages --------------------------------------------------

/**
 * The Web Push key a browser's preview is sealed to (RFC 8291): its P-256
 * public key and auth secret. An Android device has none of its own; its
 * push channel's key is used.
 */
export interface ChatPreviewKey { p256dh: Base64Url; auth: Base64Url }

/**
 * POST /api/chat/devices: enrols the device of the request. A chat device
 * that device enrolled earlier is removed (it lost its keys), so every group
 * that names it is out of date. key_packages: 1 to 100 MLS key packages;
 * last_resort: the package handed out when none is left. The new chat
 * device waits (ChatDeviceState).
 */
export interface ChatDeviceEnrolRequest { preview: ChatPreviewKey | null; key_packages: Base64Url[]; last_resort: Base64Url }

/**
 * A chat device waits or has joined. A waiting device enrolled (its key
 * packages are up) but is in no chat: it is never handed out for a group,
 * gets no chat hint and no chat notification, does not make its person
 * online, and every chat route answers it 403 CHAT_DEVICE_WAITING except the
 * account (GET, POST, POST new-key), enrolling, the current device, its key
 * packages, the challenge, the proof and asking for an approval.
 *
 * Every device waits from its enrolment. It joins in one of three ways: the
 * first passphrase (creating the chat account) or "Start a new key" on it,
 * after it enrolled; the proof that it holds the history key (challenge,
 * then proof); an approval from a joined device of the same person. So a
 * person can be written to once they have set Chat up. Devices that existed
 * before waiting was introduced are joined.
 */
export type ChatDeviceState = 'waiting' | 'joined';

/** The answer of POST /api/chat/devices, GET /api/chat/devices/current, its key-packages, proof and approval routes. */
export interface ChatDeviceResponse {
  chat_device_id: string;
  /** Key packages not yet claimed, the last resort not counted. */
  key_packages: number;
  state: ChatDeviceState;
  /** When this waiting device asked for an approval that is still open (ten minutes); null otherwise. */
  approval_requested_at: string | null;
  /**
   * Once, on GET /api/chat/devices/current after an approval: the history
   * private key sealed by the approving device to the one-time key; that read
   * clears it. null otherwise.
   */
  sealed_key: Base64Url | null;
}

/**
 * POST /api/chat/devices/current/challenge: a value sealed to the person's
 * history_public (RFC 8188 aes128gcm as in RFC 8291, with the history key's
 * fixed auth secret), bound to this chat device and the current history key,
 * good for five minutes. Only a device that holds the history private key
 * can open it. 404 CHAT_ACCOUNT_NOT_FOUND without an account.
 */
export interface ChatChallengeResponse { sealed: Base64Url }

/**
 * POST /api/chat/devices/current/proof: the opened value; the device joins.
 * 403 CHAT_PROOF_INVALID for a wrong value, one made for another device or
 * key, or one older than five minutes. A joined device is answered as it is.
 */
export interface ChatProofRequest { value: Base64Url }

/**
 * POST /api/chat/devices/current/approval: a waiting device asks the person's
 * joined devices to approve it, with the public half of a one-time P-256 key
 * (uncompressed, 65 bytes) the history key is to be sealed to; both devices
 * show a code made from it. Asking again replaces the key and the ten
 * minutes start again. The joined devices get the hint chat.device and a
 * notification of kind chat_device ("Approve a new device?", for ten
 * minutes, opening /chat?approve=<chat_device_id>). A joined device is
 * answered as it is, nothing asked. 400 CHAT_APPROVAL_INVALID for a key
 * that is not one (also on approve, for the key or the sealed key).
 */
export interface ChatApprovalAskRequest { public_key: Base64Url }

/** A device as the device list names it: its record's id (for "Sign that device out", DELETE /api/devices/:id) and the fields of its label. */
export type ChatDeviceName = Pick<DeviceSummary, 'id' | 'kind' | 'app_version' | 'user_agent'>;

/** An open request of a waiting device of the person. */
export interface ChatApproval {
  chat_device_id: string;
  device: ChatDeviceName;
  public_key: Base64Url;
  requested_at: string;
}

/** GET /api/chat/devices/approvals: the person's open requests (at most ten minutes old), the latest first. */
export interface ChatApprovalsResponse { approvals: ChatApproval[] }

/**
 * POST /api/chat/devices/:id/approve (:id a chat device id): a joined device
 * of the same person hands over the history private key sealed to the
 * request's one-time key (public_key names it: a request asked again with
 * another key is not this one), and the waiting device joins. 404
 * CHAT_APPROVAL_NOT_FOUND for another person's device, a request older than
 * ten minutes, dropped, answered or for another key.
 */
export interface ChatApproveRequest { public_key: Base64Url; sealed_key: Base64Url }
export interface ChatApprovedResponse { approved: true }

/**
 * DELETE /api/chat/devices/:id/approval: "This was not me": a joined device
 * of the person drops the request; the device keeps waiting and can be
 * signed out from the device list. 404 CHAT_APPROVAL_NOT_FOUND as above.
 */
export interface ChatApprovalDroppedResponse { dropped: true }

/**
 * The live hint chat.device, to the person's joined devices and to the
 * device it names: a request was made, answered or dropped, or the device
 * joined. Refetch GET /api/chat/devices/approvals or the current device.
 */
export interface ChatDeviceHint { chat_device_id: string }

/**
 * GET /api/chat/devices/current: the chat device of the request's device;
 * 404 CHAT_DEVICE_NOT_ENROLLED when it has none (never enrolled, signed out
 * since, or removed).
 *
 * POST /api/chat/devices/current/key-packages: more key packages, and a new
 * last resort when given (it replaces the old one). At most 100 unclaimed
 * packages are kept: 400 CHAT_KEY_PACKAGES_LIMIT for more, storing none.
 */
export interface ChatKeyPackagesRequest { key_packages: Base64Url[]; last_resort?: Base64Url }

/** A valid chat device of a person in a conversation. */
export interface ChatDevice {
  chat_device_id: string;
  user_id: string;
  /** The key previews for this device are sealed to; null when it has none (an Android device without a push channel). */
  preview: ChatPreviewKey | null;
  created_at: string;
}

/**
 * GET /api/chat/conversations/:id/devices: the valid chat devices of the
 * people the conversation reaches, the caller's own included. A device is
 * valid while its F5 device exists and is enrolled and joined, and its
 * person is active.
 */
export interface ChatDevicesResponse { devices: ChatDevice[] }

/** One key package claimed for a device of a new group. */
export interface ChatClaimedKeyPackage {
  chat_device_id: string;
  user_id: string;
  key_package: Base64Url;
  /** The device had none left but its last resort, which stays for the next claim. */
  last_resort: boolean;
}

/**
 * POST /api/chat/conversations/:id/key-packages: claims one key package of
 * every valid device of the conversation's people except the caller's own,
 * for a new group. A claimed package is handed out once; a device without
 * one left (and without a last resort) is absent.
 */
export interface ChatKeyPackageClaimResponse { key_packages: ChatClaimedKeyPackage[] }

// --- Conversations, groups and messages --------------------------------------------------

/** The other person of a direct conversation. */
export interface ChatPeer {
  /** null once the person was deleted ("Deleted person"). */
  user_id: string | null;
  name: string;
  /** false while they are deactivated or once deleted: their messages show the name they carry, marked as a former colleague. */
  active: boolean;
  /** Whether the caller can write to them now; false while they are deactivated, deleted, have Chat off or have no joined chat device (not set Chat up yet, or signed out of Chat everywhere). */
  can_write: boolean;
  /** Why not, in plain words; null while they can be written to. */
  reason: string | null;
  /** Online (a page of theirs is open) when both have presence on; null when it is not shown. */
  online: boolean | null;
}

/** What a person chooses a chat notifies them of; the unread count is not affected. */
export type ChatNotify = 'all' | 'mentions' | 'none';

/** A member's role in a group chat: a manager renames it and adds or removes people (in a followed chat: renames it and stops following). */
export type ChatRole = 'manager' | 'member';

/** Days after which the chat's messages are deleted (the shortest chat.retention_days among its active members); null keeps them. */
export type ChatRetentionDays = 30 | 90 | 180 | 365;

/** What a group chat follows: one organisation group, or everyone. */
export type ChatFollow = { kind: 'group'; id: string; name: string } | { kind: 'everyone' };

interface ChatConversationBase {
  id: string;
  /** The MLS group the next message goes to; null before the first one. */
  current_group_id: string | null;
  last_seq: number;
  last_activity_at: string | null;
  /** Messages after the caller's read mark that others sent. */
  unread: number;
  /** The caller's own marks; messages before joined_seq are never served to them. */
  read_seq: number;
  delivered_seq: number;
  joined_seq: number;
  notify: ChatNotify;
  /** The retention in force; null while messages are kept. */
  retention_days: ChatRetentionDays | null;
  /**
   * When deleting under retention_days starts (or started): 24 hours after
   * the chat's retention got shorter. null while messages are kept.
   */
  retention_from: string | null;
}

export interface ChatDirectConversation extends ChatConversationBase {
  kind: 'direct';
  peer: ChatPeer;
  /** The peer's marks: read_seq is null while read receipts are off for either person. */
  peer_read_seq: number | null;
  peer_delivered_seq: number;
}

export interface ChatGroupConversation extends ChatConversationBase {
  kind: 'group';
  /** 1 to 80 characters. */
  name: string;
  /** null for a chat of chosen people. */
  follows: ChatFollow | null;
  role: ChatRole;
  /** The people the chat reaches now, the caller included. */
  member_count: number;
  /** The name of the person who added the caller; null for its creator, in a followed chat, or once that person is gone. */
  added_by: string | null;
}

export type ChatConversation = ChatDirectConversation | ChatGroupConversation;

/** GET /api/chat/conversations: the caller's conversations, the latest activity first. */
export interface ChatConversationsResponse { conversations: ChatConversation[] }

/**
 * POST /api/chat/conversations: finds or makes the one direct conversation
 * of the caller and another active person with Chat on. 400
 * CHAT_SELF for oneself; 404 USER_NOT_FOUND; 403 CHAT_UNAVAILABLE with a
 * reason when the person cannot be written to.
 */
export interface ChatConversationCreateRequest { user_id: string }
export interface ChatConversationResponse { conversation: ChatConversation; created: boolean }

/**
 * POST /api/chat/conversations with kind 'group': a new group chat (always
 * created: true), with chosen people or following one organisation group.
 *
 * People (the caller is added and manages it; naming oneself changes
 * nothing): each must be within the caller's reach (403
 * CHAT_OUT_OF_REACH): a member reaches the people who share an
 * organisation group with them, or anyone when chat.reach is
 * 'organisation' for them; an administrator reaches anyone. 404
 * USER_NOT_FOUND; 403 CHAT_UNAVAILABLE with a reason for someone deactivated
 * or with Chat off.
 *
 * Following: the caller manages that organisation group or is an
 * administrator (403 CHAT_FORBIDDEN otherwise; 404 GROUP_NOT_FOUND); only an
 * administrator follows everyone. Nobody is added or removed by hand.
 *
 * Both: 400 CHAT_NAME_INVALID unless the name is 1 to 80 characters; 400
 * CHAT_TOO_MANY_PEOPLE above 100 people (ChatTooManyPeopleDetails).
 */
export type ChatGroupChatCreateRequest =
  | { kind: 'group'; name: string; user_ids: string[] }
  | { kind: 'group'; name: string; follow: { kind: 'group'; id: string } | { kind: 'everyone' } };

/** The details of 400 CHAT_TOO_MANY_PEOPLE. */
export interface ChatTooManyPeopleDetails { limit: 100; reason: string }

/** PUT /api/chat/conversations/:id: a manager renames a group chat (400 CHAT_NOT_GROUP for a direct one). */
export interface ChatConversationUpdateRequest { name: string }
/** The answer of the rename and of POST /api/chat/conversations/:id/unfollow. */
export interface ChatConversationUpdatedResponse { conversation: ChatConversation }

/**
 * POST /api/chat/conversations/:id/unfollow: a manager of a followed chat
 * stops following; it becomes a chat of the people it has now, who keep
 * their place. Deleting the organisation group does the same. 409
 * CHAT_NOT_FOLLOWING for any other chat.
 */

/** A person of a conversation as GET /api/chat/conversations/:id/members lists them. */
export interface ChatMember {
  user_id: string;
  name: string;
  email: string;
  /** In a direct chat both are members. */
  role: ChatRole;
  /** false while deactivated. */
  active: boolean;
  /** Why their devices are not in the chat ("has not set up Chat yet", "is not signed in to Chat on any device", Chat off, deactivated); null while they are. */
  reason: string | null;
  /** As ChatPeer.online. */
  online: boolean | null;
  /** null while read receipts are off for the caller or for them. */
  read_seq: number | null;
  delivered_seq: number;
  /** Their messages start after this seq. */
  joined_seq: number;
}

/**
 * GET /api/chat/conversations/:id/members: the people the conversation
 * reaches now, managers first, then by name.
 *
 * POST /api/chat/conversations/:id/members (ChatMembersAddRequest): a
 * manager adds people, each as at creation (reach, Chat on, the limit);
 * someone already in changes nothing. 409 CHAT_FOLLOWS_GROUP in a followed
 * chat, 400 CHAT_NOT_GROUP in a direct one.
 *
 * DELETE /api/chat/conversations/:id/members/:userId: a manager removes
 * someone else (400 CHAT_SELF: leave instead). They are refused at once,
 * their marks and archive copies of the chat go, and the chat's next group
 * leaves out their devices. 404 USER_NOT_FOUND for someone not in it.
 *
 * All three answer ChatMembersResponse.
 */
export interface ChatMembersAddRequest { user_ids: string[] }
export interface ChatMembersResponse { members: ChatMember[] }

/**
 * POST /api/chat/conversations/:id/leave: the caller leaves a group chat of
 * chosen people, with their marks and archive copies of it. 409
 * CHAT_FOLLOWS_GROUP in a followed chat, 400 CHAT_NOT_GROUP in a direct one.
 */
export interface ChatLeftResponse { left: true }

/** PUT /api/chat/conversations/:id/notify: what this chat notifies the caller of. */
export interface ChatNotifyRequest { notify: ChatNotify }
export interface ChatNotifyResponse { notify: ChatNotify }

/**
 * GET /api/chat/candidates?q=<text>: for a new group chat or adding to one,
 * the active people with Chat on within the caller's reach that match (at
 * most 20, the caller left out), the organisation groups they may follow
 * (those they manage; every group for an administrator), and whether they
 * may follow everyone.
 */
export interface ChatCandidatesResponse {
  /** retention_days: the person's own chat retention; adding someone under a shorter one than the chat's shortens the chat for everyone. */
  people: { id: string; email: string; full_name: string | null; retention_days: ChatRetentionDays | null }[];
  groups: { id: string; name: string }[];
  everyone: boolean;
}

/**
 * POST /api/chat/conversations/:id/groups: a new MLS group made by the
 * caller's device from one claimed key package per device, with its one
 * Welcome. group_id is made by the device (a UUID; it is the MLS group id).
 * The server makes it current only while previous_group_id is still the
 * current one; otherwise 409 CHAT_GROUP_STALE with the current id, and the
 * device reads again. chat_device_ids: every device in the group, the
 * caller's own included.
 */
export interface ChatGroupCreateRequest {
  group_id: string;
  previous_group_id: string | null;
  welcome: Base64Url;
  chat_device_ids: string[];
}
export interface ChatGroupResponse { group_id: string; current: true }

/** The details of 409 CHAT_DEVICE_SIGNED_IN: the person's other joined devices, as Settings › Security › Devices lists them. */
export interface ChatDeviceSignedInDetails { devices: ChatDeviceName[] }

/** The details of 409 CHAT_GROUP_STALE, also answered to a message for an old group or a group whose devices are out of date. */
export interface ChatGroupStaleDetails { current_group_id: string | null }

/** A preview sealed by the sender for one recipient device (RFC 8291, the first 160 characters). */
export interface ChatPreview { chat_device_id: string; sealed: Base64Url }

/**
 * POST /api/chat/conversations/:id/messages: an MLS application message to
 * the current group. id is made by the client, so a retry stores it once.
 * replaces names the caller's own earlier message of this conversation that
 * this one edits. archive: the sender's own archive copy, sealed to their
 * history key. 409 CHAT_GROUP_STALE (ChatGroupStaleDetails) when group_id is
 * not current or its devices are not exactly the valid devices of the
 * conversation's people; 403 CHAT_UNAVAILABLE when the peer of a direct chat
 * cannot be written to (in a group chat, a member who cannot be reached
 * does not block it).
 *
 * mentions: in a group chat, up to 20 of its people (not the sender) who
 * are notified as mentioned; the server keeps no list. 400
 * CHAT_MENTION_INVALID for anyone else, more than 20, or in a direct chat.
 *
 * attachments: up to 20 ids (ten files and a preview for each picture among
 * them) of the sender's uploads to this chat not yet
 * tied to a message (POST .../attachments); the message is tied to them, and
 * deleting it deletes them. 400 CHAT_ATTACHMENT_INVALID otherwise; an edit
 * names none.
 */
export interface ChatMessageCreateRequest {
  id: string;
  group_id: string;
  replaces: string | null;
  /** The version of the object inside the ciphertext. */
  format: number;
  ciphertext: Base64Url;
  archive: Base64Url;
  previews: ChatPreview[];
  mentions?: string[];
  attachments?: string[];
}

/** One entry of a conversation, in seq order. */
export interface ChatMessage {
  id: string;
  seq: number;
  /** null for a 'call' entry, which belongs to no MLS group. */
  group_id: string | null;
  /** null once the sender was deleted. */
  sender_user_id: string | null;
  sender_chat_device_id: string | null;
  /**
   * 'delete' entries name in `replaces` the message that was deleted for both
   * sides. 'call' entries are written by the server when a call ends: no
   * ciphertext, no group, the caller as sender; nobody can edit or delete one.
   */
  kind: 'message' | 'delete' | 'call';
  replaces: string | null;
  format: number;
  /** null once the message was deleted. */
  ciphertext: Base64Url | null;
  created_at: string;
  /** Only on a 'call' entry. */
  call?: ChatCallEntry;
}
export interface ChatMessageResponse { message: ChatMessage }

/** The Welcome of a group the caller's device is in and has not confirmed joining. */
export interface ChatWelcome { group_id: string; welcome: Base64Url; created_at: string }

/** A sender of the entries in a ChatMessagesResponse, as the directory knows them now. */
export interface ChatSender {
  user_id: string;
  name: string;
  /** false while deactivated: their messages show the name they carry, marked as a former colleague (a deleted sender has no user_id). */
  active: boolean;
}

/**
 * GET /api/chat/conversations/:id/messages?after=<seq>&limit=<n>: entries
 * after a seq (never before the caller's joined_seq), with the Welcomes of
 * the groups the device has not joined, oldest first, and the senders of
 * these entries.
 */
export interface ChatMessagesResponse { messages: ChatMessage[]; welcomes: ChatWelcome[]; senders: ChatSender[]; last_seq: number; more: boolean }

/** POST /api/chat/groups/:id/joined: the device of the request confirms it joined the group from its Welcome. */
export interface ChatGroupJoinedResponse { joined: true }

/**
 * DELETE /api/chat/messages/:id: the sender deletes a message for both
 * sides, with its edits and archive copies; a 'delete' entry tells every
 * device. 403 POLICY_FORBIDS while deleting for good is forbidden (bin.delete);
 * 404 CHAT_MESSAGE_NOT_FOUND for anyone else's message.
 */
export interface ChatMessageDeletedResponse { deleted: true; seq: number }

// --- Files ---------------------------------------------------------------------------------

/**
 * A file sent in a chat, encrypted on the device (RFC 8188 aes128gcm in
 * records of 64 kB, a random key per file, the key inside the message). A
 * picture's preview is a second attachment. The server sees its size only.
 */
export interface ChatAttachment {
  id: string;
  conversation_id: string;
  size_bytes: number;
  /** null until a message names it. */
  message_id: string | null;
  created_at: string;
}

/**
 * POST /api/chat/conversations/:id/attachments?id=<uuid>: the body is the
 * file's ciphertext (application/octet-stream), at most 101 MiB; id is made
 * by the client, so a retry by the same person to the same chat answers the
 * stored one (409 CHAT_ATTACHMENT_EXISTS otherwise). 413
 * CHAT_FILE_TOO_LARGE (ChatFileTooLargeDetails) above the uploader's
 * chat.attachment_max_mb. An upload no message names is deleted after a day.
 */
export interface ChatAttachmentResponse { attachment: ChatAttachment }

/** The details of 413 CHAT_FILE_TOO_LARGE. */
export interface ChatFileTooLargeDetails { limit_mb: number; reason: string }

/*
 * GET /api/chat/attachments/:id: the ciphertext as stored
 * (application/octet-stream, Cache-Control: no-store), to a member of its
 * chat whose joined_seq is before its message, and to its uploader before
 * the message is posted. 404 CHAT_ATTACHMENT_NOT_FOUND for anyone else.
 */

// --- Retention (administrators) -------------------------------------------------------------

/**
 * GET /api/admin/chat/retention-preview?days=<30|90|180|365>&group_id=<id>
 * (permission server.settings): before saving chat.retention_days for
 * Everyone (no group_id) or a group, what that value would delete once its
 * wait is over: the messages and files older than it in the chats it would
 * shorten. Changes nothing. Without days the three counts are 0.
 */
export interface ChatRetentionPreviewResponse {
  messages: number;
  files: number;
  conversations: number;
  /** The chats that wait to start deleting under a shorter retention, and when the first of them starts; null while none waits. */
  waiting: number;
  waiting_from: string | null;
}

/**
 * POST /api/admin/chat/retention/apply-now: the owner only (403
 * OWNER_REQUIRED), with their password; every chat waiting to delete under a
 * shorter retention starts now. Written to the activity log.
 */
export interface ChatRetentionApplyNowRequest { current_password: string }
export interface ChatRetentionApplyNowResponse { conversations: number }

/** PUT /api/chat/conversations/:id/marks: moves the caller's marks forward (never back, never past last_seq). */
export interface ChatMarksRequest { read_seq?: number; delivered_seq?: number }
export interface ChatMarksResponse { read_seq: number; delivered_seq: number }

// --- The personal archive -------------------------------------------------------------------

/** A message sealed to the person's history key by one of their devices. */
export interface ChatArchiveCopy { message_id: string; sealed: Base64Url }

/** POST /api/chat/archive: the caller's own copies, up to 200 at once; a copy already stored stays. */
export interface ChatArchiveRequest { copies: ChatArchiveCopy[] }
export interface ChatArchiveStoredResponse { stored: number }

/** GET /api/chat/archive?cursor=<cursor>&limit=<n>: the caller's copies for a restore, in conversation and seq order. */
export interface ChatArchiveEntry extends ChatArchiveCopy { conversation_id: string; seq: number }
export interface ChatArchiveResponse { copies: ChatArchiveEntry[]; cursor: string | null }

// --- Calls ---------------------------------------------------------------------------------

/*
 * Voice calls between the two people of a direct chat. Media is peer to
 * peer (WebRTC, DTLS-SRTP) where the devices connect directly; the server
 * carries the ring, the signals (offer, answer, candidates as opaque text)
 * and the call's record, and passes on the encrypted sound when they cannot
 * (GET /api/chat/calls/:id/media).
 * Every call route names the call by id and the call names its
 * conversation. One call per person at a time.
 *
 * Refusals every call route shares, besides the chat routes' own: 404
 * CHAT_CALL_NOT_FOUND for anyone who is not one of the call's two people,
 * and 403 CHAT_CALL_DEVICE for a device of theirs that is not an end of the
 * call where the route needs one (the calling device, and once answered the
 * answering device).
 *
 * The live hint chat.call (ChatCallHint, module chat, joined devices only)
 * goes to both people's pages when a call starts, is answered or ends, and to
 * the other end when a signal is posted: refetch GET /api/chat/calls/current
 * or the call's signals.
 */

/** ringing (45 seconds at most), active once answered, ended. */
export type ChatCallState = 'ringing' | 'active' | 'ended';

/**
 * How a call ended: answered (then hung up by either), missed (nobody answered
 * within the ring time), cancelled (the caller ended it while it rang),
 * declined (the callee ended it while it rang), busy (the callee was in
 * another call), failed (a device reported that it could not connect or lost
 * the connection, the devices stopped sending signs of life, or the server
 * restarted from a backup). A missed, cancelled or busy call is a missed call
 * for the callee: a call_missed notification, and its entry counts as unread
 * for them.
 */
export type ChatCallOutcome = 'answered' | 'missed' | 'cancelled' | 'declined' | 'busy' | 'failed';

/** A call as one of its two people sees it from the request's device. */
export interface ChatCall {
  id: string;
  conversation_id: string;
  /** null once the person was deleted. */
  caller_user_id: string | null;
  callee_user_id: string | null;
  /** The directory's names now; 'Deleted person' once deleted. */
  caller_name: string;
  callee_name: string;
  state: ChatCallState;
  /** null until it ended. */
  outcome: ChatCallOutcome | null;
  /**
   * Whether the request's device is an end of the call: the calling device,
   * or the device that answered. false on the callee's devices while it
   * rings (any of them may answer) and on every other device of the two
   * people; an active call with this_device false on the callee's side was
   * answered on another device.
   */
  this_device: boolean;
  created_at: string;
  answered_at: string | null;
  ended_at: string | null;
}

/**
 * The call of a 'call' chat entry (ChatMessage.call). Its length is
 * ended_at minus answered_at for an answered call.
 */
export interface ChatCallEntry {
  call_id: string;
  outcome: ChatCallOutcome;
  /** null once the person was deleted (the entry stays). */
  caller_user_id: string | null;
  callee_user_id: string | null;
  started_at: string;
  answered_at: string | null;
  ended_at: string;
}

/**
 * POST /api/chat/calls: calls the other person of a direct chat, named by the
 * person (the direct chat is found or made, as POST /api/chat/conversations
 * does) or by the chat. The request's device is the calling device; it then
 * posts its offer as the first signal. The callee's joined devices ring for
 * 45 seconds: their pages by the hint, Android apps that can ring by a
 * notification of kind call.
 *
 * Refused: 400 CHAT_SELF; 400 CHAT_CALL_INVALID without exactly one of the
 * two, 400 CHAT_NOT_DIRECT for a group chat; 404 USER_NOT_FOUND; 403
 * CHAT_UNAVAILABLE with the reason when the callee cannot be written to
 * (deactivated, Chat off, no joined device); 403 POLICY_FORBIDS
 * (PolicyForbidsDetails, policy chat.calls) when calls are forbidden for the
 * caller or for the callee, with the reason; 409 CHAT_CALL_IN_PROGRESS while
 * the caller has a ringing or active call; 409 CHAT_CALL_BUSY while the
 * callee has one: the callee then gets a missed call (an ended call with
 * outcome busy, its entry and a call_missed notification).
 *
 * When the callee is already calling the caller, nothing new starts: the
 * answer is that ringing call (started false), to be answered.
 */
export type ChatCallStartRequest = { user_id: string } | { conversation_id: string };
export interface ChatCallStartResponse { call: ChatCall; started: boolean }

/** GET /api/chat/calls/current: the person's ringing or active call; null when there is none. */
export interface ChatCurrentCallResponse { call: ChatCall | null }

/**
 * POST /api/chat/calls/:id/answer: a joined device of the callee answers a
 * ringing call; it becomes the call's other end and reads the offer next.
 * The first answer wins; the person's other devices stop ringing. 409
 * CHAT_CALL_ANSWERED once another device answered (the same device answering
 * again is answered as it is), 409 CHAT_CALL_ENDED once it ended; 403
 * CHAT_CALL_DEVICE for the caller.
 */
export interface ChatCallAnswerResponse { call: ChatCall }

/**
 * POST /api/chat/calls/:id/end: declines, cancels or hangs up, with failed
 * when the device could not connect or lost the connection. While it rings:
 * the calling device (cancelled) or any joined device of the callee
 * (declined); once answered: either end (answered, or failed). The signals
 * are deleted and the call's entry is written. An ended call is answered as
 * it is.
 */
export interface ChatCallEndRequest { failed?: boolean }
export interface ChatCallResponse { call: ChatCall }

/**
 * POST /api/chat/calls/:id/signals: a signal from one end to the other, text
 * the devices define (an offer, an answer, a batch of candidates, a request
 * for a restart), at most 16,384 characters. The calling device may post
 * while it rings; the answering device once it answered. 400
 * CHAT_CALL_SIGNAL_INVALID; 409 CHAT_CALL_ENDED; 409 CHAT_CALL_SIGNALS_LIMIT
 * after 1,000 signals in one call. The server logs none of it and deletes
 * every signal when the call ends.
 */
export interface ChatCallSignalRequest { payload: string }
export interface ChatCallSignalPostedResponse { id: number }

/** A signal from the other end. */
export interface ChatCallSignal { id: number; payload: string; created_at: string }

/**
 * GET /api/chat/calls/:id/signals?after=<id>: the other end's signals after
 * that id, oldest first (at most 100); `after` is the cursor for the next
 * read (the last id answered, or the one asked). Either end; an ended call
 * has none.
 */
export interface ChatCallSignalsResponse { signals: ChatCallSignal[]; after: number }

/**
 * POST /api/chat/calls/:id/alive: an end's sign of life, every 30 seconds
 * while the call rings or is active. An active call without one for 90
 * seconds ends as failed. Answers the call as it is now.
 */

/** The live hint chat.call. */
export interface ChatCallHint { call_id: string }

/*
 * GET /api/chat/calls/:id/media: the call's sound through UniHub, a
 * WebSocket (RFC 6455) of an end of an active call, for while its devices
 * cannot connect directly. The server passes every binary message from one
 * end to the other end's socket unchanged and reads, stores and logs none of
 * it; the devices encrypt it with a key the server cannot compute. Each end
 * opens its own socket; a second socket of the same device replaces the first
 * (close 4000), as after a reconnect.
 *
 * Refused before the handshake, as an ordinary JSON answer: the chat routes'
 * refusals and the call routes' shared ones; 409 CHAT_CALL_ENDED; 409
 * CHAT_CALL_NOT_ACTIVE while it rings; 503 CHAT_CALL_MEDIA_BUSY when UniHub
 * carries 200 sockets already; 400 CHAT_CALL_MEDIA_INVALID for a malformed
 * handshake; 426 CHAT_CALL_MEDIA_UPGRADE for a request that passed every
 * check but arrived without its Upgrade: a reverse proxy that does not pass
 * WebSockets (a page tells that from a failed socket with a plain GET).
 *
 * Messages: binary only, at most 1,024 bytes each, unfragmented, no
 * extensions or subprotocols. At most 60 a second from an end, in bursts of
 * 120; more are dropped. While an end's socket has more than 8 KiB unsent,
 * messages to it are dropped. The server pings every 25 seconds; browsers
 * answer on their own.
 *
 * The devices' frame (ChatCallMediaFrame) names its sender and key so that
 * group calls can forward one end's frames to every other end.
 *
 * GET /api/chat/calls/check: the same handshake, accepted and closed with
 * 1000 at once; for the Server page to tell whether WebSockets reach
 * UniHub. Open to a device that has not joined Chat; a plain GET answers 426
 * CHAT_CALL_MEDIA_UPGRADE.
 */

/**
 * Why the server closed a media socket:
 * 1000 the call ended (or the check is done); 1001 the server is stopping;
 * 1002 a protocol error (an unmasked frame, reserved bits, an unknown opcode,
 * a bad control frame); 1003 a text or fragmented message; 1008 the session
 * ended or this device is no longer an end of the call (sign-out, a revoked
 * session, a deactivated person, checked at once on sign-out and every 25
 * seconds); 1009 a message over 1,024 bytes; 4000 replaced by a newer
 * socket of the same device; 4001 the end sent nothing for 60 seconds or did
 * not read for 15 seconds.
 */
export type ChatCallMediaClose = 1000 | 1001 | 1002 | 1003 | 1008 | 1009 | 4000 | 4001;

/**
 * A media message as the devices write it (the server never reads it): a
 * 7-byte header in clear, [version 1][sender 1][key 1][sequence 4,
 * big-endian], then the AES-GCM ciphertext of [kind 1][Opus packet] with its
 * 16-byte tag, the header as additional data. version 1; sender and key 0 in
 * a call between two people.
 */
export interface ChatCallMediaFrame { version: 1; sender: number; key: number; sequence: number }

/*
 * Notifications (services/notifications.ts), to joined chat devices only:
 *
 * - call: to the callee's Android apps that can ring (their device reported
 *   the capability `calls: true` in PUT /api/devices/current/lock), sent at
 *   once. The payload carries `call: { id, event }`: 'ring' when it starts
 *   (expires with the ring time), 'end' once it stopped ringing (answered on
 *   another device or ended; never sent to the device that answered), with
 *   a dedupe key of its own for each. `title` is the caller's name at the
 *   person's Chat detail 'full' or 'sender', 'Incoming call' at 'none' or on
 *   a device whose lock hides Chat; url /call?id=<call id>. Browsers and
 *   older apps ring only in an open page, from the hint.
 * - call_missed: to every joined device of the callee, for a missed,
 *   cancelled or busy call: "Missed call from <name>" ("Missed call" at
 *   'none'), for a day or until its entry is read; url /chat?c=<conversation>.
 */
export interface ChatCallNotification { id: string; event: 'ring' | 'end' }

/** GET /api/admin/settings/signup-mode also answers whether a variable of the removed relay for calls is still set, for the Server page. */
export interface ServerCallsRelayLeftover { calls_relay_leftover: boolean }
