import { configure, getConfig } from '@testing-library/react';
import { afterAll, beforeAll } from 'vitest';

/**
 * Whole-page mail tests wait for CPU, not for slow fixtures: every mocked
 * request resolves at once, but the first render of the mail page in a
 * worker, and each *ByRole query (roles, names and visibility over the full
 * page DOM), can each take more than a second when the full suite runs files
 * in parallel. Testing Library's default 1 s wait and Vitest's 5 s test limit
 * then fail tests that are only slow. These budgets leave room for that; a
 * test whose condition never becomes true still fails, only later.
 */
export const MAIL_PAGE_TEST_TIMEOUT = 20000;

export function applyMailPageWaitBudget(asyncUtilTimeout = 5000) {
  let previous: number;
  beforeAll(() => {
    previous = getConfig().asyncUtilTimeout;
    configure({ asyncUtilTimeout });
  });
  afterAll(() => configure({ asyncUtilTimeout: previous }));
}
