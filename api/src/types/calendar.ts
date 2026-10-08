import type { StoredFlag } from '../types';

export interface CalendarDates { created_at?: Date | string | null; updated_at?: Date | string | null }
export interface CalendarAccount extends CalendarDates, Record<string, unknown> {
  id: string;
  user_id: string;
  provider: string;
  account_email?: string | null;
  display_name?: string | null;
  username?: string | null;
  discovery_url?: string | null;
  base_url?: string | null;
  provider_config?: unknown;
  capabilities?: unknown;
  is_active?: StoredFlag;
  sync_status?: string | null;
  sync_error?: string | null;
  last_synced_at?: Date | string | null;
  next_sync_at?: Date | string | null;
  mail_account_id?: string | null;
}
export interface CalendarCalendar extends CalendarDates, Record<string, unknown> {
  id: string;
  user_id: string;
  account_id: string;
  name: string;
  external_id?: string | null;
  color?: string | null;
  is_visible?: StoredFlag;
  auto_todo_enabled?: StoredFlag;
  read_only?: StoredFlag;
  is_primary?: StoredFlag;
  sync_token?: string | null;
}
export interface CalendarSubtask extends CalendarDates, Record<string, unknown> {
  id: string;
  event_id: string;
  user_id: string;
  title?: string;
  is_done?: StoredFlag;
}
export interface CalendarAttendee extends CalendarDates, Record<string, unknown> {
  id: string;
  event_id: string;
  user_id: string;
  email: string;
  display_name?: string | null;
  response_status?: string | null;
  is_organizer?: StoredFlag;
  optional_attendee?: StoredFlag;
  comment?: string | null;
}
export interface CalendarEvent extends CalendarDates, Record<string, unknown> {
  id: string;
  user_id: string;
  calendar_id?: string | null;
  all_day?: StoredFlag;
  is_todo_only?: StoredFlag;
  start_time?: Date | string | null;
  end_time?: Date | string | null;
  done_at?: Date | string | null;
  reminders?: unknown;
}
