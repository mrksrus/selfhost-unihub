import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { useAppLock, type AppLockArea } from '@/hooks/use-app-lock';
import { useModules } from '@/hooks/use-modules';
import { Button } from '@/components/ui/button';
import { UnlockDialog } from '@/components/app-lock/UnlockDialog';
import { areaLabel } from '@/components/app-lock/area-names';
import { cn } from '@/lib/utils';

const MODULE_PATHS: Partial<Record<AppLockArea, string>> = { mail: '/mail', contacts: '/contacts', calendar: '/calendar', recordings: '/recordings' };

interface LockedNoticeProps {
  area: AppLockArea;
  /** What unlocking shows here, e.g. "Unlock to see unread mail here." */
  description?: string;
  /** Centred, for a panel or sheet that holds nothing else. */
  centered?: boolean;
  className?: string;
}

/**
 * Where a locked module would show something: one row that names the lock
 * and offers the unlock in place. The same row on the dashboard, in the email
 * peek, in the search and in Settings. While nothing can unlock yet (the lock
 * is being set up), it points to the module's page, which holds the set-up.
 */
export function LockedNotice({ area, description, centered = false, className }: LockedNoticeProps) {
  const lock = useAppLock();
  const { modules } = useModules();
  const [open, setOpen] = useState(false);
  const label = areaLabel(area, modules);
  const setup = lock.status === 'setup';
  return (
    <div className={cn('flex items-center gap-3 py-2.5', centered && 'flex-col justify-center py-10 text-center', className)}>
      <Lock aria-hidden="true" className={cn('shrink-0 text-muted-foreground', centered ? 'h-8 w-8 opacity-60' : 'h-4 w-4')} />
      <div className={cn('min-w-0', !centered && 'flex-1')}>
        <p className="text-sm font-medium">{label} is locked</p>
        <p className="text-sm text-muted-foreground">{description ?? `Unlock to see ${label} here.`}</p>
      </div>
      {setup && MODULE_PATHS[area]
        ? <Button asChild size="sm" variant="outline"><Link to={MODULE_PATHS[area]!}>Set up the app lock</Link></Button>
        : <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Unlock</Button>}
      <UnlockDialog open={open} onOpenChange={setOpen} onSuccess={() => undefined} />
    </div>
  );
}
