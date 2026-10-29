import { describe, expect, it } from 'vitest';
import { joinRecipients, looksLikeAddress, recipientAddress, recipientChipLabel, splitRecipients } from '@/lib/recipient-chips';

// The phone composer's chips are a view of the one comma-separated recipient
// string; a wrong split would send to a different address than the chips show.
describe('recipient chips', () => {
  it('keeps a quoted name with a comma and a bracketed address as one entry', () => {
    expect(splitRecipients('"Doe, Jane" <jane2@example.com>, Jane Doe <jane@example.com>, sa')).toEqual({
      entries: ['"Doe, Jane" <jane2@example.com>', 'Jane Doe <jane@example.com>'],
      draft: 'sa',
    });
  });

  it('a trailing comma completes the last entry and leaves the input empty', () => {
    expect(splitRecipients('a@example.com,')).toEqual({ entries: ['a@example.com'], draft: '' });
    expect(splitRecipients('a@example.com, ')).toEqual({ entries: ['a@example.com'], draft: '' });
    expect(splitRecipients('')).toEqual({ entries: [], draft: '' });
  });

  it('puts entries and the typed text back into the string the draft and send use', () => {
    expect(joinRecipients(['a@example.com', 'b@example.com'], 'c')).toBe('a@example.com, b@example.com, c');
    expect(joinRecipients([], 'c')).toBe('c');
    expect(joinRecipients(['a@example.com'], '')).toBe('a@example.com, ');
    const value = '"Doe, Jane" <jane2@example.com>, b@example.com, c';
    const { entries, draft } = splitRecipients(value);
    expect(joinRecipients(entries, draft)).toBe(value);
  });

  it('an escaped quote inside a quoted name does not end it: removing one chip keeps the other', () => {
    const value = '"Doe \\", Jane" <jane@example.com>, bob@example.org, ';
    const { entries, draft } = splitRecipients(value);
    expect(entries).toEqual(['"Doe \\", Jane" <jane@example.com>', 'bob@example.org']);
    expect(draft).toBe('');
    expect(recipientChipLabel(entries[0])).toBe('Doe ", Jane');
    expect(recipientAddress(entries[0])).toBe('jane@example.com');
    // The chip for Jane is removed; the draft's string keeps Bob alone, and reads back the same.
    const saved = joinRecipients(entries.filter(entry => entry !== entries[0]), draft);
    expect(saved).toBe('bob@example.org, ');
    expect(splitRecipients(saved).entries).toEqual(['bob@example.org']);
    // And the other way round: Jane stays whole.
    const kept = joinRecipients([entries[0]], '');
    expect(splitRecipients(kept).entries).toEqual([entries[0]]);
    expect(splitRecipients('"a\\\\", b@example.org').entries).toEqual(['"a\\\\"']);
  });

  it('shows the name of a named entry and marks what cannot be an address', () => {
    expect(recipientChipLabel('Jane Doe <jane@example.com>')).toBe('Jane Doe');
    expect(recipientChipLabel('"Doe, Jane" <jane2@example.com>')).toBe('Doe, Jane');
    expect(recipientChipLabel('jane@example.com')).toBe('jane@example.com');
    expect(looksLikeAddress('Jane Doe <jane@example.com>')).toBe(true);
    expect(looksLikeAddress('jane')).toBe(false);
    expect(looksLikeAddress('jane @example.com')).toBe(false);
  });
});
