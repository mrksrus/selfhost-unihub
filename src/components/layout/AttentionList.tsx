import { Link } from 'react-router-dom';
import { CheckCircle2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AttentionItem } from '@/hooks/use-attention';
import { cn } from '@/lib/utils';

/** The decisions waiting for the user, used by the rail's tray and the More page. */
export function AttentionList({ items, onNavigate, className }: { items: AttentionItem[]; onNavigate?: () => void; className?: string }) {
  if (!items.length) {
    return (
      <p className={cn('flex items-center gap-2 py-2 text-sm text-muted-foreground', className)}>
        <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-success" />
        Nothing needs your attention.
      </p>
    );
  }
  return (
    <ul className={cn('divide-y divide-border', className)}>
      {items.map(item => (
        <li key={item.id} className="py-3 first:pt-1 last:pb-1">
          <div className="flex items-start gap-3">
            <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-warning" />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium">{item.title}</p>
              {item.detail && <p className="break-words text-xs text-muted-foreground">{item.detail}</p>}
              {item.error && <p role="alert" className="text-xs text-destructive">{item.error}</p>}
              <div className="pt-1">
                {item.onAction ? (
                  <Button size="sm" variant="outline" disabled={item.busy} onClick={item.onAction}>{item.actionLabel}</Button>
                ) : item.href ? (
                  <Button size="sm" variant="outline" asChild><Link to={item.href} onClick={onNavigate}>{item.actionLabel}</Link></Button>
                ) : null}
              </div>
            </div>
            {item.onDismiss && (
              <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label={`Dismiss: ${item.title}`} onClick={item.onDismiss}>
                <X aria-hidden="true" />
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
