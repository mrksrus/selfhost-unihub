import type { ServerResponse } from 'node:http';
import type { AuthRequest, RouteRequest } from '../types';
import type { UploadBody } from '../http/route';
import type { ChatAttachmentResponse, ChatRetentionApplyNowResponse, ChatRetentionPreviewResponse } from '../contracts/chat';

import { defineRoutes } from '../http/route';
import { confirmPassword } from '../security/reauthentication';
import { UPLOAD_LIMIT, attachmentFile, storeAttachment } from '../services/chat-attachments';
import { applyRetentionNow, previewRetention } from '../services/chat-retention';

type Request = RouteRequest & { url: string; params: Record<string, string> };

// Chat files (services/chat-attachments.ts) and the administrator's retention
// routes (services/chat-retention.ts). Chat is in no personal backup, so no
// restore section gates them. Ids are stored in lower case.
const query = (req: Request) => new URL(req.url, 'http://localhost').searchParams;

export = defineRoutes({
  'POST /api/chat/conversations/:id/attachments': { auth: 'user', module: 'chat', restoreSection: null, body: { kind: 'upload', limit: UPLOAD_LIMIT },
    handler: async (req: Request, userId: string, body: unknown) => {
      return { attachment: await storeAttachment(userId, req.params.id.toLowerCase(), query(req).get('id'), body as UploadBody) } satisfies ChatAttachmentResponse;
    } },
  'GET /api/chat/attachments/:id': { auth: 'user', module: 'chat', handler: async (req: Request, userId: string) => {
    return attachmentFile(userId, req.params.id.toLowerCase());
  } },
  'GET /api/admin/chat/retention-preview': { auth: 'admin', permission: 'server.settings', module: null, handler: async (req: Request) => {
    return { ...await previewRetention(query(req).get('days'), query(req).get('group_id')) } satisfies ChatRetentionPreviewResponse;
  } },
  'POST /api/admin/chat/retention/apply-now': { auth: 'admin', permission: 'server.settings', module: null, restoreSection: null, body: { limit: 1024 },
    handler: async (req: Request, userId: string, body: unknown, res: ServerResponse) => {
      const refused = await confirmPassword(userId, (body as { current_password?: unknown } | null)?.current_password, res);
      if (refused) return refused;
      return { ...await applyRetentionNow(userId, req as AuthRequest) } satisfies ChatRetentionApplyNowResponse;
    } },
});
