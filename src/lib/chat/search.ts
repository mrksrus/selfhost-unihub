// Chat search: a scan of the chats this device holds, already decrypted in
// its store. The server cannot search them.
// shortcut: a scan of every message (about a second for 100,000); an index when stores grow past that.
import type { ChatSearchResult, ChatThreadItem } from './types';

const LIMIT = 200;

/** Chats whose name holds `query`, then messages whose text holds it, newest first; case does not count. */
export function searchChats(query: string, chats: { id: string; name: string; items: ChatThreadItem[] }[]): ChatSearchResult[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const find = (line: string): [number, number] | null => {
    const at = line.toLocaleLowerCase().indexOf(needle);
    return at < 0 ? null : [at, at + needle.length];
  };
  const named = chats.flatMap(chat => {
    const match = find(chat.name);
    return match ? [{ conversation_id: chat.id, chat_name: chat.name, message_id: null, sender_name: null, created_at: null, line: chat.name, match }] : [];
  });
  const messages = chats.flatMap(chat => chat.items.flatMap(item => {
    const match = item.kind === 'message' && item.text !== null ? find(item.text) : null;
    return match && item.kind === 'message' ? [{ conversation_id: chat.id, chat_name: chat.name, message_id: item.id, sender_name: item.sender_name,
      created_at: item.created_at, line: item.text!, match }] : [];
  })).sort((a, b) => b.created_at.localeCompare(a.created_at));
  return [...named, ...messages].slice(0, LIMIT);
}
