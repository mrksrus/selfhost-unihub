import { describe, expect, it } from 'vitest';
import { jobPollInterval } from '@/lib/job-polling';

describe('backup polling policy', () => {
  it('does not poll empty, terminal or user-input jobs', () => {
    expect(jobPollInterval([], true, 3000)).toBe(false);
    for (const status of ['ready', 'completed', 'cancelled', 'failed', 'expired', 'awaiting_password', 'validated']) {
      expect(jobPollInterval([{ status }], true, 3000), status).toBe(false);
    }
  });
  it('polls running work only while its tab is visible', () => {
    for (const status of ['queued', 'running', 'validating', 'cancelling']) {
      expect(jobPollInterval([{ status }], true, 3000), status).toBe(3000);
      expect(jobPollInterval([{ status }], false, 3000), status).toBe(false);
    }
  });
});
