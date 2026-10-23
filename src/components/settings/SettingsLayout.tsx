import { useId, type ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { cn } from '@/lib/utils';

/** A titled group of settings rows. Sections stack with space between them, never boxes. */
export function SettingsSection({ title, description, action, children, className }: {
  title: string; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn('mb-10 last:mb-0', className)}>
      <div className="mb-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id={id} className="text-base font-semibold">{title}</h2>
          {description && <p className="mt-1 max-w-prose text-sm text-muted-foreground">{description}</p>}
        </div>
        {action && <div className="flex shrink-0 flex-wrap justify-end gap-2">{action}</div>}
      </div>
      <div className="divide-y divide-border border-y border-border">{children}</div>
    </section>
  );
}

/**
 * One setting: what it is on the left, its control on the right (below on
 * phones). `lock` is the reason a policy fixes or narrows the choice; the row
 * says so under its description and the caller disables the control.
 */
export function SettingsRow({ label, description, htmlFor, children, tone = 'default', lock, stack = false, className }: {
  label: ReactNode; description?: ReactNode; htmlFor?: string; children?: ReactNode; tone?: 'default' | 'destructive'; lock?: string;
  /** The control takes the full width under the label at every width (a list of choices, not one control). */
  stack?: boolean; className?: string;
}) {
  const Label = htmlFor ? 'label' : 'p';
  return (
    <div className={cn('flex flex-col gap-3 py-4', !stack && 'sm:flex-row sm:items-center sm:justify-between sm:gap-6', className)}>
      <div className="min-w-0">
        <Label htmlFor={htmlFor} className={cn('block text-sm font-medium', tone === 'destructive' && 'text-destructive')}>{label}</Label>
        {description && <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>}
        {lock && <PolicyNote reason={lock} />}
      </div>
      {children && <div className={cn('flex flex-wrap items-center gap-2', stack ? 'w-full' : 'shrink-0 sm:justify-end')}>{children}</div>}
    </div>
  );
}

/** Content inside a section that is not a label and control pair (lists, forms, notes). */
export function SettingsBlock({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('py-4', className)}>{children}</div>;
}

/** Why a control is greyed out: an administrator's policy. */
export function PolicyNote({ reason, className }: { reason: string; className?: string }) {
  return (
    <p className={cn('mt-1 flex items-center gap-1.5 text-xs text-muted-foreground', className)}>
      <Lock aria-hidden="true" className="h-3 w-3 shrink-0" />{reason}
    </p>
  );
}
