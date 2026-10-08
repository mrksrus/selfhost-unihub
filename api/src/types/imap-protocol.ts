// Coupling to ImapFlow 2.x internals is checked by assertSupportedLibrary.
import type { ImapFlow } from 'imapflow';

export interface ParsedResponse { attributes?: { section?: { value?: string }[] }[] }
export interface TaggedReply { next: () => void; response: ParsedResponse }
export interface ExecOptions { untagged?: Record<string, (response: ParsedResponse) => Promise<void>> }
export type ProtocolConnection = ImapFlow & { exec: (command: string, attributes: unknown[], options?: ExecOptions) => Promise<TaggedReply> };
export type ProtocolError = Error & { responseStatus?: string; response?: ParsedResponse; code?: string };
export interface CopyUidMapping { uidvalidity: number; sourceUids: number[]; destinationUids: number[] }
