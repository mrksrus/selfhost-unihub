const MAIL_ATTACHMENT_MAX_COUNT = 20;
const MAIL_ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;
const MAIL_ATTACHMENTS_TOTAL_MAX_BYTES = 25 * 1024 * 1024;

export const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const plainTextToHtml = (value: string) =>
  escapeHtml(value || '')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\n/g, '<br>'))
    .map((paragraph) => `<p>${paragraph || '<br>'}</p>`)
    .join('');

export const sanitizeReturnTo = (value: string | null) => {
  if (!value) return null;
  if (!value.startsWith('/') || value.startsWith('//') || /^https?:\/\//i.test(value)) return null;
  if (value.startsWith('/auth')) return null;
  return value;
};

export const isComposeHtmlEmpty = (value: string) =>
  !value
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();

export const isComposeMeaningful = (
  form: { to: string; subject: string; body: string },
  newAttachmentsCount: number,
  existingAttachmentsCount = 0
) =>
  Boolean(
    form.to.trim() ||
    form.subject.trim() ||
    !isComposeHtmlEmpty(form.body) ||
    newAttachmentsCount > 0 ||
    existingAttachmentsCount > 0
  );

export const validateComposeAttachments = (
  existingAttachments: Array<{ filename: string; size: number }>,
  newFiles: File[]
) => {
  const combinedCount = existingAttachments.length + newFiles.length;
  if (combinedCount > MAIL_ATTACHMENT_MAX_COUNT) {
    return `You can attach at most ${MAIL_ATTACHMENT_MAX_COUNT} files.`;
  }

  const oversizedFile = newFiles.find(file => file.size > MAIL_ATTACHMENT_MAX_BYTES);
  if (oversizedFile) {
    return `"${oversizedFile.name}" is larger than the 15 MB attachment limit.`;
  }

  const totalBytes = existingAttachments.reduce((total, attachment) => total + attachment.size, 0)
    + newFiles.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAIL_ATTACHMENTS_TOTAL_MAX_BYTES) {
    return 'Attachments exceed the 25 MB total limit.';
  }

  return null;
};
