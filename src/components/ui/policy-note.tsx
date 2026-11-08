import { Lock } from 'lucide-react';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { ComponentProps, ReactNode } from 'react';

// How a policy shows anywhere in the app (F13, "the server decides, the
// client shows"): the control stays where it is, greyed out, and this note
// says why in the server's words. Never hide the control instead.

/** Why a control is greyed out: an administrator's policy. */
export function PolicyNote({ reason, className }: { reason: string; className?: string }) {
  return (
    <p className={cn('mt-1 flex items-start gap-1.5 text-xs text-muted-foreground', className)}>
      <Lock aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />{reason}
    </p>
  );
}

/**
 * A menu entry a policy may forbid: greyed out with its reason under the
 * label when `lock` is set, an ordinary entry otherwise.
 */
export function PolicyMenuItem({ lock, children, className, disabled, ...props }: ComponentProps<typeof DropdownMenuItem> & { lock?: string; children: ReactNode }) {
  return (
    <DropdownMenuItem {...props} disabled={disabled || !!lock} className={cn(lock && 'items-start', className)}>
      {lock ? (
        <span className="flex min-w-0 max-w-xs flex-col">
          <span>{children}</span>
          <span className="flex items-start gap-1 whitespace-normal text-xs text-muted-foreground"><Lock aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />{lock}</span>
        </span>
      ) : children}
    </DropdownMenuItem>
  );
}
