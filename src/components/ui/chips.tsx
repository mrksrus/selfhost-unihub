import type { ComponentType, ReactNode } from 'react';
import { cn } from '@/lib/utils';

type IconType = ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;

/**
 * A short row of choices (views, lists, quick dates) shown in full instead of
 * behind a panel or menu. On narrow windows the row scrolls sideways and bleeds
 * to the window edges; on wide ones it wraps.
 */
export function ChipGroup({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="radiogroup" aria-label={label}
      className={cn('-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] md:mx-0 md:flex-wrap md:overflow-visible md:px-0 [&::-webkit-scrollbar]:hidden', className)}>
      {children}
    </div>
  );
}

interface ChipProps {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
  /** A small colored dot before the name (calendar colors). */
  color?: string;
  icon?: IconType;
  /** A number after the name, e.g. open tasks. Hidden when 0 or null. */
  count?: number | null;
  /** What the count means, read after the name, e.g. "tasks". */
  countLabel?: string;
  countTone?: 'default' | 'warning';
  className?: string;
}

/** One pill in a ChipGroup. */
export function Chip({ selected, onSelect, children, color, icon: Icon, count, countLabel, countTone = 'default', className }: ChipProps) {
  return (
    <button type="button" role="radio" aria-checked={selected} onClick={onSelect}
      className={cn('inline-flex h-8 max-w-full shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected ? 'border-foreground bg-foreground text-background' : 'border-border text-foreground hover:bg-muted', className)}>
      {color && <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />}
      {Icon && <Icon aria-hidden="true" className="-ml-1 h-3.5 w-3.5 shrink-0" />}
      <span className="truncate">{children}</span>
      {count ? <>
        <span aria-hidden="true" className={cn('text-xs tabular-nums', countTone === 'warning' && !selected ? 'text-warning' : selected ? 'text-background/70' : 'text-muted-foreground')}>{count}</span>
        {countLabel && <span className="sr-only">, {count} {countLabel}</span>}
      </> : null}
    </button>
  );
}
