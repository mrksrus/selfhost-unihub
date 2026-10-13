import { formatEventTime, type CalendarCalendar, type CalendarEvent } from '@/lib/calendar-api';
import type { Email } from '@/lib/mail-api';

/** The email a task was made from, as the task remembers it. */
export interface SourceEmail {
  email_id: string;
  subject: string | null;
  from_name: string | null;
  from_address: string;
  received_at: string | null;
  /** File names of the attachments, as they were when the task was made. */
  attachments: string[];
  account: string | null;
  /** The email is a draft the user was writing; `to` is its first recipient. */
  draft?: boolean;
  to?: string | null;
  /** The email still exists in UniHub, so it can be opened. */
  available: boolean;
}

/** What the task dialog needs to know about an email: a message, or a draft from the compose form. */
export type TaskSource = Pick<Email, 'id' | 'subject' | 'from_name' | 'from_address' | 'received_at' | 'attachments' | 'is_draft'>;

/** A task as the mail reader lists it next to its email. */
export type EmailTaskSummary = Pick<CalendarEvent, 'id' | 'title' | 'todo_status' | 'start_time' | 'end_time' | 'all_day' | 'is_todo_only' | 'calendar_id'>;

/** "Re: Fwd: Invoice 4711" becomes "Invoice 4711"; an empty subject becomes the sender. */
export function taskTitleFromEmail(email: Pick<Email, 'subject' | 'from_name' | 'from_address'>) {
  const subject = (email.subject || '').replace(/^(\s*(re|fwd?|aw|wg|sv|tr)\s*:\s*)+/i, '').trim();
  return subject || `Email from ${email.from_name || email.from_address}`;
}

/** Where a task opens its email: the reader, with the message selected. */
export const emailPath = (source: Pick<SourceEmail, 'email_id'>) => `/mail?email=${encodeURIComponent(source.email_id)}`;

/** Who the email is from; a draft is named by who it goes to. */
export const senderName = (source: Pick<SourceEmail, 'from_name' | 'from_address' | 'draft' | 'to'>) =>
  source.draft ? `Draft${source.to ? ` to ${source.to}` : ''}` : source.from_name || source.from_address;

/** Lists a task can go to: the user's own calendars, never a server's. */
export const taskLists = (calendars: CalendarCalendar[]) => calendars.filter(calendar => calendar.account_provider === 'local' && !calendar.read_only);

const LAST_LIST_KEY = 'email-task-list';
export function rememberTaskList(id: string) {
  try { localStorage.setItem(LAST_LIST_KEY, id); } catch { /* Storage may be unavailable. */ }
}
export function rememberedTaskList(lists: CalendarCalendar[]) {
  let id: string | null = null;
  try { id = localStorage.getItem(LAST_LIST_KEY); } catch { /* Storage may be unavailable. */ }
  return lists.find(list => list.id === id)?.id ?? lists[0]?.id ?? '';
}

/** Day keys ("2026-10-13") for the quick date choices, in the user's time zone. */
export function quickDays(timezone: string | null, now = new Date()) {
  const day = (offset: number) => formatEventTime(new Date(now.getTime() + offset * 86_400_000).toISOString(), 'yyyy-MM-dd', timezone);
  return { today: day(0), tomorrow: day(1) };
}

/** The task's calendar times from a day and an optional "HH:mm". A day alone is an all-day task reminded in the morning. */
export function taskTimes(day: string, time: string) {
  const start = time ? `${day}T${time}` : `${day}T09:00`;
  const [hours, minutes] = (time || '09:00').split(':').map(Number);
  const endMinutes = hours * 60 + minutes + 30;
  const end = `${day}T${String(Math.min(23, Math.floor(endMinutes / 60))).padStart(2, '0')}:${String(endMinutes >= 24 * 60 ? 59 : endMinutes % 60).padStart(2, '0')}`;
  return { start, end, allDay: !time };
}
