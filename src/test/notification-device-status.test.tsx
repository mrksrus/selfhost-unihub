import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DeviceStatus } from '@/components/pwa/NotificationSettings';

afterEach(cleanup);

describe('notification device status', () => {
  it('shows the last delivery, an open problem and when the session ends', () => {
    render(<DeviceStatus status={{ subscribed: true, lastSentAt: '2026-10-02T08:00:00.000Z', pending: 1, sessionExpiresAt: '2026-10-20T08:00:00.000Z',
      lastError: { message: 'Push service 503', at: '2026-10-03T08:00:00.000Z' } }} />);
    expect(screen.getByText(/^Last delivered: .* 1 waiting\.$/)).toBeInTheDocument();
    expect(screen.getByText(/Last problem: Push service 503/)).toBeInTheDocument();
    expect(screen.getByText(/Opening UniHub extends this\./)).toBeInTheDocument();
  });

  it('says when nothing was delivered yet', () => {
    render(<DeviceStatus status={{ subscribed: true, lastSentAt: null, pending: 0, lastError: null }} />);
    expect(screen.getByText('Nothing delivered yet.')).toBeInTheDocument();
  });
});
