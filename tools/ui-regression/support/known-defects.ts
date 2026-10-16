// Violations the checks found in the code that was pinned (2026-10-16, commit
// 04db73b). They are listed, not hidden: a check passes only when the violations
// it sees are exactly these. A new violation fails; so does a listed one that no
// longer occurs, so the entry is removed (and the affected baselines re-approved)
// together with the fix. Report each one; fixing them is separate work.
import { expect } from '@playwright/test';

export interface KnownDefect { id: string; summary: string; matches: RegExp; expectedViolations?: string[] }

export const KNOWN_DEFECTS = {
  todoRowClipped: {
    id: 'UIR-1',
    summary: 'ToDo: a task row with a long source-email subject is wider than its list. On Phone its description, email block, subtasks and menu are cut off at the right edge and the page scrolls sideways (P-07). On Wide the same row runs past the row divider without being cut off; that is visible in the todo-wide baselines.',
    matches: /^ToDo (row "Confirm the documentation review dates"|page body scrolls sideways)/,
  },
  recordingTagTargets: {
    id: 'UIR-2',
    summary: 'Recordings: tag buttons stay 20 px tall on touch screens with no 44 px tap area (P-11).',
    matches: /^button ("garden" tap area 60×20|"ideas" tap area 50×20|"sketch" tap area 57×20) px is under 40 px$/,
    expectedViolations: [
      'button "garden" tap area 60×20 px is under 40 px',
      'button "ideas" tap area 50×20 px is under 40 px',
      'button "sketch" tap area 57×20 px is under 40 px',
    ],
  },
} satisfies Record<string, KnownDefect>;

/** Fails on any violation not covered by `known`, and on any `known` entry that no longer occurs. */
export function expectOnlyKnown(violations: string[], known: KnownDefect[]) {
  const unexpected = violations.filter(text => !known.some(defect => defect.matches.test(text)));
  const fixed = known.filter(defect => !violations.some(text => defect.matches.test(text)));
  expect(unexpected, 'new violations').toEqual([]);
  for (const defect of known) {
    if (defect.expectedViolations) expect(violations.filter(text => defect.matches.test(text)).sort(), `${defect.id} exact existing violations`).toEqual([...defect.expectedViolations].sort());
  }
  expect(fixed.map(defect => `${defect.id} no longer occurs: remove it from support/known-defects.ts and review the baselines it affects`), 'fixed known defects').toEqual([]);
}
