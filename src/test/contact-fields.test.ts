import { describe, expect, it } from 'vitest';
import { addressLines, contactInitials, formatPartialDate, labelText, partialDateInput, primaryDetail, safeHref } from '@/lib/contact-fields';
import { contact } from './contact-fixtures';

describe('contact fields', () => {
  it('reads labels, custom labels and the "no label" of values from before 0.26', () => {
    expect(labelText({ label: 'work_fax', custom_label: null })).toBe('Work fax');
    expect(labelText({ label: 'custom', custom_label: ' Boat ' })).toBe('Boat');
    expect(labelText({ label: 'custom', custom_label: '' })).toBe('Custom');
    expect(labelText({ label: '', custom_label: null }, 'Email')).toBe('Email');
  });

  it('formats a partial date both ways', () => {
    expect(formatPartialDate({ year: 1990, month: 3, day: 14 })).toBe('14 March 1990');
    expect(formatPartialDate({ year: null, month: 12, day: 1 })).toBe('1 December');
    expect(partialDateInput({ year: null, month: 2, day: 29 })).toBe('--02-29');
    expect(partialDateInput({ year: 1990, month: 3, day: 4 })).toBe('1990-03-04');
  });

  it('only links schemes the browser can hand on safely', () => {
    expect(safeHref('https://example.com/a')).toBe('https://example.com/a');
    expect(safeHref('example.com')).toBe('https://example.com');
    expect(safeHref('xmpp:anna@example.com')).toBe('xmpp:anna@example.com');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,hi')).toBeNull();
    expect(safeHref('skype:anna')).toBeNull();
  });

  it('builds address lines and the subtitle from the preferred value', () => {
    expect(addressLines({ id: 'a', value: '', label: 'home', custom_label: null, preferred: false, po_box: null, extended: 'Floor 2', street: '1 Example St', locality: 'Exampleton', region: '', postal_code: '12345', country: 'Examplia' }))
      .toEqual(['Floor 2', '1 Example St', '12345 Exampleton', 'Examplia']);
    const c = contact('c', { emails: ['a@example.com'], phones: ['+1 555 0100', { value: '+1 555 0199', preferred: true }] });
    expect(primaryDetail(c)).toBe('+1 555 0199');
    expect(contactInitials(contact('x', { name: { given: 'Ada', family: 'Example' } }))).toBe('AE');
    expect(contactInitials(contact('y', { emails: ['someone@example.org'] }))).toBe('S');
    expect(contactInitials(contact('z', { name: { display: 'Example Labs' } }))).toBe('EL');
  });
});
