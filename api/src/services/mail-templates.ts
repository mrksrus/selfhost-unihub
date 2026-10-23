import type { RowDataPacket } from 'mysql2/promise';
import type { MailTemplate, MailTemplateRequest } from '../contracts/mail';

import crypto from 'crypto';
import { db } from '../state';
import { badRequest, conflict, notFound } from '../http/errors';

// Saved messages to start a new mail or a reply from (0.24). A template
// belongs to its person and is the composer's content only: no recipients,
// no attachments. Names are unique per person, so restore can recognise one.
const NAME_LIMIT = 120;
const SUBJECT_LIMIT = 998;
const HTML_LIMIT = 262144;
const TEXT_LIMIT = 131072;
const TEMPLATES_PER_USER = 200;

interface TemplateRow extends RowDataPacket {
  id: string; name: string; subject: string | null; body_html: string | null; body_text: string | null; updated_at: Date | string;
}

const toTemplate = (row: TemplateRow): MailTemplate => ({
  id: row.id, name: row.name, subject: row.subject ?? '', body_html: row.body_html || null, body_text: row.body_text ?? '',
  updated_at: new Date(row.updated_at).toISOString(),
});

function parse(input: unknown): Required<MailTemplateRequest> {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > NAME_LIMIT) throw badRequest('TEMPLATE_NAME_INVALID', `Give the template a name of up to ${NAME_LIMIT} characters`);
  const text = (key: string, limit: number, nullable = false) => {
    const value = body[key];
    if (value === undefined || value === null) return nullable ? null : '';
    if (typeof value !== 'string' || value.length > limit) throw badRequest('TEMPLATE_INVALID', `The template's ${key.replace('body_', '')} is too long`);
    return value;
  };
  const subject = text('subject', SUBJECT_LIMIT)!.replace(/[\r\n]+/g, ' ');
  return { name, subject, body_html: text('body_html', HTML_LIMIT, true) || null, body_text: text('body_text', TEXT_LIMIT)! };
}

async function listTemplates(userId: string) {
  const [rows] = await db.execute<TemplateRow[]>('SELECT id, name, subject, body_html, body_text, updated_at FROM mail_templates WHERE user_id = ? ORDER BY name, id', [userId]);
  return rows.map(toTemplate);
}

async function getTemplate(userId: string, id: string) {
  const [rows] = await db.execute<TemplateRow[]>('SELECT id, name, subject, body_html, body_text, updated_at FROM mail_templates WHERE id = ? AND user_id = ?', [id, userId]);
  if (!rows[0]) throw notFound('TEMPLATE_NOT_FOUND', 'Template not found');
  return toTemplate(rows[0]);
}

async function nameTaken(userId: string, name: string, exceptId: string | null) {
  const [rows] = await db.execute<RowDataPacket[]>('SELECT id FROM mail_templates WHERE user_id = ? AND name = ? AND id <> ?', [userId, name, exceptId ?? '']);
  return rows.length > 0;
}

// The unique key on (user_id, name) settles two saves of one name at once.
const nameClash = (error: unknown) => {
  if ((error as { code?: string })?.code === 'ER_DUP_ENTRY') throw conflict('TEMPLATE_NAME_TAKEN', 'A template with this name exists');
  throw error;
};

async function createTemplate(userId: string, input: unknown) {
  const template = parse(input);
  const [[count]] = await db.execute<RowDataPacket[]>('SELECT COUNT(*) AS total FROM mail_templates WHERE user_id = ?', [userId]);
  if (Number(count.total) >= TEMPLATES_PER_USER) throw badRequest('TEMPLATE_LIMIT', `You can keep up to ${TEMPLATES_PER_USER} templates`);
  if (await nameTaken(userId, template.name, null)) throw conflict('TEMPLATE_NAME_TAKEN', 'A template with this name exists');
  const id = crypto.randomUUID();
  await db.execute('INSERT INTO mail_templates (id, user_id, name, subject, body_html, body_text) VALUES (?, ?, ?, ?, ?, ?)',
    [id, userId, template.name, template.subject, template.body_html, template.body_text]).catch(nameClash);
  return getTemplate(userId, id);
}

async function updateTemplate(userId: string, id: string, input: unknown) {
  const template = parse(input);
  await getTemplate(userId, id);
  if (await nameTaken(userId, template.name, id)) throw conflict('TEMPLATE_NAME_TAKEN', 'A template with this name exists');
  await db.execute('UPDATE mail_templates SET name = ?, subject = ?, body_html = ?, body_text = ? WHERE id = ? AND user_id = ?',
    [template.name, template.subject, template.body_html, template.body_text, id, userId]).catch(nameClash);
  return getTemplate(userId, id);
}

async function deleteTemplate(userId: string, id: string) {
  await getTemplate(userId, id);
  await db.execute('DELETE FROM mail_templates WHERE id = ? AND user_id = ?', [id, userId]);
}

export { listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, HTML_LIMIT as TEMPLATE_HTML_LIMIT, TEXT_LIMIT as TEMPLATE_TEXT_LIMIT };
