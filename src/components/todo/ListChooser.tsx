import { useMemo } from 'react';
import type { CalendarCalendar } from '@/lib/calendar-api';
import { groupByAccount, listRefusal } from '@/lib/tasks';
import { cn } from '@/lib/utils';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';

interface Props {
  id: string;
  calendars: readonly CalendarCalendar[];
  value: string;
  onChange: (calendarId: string) => void;
  /** The item has no date, so only UniHub's own lists can take it. */
  undated?: boolean;
  /** Lists that cannot be chosen for another reason, with the reason shown ("Current list"). */
  unavailable?: Record<string, string>;
  /** Whether a list shown in ToDo matters for the item: a task that is not shown there says so. */
  forTask?: boolean;
  disabled?: boolean;
  /** A first entry outside the accounts, for example "Let UniHub choose" with the value that means it. */
  extra?: { value: string; label: string };
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
}

/**
 * Where a task or event goes: the person's lists and calendars grouped by
 * account, with the ones that cannot take the item greyed out and saying
 * why. The rules come with each calendar from the server (contracts/tasks.ts);
 * the chooser only shows them. The chosen entry shows its colour and name;
 * with more than one account, its account too.
 */
export function ListChooser({ id, calendars, value, onChange, undated = false, unavailable = {}, forTask = false, disabled, extra, placeholder = 'Choose a list', className, 'aria-label': ariaLabel }: Props) {
  const groups = useMemo(() => groupByAccount(calendars), [calendars]);
  const chosen = calendars.find(calendar => calendar.id === value);
  const severalAccounts = groups.length > 1;
  const reasonFor = (calendar: CalendarCalendar) => unavailable[calendar.id] ?? listRefusal(calendar, { undated });
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      {/* The chosen name stays on one line beside its dot and is cut with an ellipsis, so a useful prefix always
          shows. The control's value span (Radix's, styled through the trigger) takes the room left by the chevron
          and contributes no width of its own (contain: inline-size): a long name, with or without spaces, never
          widens the control past its box. The full name stays in the control's text and title. */}
      <SelectTrigger id={id} aria-label={ariaLabel} title={chosen?.name} className={cn('h-auto min-h-10 max-w-full text-left touch:min-h-11 [&>span]:flex-1 [&>span]:[contain:inline-size]', className)}>
        <SelectValue placeholder={placeholder}>
          {extra && value === extra.value && <span>{extra.label}</span>}
          {chosen && (
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: chosen.color }} />
              <span className="min-w-0 truncate">{chosen.name}</span>
              {severalAccounts && <span className="shrink-0 text-xs text-muted-foreground">{groups.find(group => group.calendars.includes(chosen))?.label}</span>}
            </span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {extra && <SelectItem value={extra.value}>{extra.label}</SelectItem>}
        {groups.map(group => (
          <SelectGroup key={group.label + group.calendars[0].account_id}>
            <SelectLabel className="text-xs font-normal text-muted-foreground">{group.label}</SelectLabel>
            {group.calendars.map(calendar => {
              const reason = reasonFor(calendar);
              const note = reason ?? (forTask && !calendar.auto_todo_enabled ? 'Not shown in ToDo' : null);
              return (
                <SelectItem key={calendar.id} value={calendar.id} disabled={!!reason} textValue={calendar.name}>
                  {/* The dot stays beside the first line; a long name wraps within the popup, and the note follows it. */}
                  <span className="flex min-w-0 items-start gap-2">
                    <span aria-hidden="true" className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: calendar.color }} />
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {calendar.name}
                      {note && <span className="ml-2 text-xs text-muted-foreground">{note}</span>}
                    </span>
                  </span>
                </SelectItem>
              );
            })}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
