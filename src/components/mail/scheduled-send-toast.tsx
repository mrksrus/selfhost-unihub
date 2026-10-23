import { ToastAction } from '@/components/ui/toast';
import { formatWhen } from '@/lib/mail-times';

/** "Scheduled for …" with an Undo that cancels the schedule; the draft stays in Drafts either way. */
export function scheduledSendToast(sendAt: string, onUndo: () => void) {
  return {
    title: `Scheduled for ${formatWhen(sendAt)}`,
    description: 'The message waits in Drafts until then.',
    action: <ToastAction altText="Cancel the scheduled send" onClick={onUndo}>Undo</ToastAction>,
  };
}
