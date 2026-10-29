import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '@/components/ui/toaster';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';
import { sendFailureToast } from '@/components/mail/send-failure-toast';
import { ApiError } from '@/lib/api-error';

afterEach(cleanup);

// B-31: a modal dialog (the composer) hides everything outside itself from
// assistive technology. The notices stay readable and their actions usable,
// because "Send again" after an unknown outcome is offered while the
// composer is still open.
describe('notices over a modal dialog', () => {
  it('keeps a notice and its "Send again" action in the accessibility tree while the composer is open', async () => {
    const sendAgain = vi.fn();
    render(
      <>
        <Dialog open>
          <DialogContent>
            <DialogTitle>New message</DialogTitle>
            <DialogDescription>Compose</DialogDescription>
          </DialogContent>
        </Dialog>
        <Toaster />
      </>,
    );
    expect(screen.getByRole('dialog', { name: 'New message' })).toBeInTheDocument();
    act(() => {
      toast(sendFailureToast(new ApiError({ error: 'It may have been sent.', status: 409, code: 'SEND_OUTCOME_UNKNOWN' }), sendAgain));
    });
    expect(await screen.findByRole('region', { name: /Notifications/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send again' }));
    expect(sendAgain).toHaveBeenCalledTimes(1);
  });
});
