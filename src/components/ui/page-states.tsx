import type { ComponentType, ReactNode } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type IconType = ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;

type LoadingStateProps = {
  /** Visible and announced text, for example "Loading contacts…". */
  label?: string;
  /** Use less vertical space inside cards and side panels. */
  compact?: boolean;
  className?: string;
};

/** Spinner with a visible label. Announced politely; the spinner stops when reduced motion is requested. */
export function LoadingState({ label = 'Loading…', compact = false, className }: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('flex flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground', compact ? 'py-4' : 'py-10', className)}
    >
      <Loader2 aria-hidden="true" className="h-6 w-6 text-accent motion-safe:animate-spin" />
      <span>{label}</span>
    </div>
  );
}

type EmptyStateProps = {
  icon?: IconType;
  title: string;
  description?: ReactNode;
  /** Optional call to action, usually a Button. */
  action?: ReactNode;
  compact?: boolean;
  className?: string;
};

/** Neutral message for a list or view that loaded successfully but has nothing to show. */
export function EmptyState({ icon: Icon, title, description, action, compact = false, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center text-muted-foreground', compact ? 'py-4' : 'py-10', className)}>
      {Icon && <Icon aria-hidden="true" className={cn('mb-3 opacity-50', compact ? 'h-8 w-8' : 'h-10 w-10')} />}
      <p className="font-medium text-foreground">{title}</p>
      {description && <p className="mt-1 text-sm">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

function errorMessage(error: unknown, fallback = 'Something went wrong. Check your connection and try again.') {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}

type ErrorStateProps = {
  title: string;
  /** The query error or a message; shown below the title. */
  error?: unknown;
  /** Usually `() => void query.refetch()`. Omit when retrying cannot help. */
  onRetry?: () => void;
  /** Disable the retry button while a refetch is running. */
  retrying?: boolean;
  className?: string;
};

/** Visible, announced failure with an optional retry, used instead of an endless spinner or a silently empty list. */
export function ErrorState({ title, error, onRetry, retrying = false, className }: ErrorStateProps) {
  return (
    <Alert variant="destructive" className={className}>
      <AlertCircle aria-hidden="true" className="h-4 w-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{errorMessage(error)}</p>
        {onRetry && (
          <Button type="button" size="sm" variant="outline" className="text-foreground" onClick={onRetry} disabled={retrying}>
            {retrying && <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 motion-safe:animate-spin" />}
            Try again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
