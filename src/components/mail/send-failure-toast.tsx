import { ToastAction } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-error';

/**
 * The toast for a send that did not succeed. When the server cannot tell
 * whether the message went out (or is still sending it), the person checks
 * Sent; sending again is their decision, offered as an action that starts a
 * new send rather than repeating the first one.
 */
export function sendFailureToast(error: unknown, sendAgain: () => void) {
  const code = error instanceof ApiError ? error.code : undefined;
  const description = error instanceof Error ? error.message : undefined;
  if (code === 'SEND_IN_PROGRESS') return { title: 'Still sending', description, duration: 8000 };
  if (code === 'SEND_OUTCOME_UNKNOWN' || code === 'IDEMPOTENCY_KEY_REUSED') {
    return {
      title: 'The email may have been sent',
      description,
      variant: 'destructive' as const,
      duration: 20000,
      action: <ToastAction altText="Send the email again" onClick={sendAgain}>Send again</ToastAction>,
    };
  }
  return { title: 'Failed to send email', description, variant: 'destructive' as const, duration: 8000 };
}
