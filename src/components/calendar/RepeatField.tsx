import { useState } from 'react';
import { addYears, format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { WEEK, monthlyRules, repeatChoices, sameRule, type RepeatRule } from '@/components/calendar/repeat';

const UNITS: Record<RepeatRule['freq'], string> = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };
const bounded = (text: string, max: number) => Math.min(max, Math.max(1, Math.round(Number(text)) || 1));

/**
 * How an event repeats: the ready-made rules for the day it starts on, or a
 * custom one (every so many days, weeks, months or years, on which weekdays,
 * until when). `disabled` while the rule of an existing series is loading.
 */
export function RepeatField({ value, start: given, onChange, disabled }: { value: RepeatRule | null; start: Date; onChange: (rule: RepeatRule | null) => void; disabled?: boolean }) {
  // A start being typed is no date yet.
  const start = Number.isNaN(given.getTime()) ? new Date() : given;
  const choices = repeatChoices(start);
  const preset = choices.findIndex(choice => sameRule(choice.rule, value));
  // A custom rule that happens to equal a ready-made one stays open while it is being edited.
  const [custom, setCustom] = useState(false);
  const open = !!value && (custom || preset === -1);
  const weekly = choices[2].rule!;
  const monthly = monthlyRules(start);
  const rule = value ?? weekly;
  const set = (change: Partial<RepeatRule>) => onChange({ ...rule, ...change });
  const ends = rule.count !== undefined ? 'count' : rule.until !== undefined ? 'until' : 'never';
  const every = (rule.interval ?? 1) > 1;

  return (
    <div className="space-y-2">
      <Label htmlFor="event-repeat">Repeat</Label>
      <Select value={open ? 'custom' : String(Math.max(preset, 0))} disabled={disabled} onValueChange={next => {
        setCustom(next === 'custom');
        if (next !== 'custom') onChange(choices[Number(next)].rule);
        else if (!value) onChange(weekly);
      }}>
        <SelectTrigger id="event-repeat"><SelectValue /></SelectTrigger>
        <SelectContent>
          {choices.map((choice, index) => <SelectItem key={choice.label} value={String(index)}>{choice.label}</SelectItem>)}
          <SelectItem value="custom">Custom…</SelectItem>
        </SelectContent>
      </Select>
      {open && (
        <div role="group" aria-label="Custom repeat" className="space-y-3 rounded-md bg-muted/60 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span>Every</span>
            <Input type="number" inputMode="numeric" min={1} max={99} aria-label="Every how many" className="w-20" value={rule.interval ?? 1}
              onChange={event => set({ interval: bounded(event.target.value, 99) })} />
            <Select value={rule.freq} onValueChange={next => {
              const freq = next as RepeatRule['freq'];
              const base: RepeatRule = freq === 'WEEKLY' ? weekly : freq === 'MONTHLY' ? monthly[0].rule : { freq };
              onChange({ ...base, interval: rule.interval, count: rule.count, until: rule.until });
            }}>
              <SelectTrigger aria-label="Days, weeks, months or years" className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(UNITS).map(([freq, unit]) => <SelectItem key={freq} value={freq}>{every ? `${unit}s` : unit}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {rule.freq === 'WEEKLY' && (
            <div role="group" aria-label="On these weekdays" className="grid grid-cols-7 gap-1.5">
              {WEEK.map(day => {
                const on = rule.by_day?.includes(day.code) ?? false;
                return (
                  // A weekly rule keeps at least one day.
                  <Button key={day.code} type="button" size="sm" variant={on ? 'default' : 'outline'} className="px-0" aria-pressed={on} aria-label={day.name} disabled={on && rule.by_day?.length === 1}
                    onClick={() => set({ by_day: on ? rule.by_day!.filter(code => code !== day.code) : [...(rule.by_day ?? []), day.code] })}>
                    {day.name.slice(0, 3)}
                  </Button>
                );
              })}
            </div>
          )}
          {rule.freq === 'MONTHLY' && <>
            <Select value={rule.by_day ? '1' : '0'} onValueChange={next => onChange({ ...rule, by_day: undefined, by_month_day: undefined, ...monthly[Number(next)].rule })}>
              <SelectTrigger aria-label="On which day of the month"><SelectValue /></SelectTrigger>
              <SelectContent>{monthly.map((choice, index) => <SelectItem key={choice.label} value={String(index)}>{choice.label.replace(/^on/, 'On')}</SelectItem>)}</SelectContent>
            </Select>
            {(rule.by_month_day ?? 0) > 28 && <p className="text-xs text-muted-foreground">Months without a day {rule.by_month_day} are skipped.</p>}
          </>}
          <div className="flex flex-wrap items-center gap-2">
            <span>Ends</span>
            <Select value={ends} onValueChange={next => onChange({
              ...rule, count: next === 'count' ? rule.count ?? 10 : undefined, until: next === 'until' ? rule.until ?? format(addYears(start, 1), 'yyyy-MM-dd') : undefined,
            })}>
              <SelectTrigger aria-label="Ends" className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="never">Never</SelectItem>
                <SelectItem value="until">On a date</SelectItem>
                <SelectItem value="count">After</SelectItem>
              </SelectContent>
            </Select>
            {ends === 'until' && <Input type="date" aria-label="Last date" className="w-40" value={rule.until} onChange={event => { if (event.target.value) set({ until: event.target.value }); }} />}
            {ends === 'count' && <>
              <Input type="number" inputMode="numeric" min={1} max={999} aria-label="Number of times" className="w-20" value={rule.count}
                onChange={event => set({ count: bounded(event.target.value, 999) })} />
              <span>times</span>
            </>}
          </div>
        </div>
      )}
    </div>
  );
}
