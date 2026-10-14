import { api } from '@/lib/api';
import { saveFile } from '@/lib/platform';
import type { EmailAttachment } from '@/lib/mail-api';
import { useToast } from '@/hooks/use-toast';

/** Downloads one attachment to the device, explaining a failure in plain words. */
export function useAttachmentDownload() {
  const { toast } = useToast();
  return async (attachment: Pick<EmailAttachment, 'id' | 'filename'>) => {
    try {
      const { blob, filename } = await api.getBlob(`/mail/attachments/${attachment.id}`);
      await saveFile(blob, filename || attachment.filename || 'attachment');
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      const description = status === 401 ? 'Session expired. Please sign in again and retry.'
        : status === 404 ? 'Attachment not found (it may not be available on disk).'
          : status && status >= 500 ? 'Server error while downloading attachment.'
            : error instanceof Error && error.message ? error.message : 'Could not download attachment. Please try again.';
      toast({ title: 'Download failed', description, variant: 'destructive' });
    }
  };
}
