import { forwardRef, type ComponentProps } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * The UniHub PIN as typed: digits only on a phone keyboard, hidden as it is
 * entered, in the monospace face with wide tracking so each digit reads as a
 * slot. Its label stays for assistive technology; the row around it says what
 * the PIN is for.
 */
export const PinField = forwardRef<HTMLInputElement, Omit<ComponentProps<typeof Input>, 'type' | 'inputMode'> & { id: string; label: string; showLabel?: boolean; hint?: string }>(
  ({ id, label, showLabel = false, hint, className, ...props }, ref) => (
    <div className="space-y-1.5">
      <Label htmlFor={id} className={showLabel ? undefined : 'sr-only'}>{label}</Label>
      <Input ref={ref} id={id} type="password" inputMode="numeric" autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={12}
        placeholder={showLabel ? undefined : label} aria-describedby={props['aria-describedby']}
        className={cn('h-12 text-center font-mono text-xl tracking-[0.4em] placeholder:font-sans placeholder:text-base placeholder:tracking-normal touch:h-12', className)} {...props} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  ),
);
PinField.displayName = 'PinField';
