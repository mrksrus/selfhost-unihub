import { describe, expect, it } from 'vitest';
import { isComposeBodyEmpty, isComposeMeaningful, plainTextToHtml, sanitizeComposeHtml, sanitizeReturnTo, validateComposeAttachments } from '@/lib/mail-compose';

describe('mail compose boundaries', () => {
  it('escapes plain text while preserving paragraphs without executable markup', () => {
    expect(plainTextToHtml('<script>alert(1)</script>\n\nhello & goodbye')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><p>hello &amp; goodbye</p>');
  });
  it('never navigates the composer return link to another site or login', () => {
    for (const href of ['//evil.test', 'https://evil.test', '/auth', '/auth?next=/mail']) expect(sanitizeReturnTo(href)).toBeNull();
    expect(sanitizeReturnTo('/contacts?search=alice')).toBe('/contacts?search=alice');
  });
  it('opens a stored draft as inert HTML while keeping everything the toolbar writes', () => {
    const hostile = sanitizeComposeHtml('<p>Quoted offer</p><img src="x" onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">terms</a><svg onload="alert(4)"></svg><form action="https://evil.test"><input name="card"></form>');
    expect(hostile).toBe('<p>Quoted offer</p><img><a>terms</a>');
    // bold, italic, underline, lists, text colour and size, link, image: the execCommand set in MailCompose.tsx.
    const written = '<div>Hi <b>Alex</b>, <i>see</i> <u>below</u></div><ul><li>one</li></ul><ol><li>two</li></ol>'
      + '<font color="#2563eb" size="5">big</font><a href="https://example.test/offer">offer</a><img src="https://example.test/logo.png"><p><br></p><hr><blockquote><p>quoted</p></blockquote>';
    expect(sanitizeComposeHtml(written)).toBe(written.replace('<a href="https://example.test/offer">', '<a href="https://example.test/offer" target="_blank" rel="noopener noreferrer">'));
    expect(sanitizeComposeHtml('')).toBe('');
  });
  it('treats an attachment as a draft even with an empty editor', () => {
    const form = { to: '', cc: '', bcc: '', subject: '', body: '<p><br>&nbsp;</p>' };
    expect(isComposeMeaningful(form, 0)).toBe(false);
    expect(isComposeMeaningful(form, 0, 1)).toBe(true);
    expect(isComposeMeaningful({ ...form, cc: 'copy@example.com' }, 0)).toBe(true);
    expect(validateComposeAttachments(Array.from({ length: 20 }, () => ({ filename: 'old', size: 1 })), [new File(['x'], 'new.txt')])).toContain('at most 20');
  });
  it('keeps a plain-text body that looks like markup: it is what the person typed', () => {
    const form = { to: '', cc: '', bcc: '', subject: '', body: '<alice@example.test>' };
    expect(isComposeBodyEmpty(form.body, 'plain')).toBe(false);
    expect(isComposeMeaningful(form, 0, 0, 'plain')).toBe(true);
    expect(isComposeBodyEmpty('  \n ', 'plain')).toBe(true);
    expect(isComposeBodyEmpty('<p><br></p>', 'rich')).toBe(true);
  });
});
