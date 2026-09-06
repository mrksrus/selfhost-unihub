import type { User } from '@/contexts/auth-context';

type Row = Record<string, unknown>;
export interface OfflineSnapshot {
  version: 1;
  userId: string;
  savedAt: string;
  bytes: number;
  contacts: Row[];
  events: Row[];
  calendars: Row[];
  calendarAccounts: Row[];
  mailAccounts: Row[];
  folders: Row[];
  emails: Row[];
  user?: User;
}
interface SnapshotPointer { epoch: string; key: string; userId: string }
const DATABASE = 'unihub-offline-v1';
const STORE = 'snapshot';
const CHANGE_KEY = 'unihub:offline-change';
const EPOCH_KEY = 'unihub:offline-epoch';
const OWNER_PREFIX = 'unihub:offline-owner:';
export const OFFLINE_MAX_BYTES = 32 * 1024 * 1024;
let account: string | null = null;
let offlineMode = false;
let memory: { key: string; snapshot: OfflineSnapshot } | null = null;
let generation = 0;
let saveQueue: Promise<unknown> = Promise.resolve();

const identifier = () => crypto.randomUUID();
export function setOfflineAccount(userId: string | null) {
  if (account !== userId) generation++;
  account = userId;
}
export function setOfflineMode(value: boolean) {
  if (offlineMode === value) return;
  offlineMode = value;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('unihub-offline-mode'));
}
export function isOfflineMode() { return offlineMode; }

function announceChange() {
  window.dispatchEvent(new Event('unihub-offline-change'));
  try { localStorage.setItem(CHANGE_KEY, identifier()); } catch { /* Optional cross-tab signal. */ }
}
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === CHANGE_KEY || event.key === EPOCH_KEY) {
    memory = null;
    generation++;
    window.dispatchEvent(new Event('unihub-offline-change'));
  }
});

function currentPointer(): SnapshotPointer | null {
  try {
    const epoch = localStorage.getItem(EPOCH_KEY);
    if (!epoch) return null;
    const pointer = JSON.parse(localStorage.getItem(OWNER_PREFIX + epoch) || 'null');
    return pointer?.epoch === epoch && typeof pointer.key === 'string' && typeof pointer.userId === 'string' ? pointer : null;
  } catch { return null; }
}
function ensureEpoch() {
  const existing = localStorage.getItem(EPOCH_KEY);
  if (existing) return existing;
  const epoch = identifier();
  localStorage.setItem(EPOCH_KEY, epoch);
  return epoch;
}
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Offline storage is unavailable in this browser.')); return; }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onerror = () => reject(request.error || new Error('Offline storage could not be opened.'));
    request.onblocked = () => reject(new Error('Close other UniHub tabs to update offline storage.'));
    request.onsuccess = () => resolve(request.result);
  });
}
async function deleteRecords(keys: string[]) {
  if (!keys.length) return;
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    keys.forEach(key => tx.objectStore(STORE).delete(key));
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error('Could not remove stored offline data.')); };
  });
}
async function storedSnapshot(): Promise<OfflineSnapshot | null> {
  const pointer = currentPointer();
  if (!pointer) { memory = null; return null; }
  if (memory?.key === pointer.key) return memory.snapshot;
  const observed = generation;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(pointer.key);
    let snapshot: OfflineSnapshot | null = null;
    request.onsuccess = () => {
      const value = request.result;
      snapshot = value?.version === 1 && value.userId === pointer.userId && value.user?.id === pointer.userId ? value : null;
    };
    tx.oncomplete = () => {
      db.close();
      if (generation !== observed || currentPointer()?.key !== pointer.key) { resolve(null); return; }
      memory = snapshot ? { key: pointer.key, snapshot } : null;
      resolve(snapshot);
    };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
  });
}
export async function loadOfflineSession(): Promise<{ user: User; savedAt: string } | null> {
  const snapshot = await storedSnapshot().catch(() => null);
  return snapshot?.user ? { user: snapshot.user, savedAt: snapshot.savedAt } : null;
}
export async function getOfflineSnapshotInfo() {
  const expectedAccount = account;
  const snapshot = await storedSnapshot().catch(() => null);
  if (!snapshot || account !== expectedAccount || snapshot.userId !== account) return null;
  return { savedAt: snapshot.savedAt, bytes: snapshot.bytes, emails: snapshot.emails.length, contacts: snapshot.contacts.length, events: snapshot.events.length };
}
export async function clearOfflineData() {
  generation++;
  memory = null;
  const pointers: Array<{ storageKey: string; value: string; recordKey: string }> = [];
  // Rotating the epoch is the durable tombstone. A pending writer can publish
  // only to its old epoch and can never restore access after logout/clear.
  for (let index = 0; index < localStorage.length; index++) {
    const storageKey = localStorage.key(index);
    if (!storageKey?.startsWith(OWNER_PREFIX)) continue;
    const value = localStorage.getItem(storageKey);
    try {
      const pointer = JSON.parse(value || 'null');
      if (typeof pointer?.key === 'string') pointers.push({ storageKey, value: value!, recordKey: pointer.key });
    } catch { /* Ignore malformed legacy metadata. */ }
  }
  localStorage.setItem(EPOCH_KEY, identifier());
  localStorage.removeItem('unihub:offline-owner');
  announceChange();
  try {
    await deleteRecords(pointers.map(pointer => pointer.recordKey));
    pointers.forEach(pointer => {
      if (localStorage.getItem(pointer.storageKey) === pointer.value) localStorage.removeItem(pointer.storageKey);
    });
  } catch {
    throw new Error('Offline access is disabled, but the stored copy could not be removed. Close other tabs and retry clearing device data.');
  }
}

async function saveSnapshot(snapshot: OfflineSnapshot, user: User, epoch: string, observed: number, signal?: AbortSignal) {
  const stillCurrent = () => !signal?.aborted && generation === observed && account === user.id && localStorage.getItem(EPOCH_KEY) === epoch;
  if (!stillCurrent()) throw new Error('The account or offline setting changed. Offline data was not saved.');
  if (snapshot.version !== 1 || snapshot.userId !== user.id) throw new Error('Offline data belongs to a different account.');
  for (const name of ['contacts', 'events', 'calendars', 'calendarAccounts', 'mailAccounts', 'folders', 'emails'] as const) {
    if (!Array.isArray(snapshot[name]) || snapshot[name].some(row => row.user_id != null && row.user_id !== user.id)) throw new Error('The server returned an invalid offline snapshot.');
  }
  if (snapshot.emails.length > 100) throw new Error('Offline mail exceeds the 100-message limit.');
  const safeUser: User = { id: user.id, email: user.email, full_name: user.full_name, avatar_url: user.avatar_url, timezone: user.timezone, role: user.role };
  const next = { ...snapshot, user: safeUser };
  let bytes: number;
  while ((bytes = new TextEncoder().encode(JSON.stringify(next)).length) !== next.bytes) next.bytes = bytes;
  if (bytes > OFFLINE_MAX_BYTES) throw new Error('Offline data exceeds the 32 MiB budget. Your previous snapshot was kept.');
  const key = 'snapshot:' + identifier();
  const db = await openDatabase();
  if (!stillCurrent()) { db.close(); throw new Error('The account changed. Offline data was not saved.'); }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(next, key);
    const abort = () => { try { tx.abort(); } catch { /* Transaction already finished. */ } };
    signal?.addEventListener('abort', abort, { once: true });
    const finish = () => { signal?.removeEventListener('abort', abort); db.close(); };
    tx.oncomplete = () => { finish(); resolve(); };
    tx.onerror = tx.onabort = () => { finish(); reject(new Error('Device storage is full or unavailable. Your previous snapshot was kept.')); };
  });
  if (!stillCurrent()) {
    await deleteRecords([key]).catch(() => {});
    throw new Error('The account or offline setting changed during sync.');
  }
  const previous = currentPointer();
  const pointer: SnapshotPointer = { epoch, key, userId: user.id };
  try { localStorage.setItem(OWNER_PREFIX + epoch, JSON.stringify(pointer)); } catch {
    await deleteRecords([key]).catch(() => {});
    throw new Error('Device storage is unavailable. Your previous snapshot was kept.');
  }
  // The epoch may change in another tab between the check and publication.
  // Its owner lives at a different key, so this writer cannot replace it.
  if (!stillCurrent()) {
    await deleteRecords([key]).catch(() => {});
    throw new Error('The account or offline setting changed during sync.');
  }
  memory = { key, snapshot: next };
  announceChange();
  if (previous && previous.key !== key) await deleteRecords([previous.key]).catch(() => {});
}
export interface OfflineSaveToken { epoch: string; generation: number; userId: string }
export function captureOfflineSave(userId: string): OfflineSaveToken {
  if (account !== userId) throw new Error('The account changed. Offline data was not saved.');
  return { epoch: ensureEpoch(), generation, userId };
}
export function saveOfflineSnapshot(snapshot: OfflineSnapshot, user: User, signal?: AbortSignal, token?: OfflineSaveToken): Promise<void> {
  let lease: OfflineSaveToken;
  try { lease = token ?? captureOfflineSave(user.id); } catch { return Promise.reject(new Error('Device storage is unavailable. Offline access was not enabled.')); }
  if (lease.userId !== user.id) return Promise.reject(new Error('The account changed. Offline data was not saved.'));
  const { epoch, generation: observed } = lease;
  const operation = saveQueue.catch(() => {}).then(() => saveSnapshot(snapshot, user, epoch, observed, signal));
  saveQueue = operation;
  return operation;
}

const text = (value: unknown) => String(value ?? '');
const truthy = (value: unknown) => value === true || value === 1 || value === '1';
const numberParam = (params: URLSearchParams, key: string, fallback: number, cap: number) => {
  const value = Number.parseInt(params.get(key) || '',10); return Number.isFinite(value) ? Math.min(Math.max(0,value),cap) : fallback;
};
function mailRows(snapshot: OfflineSnapshot, params: URLSearchParams) {
  return snapshot.emails.filter(row => {
    const folder = params.get('folder');
    const accountId = params.get('account_id');
    if (accountId && accountId !== 'all' && row.mail_account_id !== accountId) return false;
    if (folder && folder !== 'all' && folder !== 'starred' && row.folder !== folder) return false;
    if (folder === 'starred' && !truthy(row.is_starred)) return false;
    if (params.has('is_read') && truthy(row.is_read) !== (params.get('is_read') === 'true')) return false;
    if (params.has('is_starred') && truthy(row.is_starred) !== (params.get('is_starred') === 'true')) return false;
    const query = (params.get('search') || '').trim().toLowerCase();
    return !query || [row.subject,row.from_name,row.from_address,row.body_text].some(value=>text(value).toLowerCase().includes(query));
  }).sort((a, b) => Date.parse(text(b.received_at)) - Date.parse(text(a.received_at)) || text(b.id).localeCompare(text(a.id)));
}
export function resolveOfflineEndpoint(snapshot: OfflineSnapshot, endpoint: string): {data: unknown} | {error: string;status?:number} | null {
  const url = new URL(endpoint,'https://offline.invalid');
  const path = url.pathname.replace(/^\/api(?=\/)/,'');
  const params = url.searchParams;
  if (path.startsWith('/auth/')) return null;
  if (path === '/contacts') {
    let rows = snapshot.contacts;
    const group = params.get('group');
    if (group === 'name_only' || group === 'number_or_email_only') {
      rows = rows.filter(row => {
        const hasName = [row.first_name, row.last_name].some(value => text(value).trim());
        const hasAddress = ['email', 'email2', 'email3', 'phone', 'phone2', 'phone3'].some(key => text(row[key]).trim());
        return group === 'name_only' ? hasName && !hasAddress : !hasName && hasAddress;
      });
    }
    const query = (params.get('q') || '').toLowerCase();
    if(query) rows=rows.filter(row=>['first_name','last_name','email','email2','email3','phone','phone2','phone3','company'].some(key=>text(row[key]).toLowerCase().includes(query)));
    const offset=numberParam(params,'offset',0,10000000), limit=numberParam(params,'limit',2000,2000);
    return {data:{contacts:rows.slice(offset,offset+limit),has_more:offset+limit<rows.length,offset}};
  }
  if (path === '/calendar/accounts') return {data:{accounts:snapshot.calendarAccounts}};
  if (path === '/calendar/calendars') return {data:{calendars:snapshot.calendars.filter(row=>!params.get('account_id')||row.account_id===params.get('account_id'))}};
  const eventMatch = path.match(/^\/calendar\/events\/([^/]+)$/);
  if (eventMatch) {
    const event = snapshot.events.find(row => row.id === decodeURIComponent(eventMatch[1]));
    return event ? { data: { event } } : { error: 'This event is not in your offline snapshot.', status: 404 };
  }
  if (path === '/calendar/events') {
    const ids=(params.get('calendar_ids')||'').split(',').map(id=>id.trim()).filter(Boolean);
    const calendars = new Map(snapshot.calendars.map(row=>[row.id,row]));
    const events=snapshot.events.filter(row=>{
      const calendar=calendars.get(row.calendar_id);
      if(params.get('include_todos')!=='true'&&truthy(row.is_todo_only))return false;
      if(params.get('include_done')==='false'&&['done','cancelled'].includes(text(row.todo_status)))return false;
      if(params.get('visible_only')==='true'&&calendar?.is_visible != null&&!truthy(calendar.is_visible))return false;
      if(params.get('respect_auto_todo')==='true'&&calendar?.auto_todo_enabled != null&&!truthy(calendar.auto_todo_enabled))return false;
      if(ids.length&&!ids.includes(text(row.calendar_id)))return false;
      if(params.get('range_start')&&Date.parse(text(row.end_time))<Date.parse(params.get('range_start')!))return false;
      if(params.get('range_end')&&Date.parse(text(row.start_time))>Date.parse(params.get('range_end')!))return false;
      return true;
    });
    return {data:{events:events.sort((a,b)=>Date.parse(text(a.start_time))-Date.parse(text(b.start_time)))}};
  }
  if(path === '/mail/accounts') return {data:{accounts:snapshot.mailAccounts.map(row=>({...row,unread_count:snapshot.emails.filter(email=>email.mail_account_id===row.id&&!truthy(email.is_read)).length}))}};
  if(path === '/mail/emails') {
    const rows=mailRows(snapshot,params),limit=Math.max(1,numberParam(params,'limit',50,100)),offset=numberParam(params,'offset',0,10000000);
    const includeCount=params.get('include_count')!=='false';
    const emails=rows.slice(offset,offset+limit).map(row=>({...row,body_html:null,body_text:typeof row.body_text==='string'&&row.body_text.length>240?row.body_text.slice(0,240)+'...':row.body_text}));
    return {data:{emails,pagination:{total:includeCount?rows.length:null,limit,offset,page:Math.floor(offset/Math.max(1,limit))+1,totalPages:includeCount?Math.ceil(rows.length/Math.max(1,limit)):null,hasMore:offset+limit<rows.length},offline:true}};
  }
  if(/^\/mail\/emails\/[^/]+$/.test(path)) {
    const email=snapshot.emails.find(row=>row.id===decodeURIComponent(path.split('/').pop()!));
    return email ? {data:{email}} : {error:'This message is not in your offline snapshot.',status:404};
  }
  if(path === '/mail/folders') {
    const rows=mailRows(snapshot,params);
    return {data:{folders:snapshot.folders.map(folder=>({...folder,total_count:rows.filter(row=>row.folder===folder.slug).length,unread_count:rows.filter(row=>row.folder===folder.slug&&!truthy(row.is_read)).length}))}};
  }
  if(path === '/mail/unread-counts') {
    const unreadByFolder: Record<string,number> = {}, unreadByFolderAccount: Record<string,Record<string,number>> = {};
    for(const row of mailRows(snapshot,params)) {
      if(truthy(row.is_read))continue;
      const folder=text(row.folder), id=text(row.mail_account_id);
      unreadByFolder[folder]=(unreadByFolder[folder]||0)+1;
      (unreadByFolderAccount[folder] ||= {})[id]=(unreadByFolderAccount[folder]?.[id]||0)+1;
      if(truthy(row.is_starred)&&folder!=='starred'){
        unreadByFolder.starred=(unreadByFolder.starred||0)+1;
        (unreadByFolderAccount.starred ||= {})[id]=(unreadByFolderAccount.starred[id]||0)+1;
      }
    }
    return {data:{unreadByFolder,...(params.get('include_by_account')==='true'?{unreadByFolderAccount}:{})}};
  }
  if(path === '/stats')return {data:{contacts:snapshot.contacts.length,upcomingEvents:snapshot.events.filter(row=>Date.parse(text(row.start_time))>=Date.now()&&!truthy(row.is_todo_only)&&!['done','cancelled'].includes(text(row.todo_status))).length,unreadEmails:snapshot.emails.filter(row=>!truthy(row.is_read)).length}};
  if(path === '/mail/accounts/counts') return {data:{counts:snapshot.mailAccounts.map(row=>({mail_account_id:row.id,total_count:snapshot.emails.filter(email=>email.mail_account_id===row.id).length,unread_count:snapshot.emails.filter(email=>email.mail_account_id===row.id&&!truthy(email.is_read)).length}))}};
  if(path === '/mail/stats') return {data:{total:snapshot.emails.length,unread:snapshot.emails.filter(row=>!truthy(row.is_read)).length,starred:snapshot.emails.filter(row=>truthy(row.is_starred)).length}};
  if(path === '/settings/preferences') return {data:{preferences:{email_link_behavior:'internal',default_start_page:'mail'}}};
  if(path.startsWith('/mail/attachments/')) return {error:'Attachments are available when you reconnect.',status:503};
  return {error:'This feature needs a connection to UniHub. Your offline mail, contacts and calendar are still available.',status:503};
}
export async function readOfflineResponse<T>(endpoint: string): Promise<{data:T}|{error:string;status?:number}|null> {
  if(!account)return null;
  const observed=generation, expectedAccount=account;
  const snapshot=await storedSnapshot().catch(()=>null);
  if(!snapshot||generation!==observed||account!==expectedAccount||snapshot.userId!==account)return null;
  const response = resolveOfflineEndpoint(snapshot,endpoint);
  if (response && 'data' in response) setOfflineMode(true);
  return response as {data:T}|{error:string;status?:number}|null;
}
