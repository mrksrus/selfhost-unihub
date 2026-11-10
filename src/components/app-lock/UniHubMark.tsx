import { cn } from '@/lib/utils';

/**
 * The UniHub mark in the account's accent: the rail's glyph, larger. The
 * Android app's native lock cover shows the page background with the launcher
 * mark instead (the app does not know the account's accent before the page
 * loads), so the mark changes when the page takes over from the cover.
 */
export function UniHubMark({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn('flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-2xl font-semibold text-accent-foreground', className)}>
      U
    </div>
  );
}
