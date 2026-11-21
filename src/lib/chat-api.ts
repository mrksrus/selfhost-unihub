// The chat routes as the engine calls them (api/src/routes/chat*.ts,
// contracts/chat.ts). Every call throws ApiError on a refusal and answers the
// route's data. Enrolling and key packages are called from lib/chat/device.ts.
import { api, type ApiResponse } from '@/lib/api';
import { ApiError, unwrap } from '@/lib/api-error';
import type {
  ChatAccount, ChatAccountResponse, ChatArchiveCopy, ChatArchiveResponse, ChatConversation, ChatConversationResponse, ChatConversationsResponse,
  ChatDevicesResponse, ChatGroupCreateRequest, ChatKeyBackup, ChatKeyPackageClaimResponse, ChatMarksRequest, ChatMarksResponse, ChatMessage,
  ChatMessageCreateRequest, ChatMessageDeletedResponse, ChatMessageResponse, ChatMessagesResponse, ChatCandidatesResponse, ChatConversationUpdatedResponse,
  ChatGroupChatCreateRequest, ChatMembersResponse, ChatNotify, ChatNotifyResponse, ChatAttachmentResponse, ChatDeviceResponse, ChatChallengeResponse,
  ChatApprovalsResponse,
} from '../../api/src/contracts/chat';

const data = async <T>(response: Promise<ApiResponse<T>>) => unwrap(await response)!;
const conversation = (id: string) => `/chat/conversations/${encodeURIComponent(id)}`;

export const chatApi = {
  account: async (): Promise<ChatAccount | null> => (await data(api.get<ChatAccountResponse>('/chat/account'))).account,
  createAccount: async (history_public: string, key_backup: ChatKeyBackup) =>
    (await data(api.post<ChatAccountResponse>('/chat/account', { history_public, key_backup }))).account!,
  replaceKeyBackup: async (current_password: string, history_public: string, key_backup: ChatKeyBackup) =>
    (await data(api.put<ChatAccountResponse>('/chat/account/key-backup', { current_password, history_public, key_backup }))).account!,
  newKey: async (current_password: string, history_public: string, key_backup: ChatKeyBackup) =>
    (await data(api.post<ChatAccountResponse>('/chat/account/new-key', { current_password, history_public, key_backup }))).account!,

  // This device joining Chat (lib/chat/pairing.ts), and a joined one answering others' requests.
  device: () => data(api.get<ChatDeviceResponse>('/chat/devices/current')),
  challenge: () => data(api.post<ChatChallengeResponse>('/chat/devices/current/challenge')),
  prove: (value: string) => data(api.post<ChatDeviceResponse>('/chat/devices/current/proof', { value })),
  askApproval: (public_key: string) => data(api.post<ChatDeviceResponse>('/chat/devices/current/approval', { public_key })),
  approvals: async () => (await data(api.get<ChatApprovalsResponse>('/chat/devices/approvals'))).approvals,
  approve: (chatDeviceId: string, public_key: string, sealed_key: string) =>
    data(api.post(`/chat/devices/${encodeURIComponent(chatDeviceId)}/approve`, { public_key, sealed_key })),
  dropApproval: (chatDeviceId: string) => data(api.delete(`/chat/devices/${encodeURIComponent(chatDeviceId)}/approval`)),

  conversations: async (): Promise<ChatConversation[]> => (await data(api.get<ChatConversationsResponse>('/chat/conversations'))).conversations,
  start: async (user_id: string) => (await data(api.post<ChatConversationResponse>('/chat/conversations', { user_id }))).conversation,
  startGroup: async (body: ChatGroupChatCreateRequest) => (await data(api.post<ChatConversationResponse>('/chat/conversations', body))).conversation,
  candidates: (query: string) => data(api.get<ChatCandidatesResponse>(`/chat/candidates?q=${encodeURIComponent(query)}`)),
  // The contract says PATCH, which the route table and this client do not have.
  rename: (id: string, name: string) => data(api.put<ChatConversationUpdatedResponse>(conversation(id), { name })),
  unfollow: (id: string) => data(api.post<ChatConversationUpdatedResponse>(`${conversation(id)}/unfollow`)),
  members: async (id: string) => (await data(api.get<ChatMembersResponse>(`${conversation(id)}/members`))).members,
  addMembers: async (id: string, user_ids: string[]) => (await data(api.post<ChatMembersResponse>(`${conversation(id)}/members`, { user_ids }))).members,
  removeMember: async (id: string, userId: string) => (await data(api.delete<ChatMembersResponse>(`${conversation(id)}/members/${encodeURIComponent(userId)}`))).members,
  leave: (id: string) => data(api.post(`${conversation(id)}/leave`)),
  notify: (id: string, notify: ChatNotify) => data(api.put<ChatNotifyResponse>(`${conversation(id)}/notify`, { notify })),
  devices: async (id: string) => (await data(api.get<ChatDevicesResponse>(`${conversation(id)}/devices`))).devices,
  claimKeyPackages: async (id: string) => (await data(api.post<ChatKeyPackageClaimResponse>(`${conversation(id)}/key-packages`))).key_packages,
  createGroup: (id: string, body: ChatGroupCreateRequest) => data(api.post(`${conversation(id)}/groups`, body)),
  joined: (groupId: string) => data(api.post(`/chat/groups/${encodeURIComponent(groupId)}/joined`)),
  post: async (id: string, body: ChatMessageCreateRequest): Promise<ChatMessage> => (await data(api.post<ChatMessageResponse>(`${conversation(id)}/messages`, body))).message,
  messages: (id: string, after: number) => data(api.get<ChatMessagesResponse>(`${conversation(id)}/messages?after=${after}&limit=200`)),
  delete: (messageId: string) => data(api.delete<ChatMessageDeletedResponse>(`/chat/messages/${encodeURIComponent(messageId)}`)),
  marks: (id: string, body: ChatMarksRequest) => data(api.put<ChatMarksResponse>(`${conversation(id)}/marks`, body)),
  storeArchive: (copies: ChatArchiveCopy[]) => data(api.post('/chat/archive', { copies })),
  upload: async (id: string, fileId: string, ciphertext: Blob, onProgress: (sent: number) => void, signal: AbortSignal) =>
    (await data(api.uploadBlob<ChatAttachmentResponse>(`${conversation(id)}/attachments?id=${encodeURIComponent(fileId)}`, ciphertext, 'application/octet-stream', 'POST', { onProgress, signal }))).attachment,
  download: (fileId: string, signal?: AbortSignal) => api.getStream(`/chat/attachments/${encodeURIComponent(fileId)}`, { signal }),
  archive: (cursor: string | null) => data(api.get<ChatArchiveResponse>(`/chat/archive?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)),
};

/** The server could not be reached (offline, or a proxy answered for it): try again later, nothing was refused. */
export const unreachable = (error: unknown) => error instanceof ApiError && (error.status === undefined || error.status >= 500);
