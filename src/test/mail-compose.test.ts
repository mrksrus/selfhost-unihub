import { describe, expect, it } from 'vitest';
import { isComposeMeaningful, plainTextToHtml, sanitizeReturnTo, validateComposeAttachments } from '@/lib/mail-compose';

describe('mail compose boundaries', () => {
  it('escapes plain text while preserving paragraphs without executable markup', () => {
    expect(plainTextToHtml('<script>alert(1)</script>\n\nhello & goodbye')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><p>hello &amp; goodbye</p>');
  });
  it('never navigates the composer return link to another site or login', () => {
    for (const href of ['//evil.test', 'https://evil.test', '/auth', '/auth?next=/mail']) expect(sanitizeReturnTo(href)).toBeNull();
    expect(sanitizeReturnTo('/contacts?search=alice')).toBe('/contacts?search=alice');
  });
  it('treats an attachment as a draft even with an empty editor', () => {
    const form = { to: '', subject: '', body: '<p><br>&nbsp;</p>' };
    expect(isComposeMeaningful(form, 0)).toBe(false);
    expect(isComposeMeaningful(form, 0, 1)).toBe(true);
    expect(validateComposeAttachments(Array.from({ length: 20 }, () => ({ filename: 'old', size: 1 })), [new File(['x'], 'new.txt')])).toContain('at most 20');
  });
});
