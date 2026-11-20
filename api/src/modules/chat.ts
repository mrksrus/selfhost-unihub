import type { BackupDataClass } from '../contracts/backup';

// The manifest of the Chat module (F11): what the module catalog, the page
// list and the data inventory read about it. Data only, so every registry
// can import it without a cycle; the routes are routes/chat-devices.ts with
// module 'chat' on their specs.
//
// Chat has no recovery section: no personal backup carries it, because the
// server cannot write a copy that opens outside UniHub (it cannot read the
// messages) and a conversation names another person. Chat has its own
// recovery: the archive and the passphrase. The instance backup's dump
// carries every table as stored, ciphertext as ciphertext.

interface ChatTable {
  owner: 'user' | 'organisation';
  shareable: boolean;
  dataClass: BackupDataClass;
  restore: string;
  columns: string;
}

const INSTANCE_ONLY = 'Never in a personal backup; the instance backup carries it as stored.';

const CHAT_MANIFEST = Object.freeze({
  module: Object.freeze({ id: 'chat', label: 'Chat', backgroundSupported: false, recoverySection: null }),
  pages: Object.freeze([Object.freeze({ id: 'chat', label: 'Chat', module: 'chat' })]),
  // Upgrade step 31 (chat-migration.ts).
  introducedIn: 31,
  excludedReason: 'Chats are not in a personal backup: the server cannot read them, and they are restored with the chat passphrase. Only the instance backup carries them, as stored.',
  tables: Object.freeze<Record<string, ChatTable>>({
    chat_accounts: { owner: 'user', shareable: false, dataClass: 'ciphertext', restore: `${INSTANCE_ONLY} The history key stays wrapped by the passphrase.`,
      columns: 'user_id history_public key_backup backup_salt backup_rounds backup_format created_at updated_at' },
    chat_devices: { owner: 'user', shareable: false, dataClass: 'installation', restore: `${INSTANCE_ONLY} An instance restore deletes the devices, which removes every chat device; devices enrol again.`,
      columns: 'id user_id device_id preview_p256dh preview_auth created_at' },
    chat_key_packages: { owner: 'user', shareable: false, dataClass: 'installation', restore: `${INSTANCE_ONLY} A removed device's packages are never handed out.`,
      columns: 'id chat_device_id key_package last_resort created_at' },
    chat_conversations: { owner: 'organisation', shareable: true, dataClass: 'org', restore: `${INSTANCE_ONLY} Its people reach it through their grants.`,
      columns: 'id kind direct_key current_group_id last_seq created_by created_at updated_at' },
    chat_members: { owner: 'user', shareable: false, dataClass: 'org', restore: `${INSTANCE_ONLY} It goes with its conversation or person.`,
      columns: 'conversation_id user_id read_seq delivered_seq joined_seq updated_at' },
    chat_groups: { owner: 'organisation', shareable: false, dataClass: 'installation', restore: `${INSTANCE_ONLY} After an instance restore the next message makes a new group.`,
      columns: 'id conversation_id welcome created_at' },
    chat_group_devices: { owner: 'organisation', shareable: false, dataClass: 'installation', restore: `${INSTANCE_ONLY} It goes with its group or chat device.`,
      columns: 'group_id chat_device_id joined_at' },
    chat_messages: { owner: 'organisation', shareable: false, dataClass: 'ciphertext', restore: `${INSTANCE_ONLY} Only the people of the conversation can read it.`,
      columns: 'id conversation_id seq group_id sender_user_id sender_chat_device_id kind replaces format ciphertext created_at' },
    chat_archive: { owner: 'user', shareable: false, dataClass: 'ciphertext', restore: `${INSTANCE_ONLY} It opens only with its person's history key.`,
      columns: 'user_id message_id sealed created_at' },
  }),
});

export { CHAT_MANIFEST };
