import { cn } from '@/lib/utils';

/**
 * The UniHub mark in the account's accent: the rail's glyph, larger. The
 * Android app's native lock cover draws the same (the page background and
 * this mark centred, 56 dp, corner radius 16 dp, the accent colour, "U" in
 * Inter semibold at 24 sp in the accent's foreground), so handing over to the
 * page is seamless.
 */
export function UniHubMark({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn('flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-2xl font-semibold text-accent-foreground', className)}>
      U
    </div>
  );
}
