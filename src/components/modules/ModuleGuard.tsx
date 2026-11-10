import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PowerOff } from 'lucide-react';
import { useModules, type ModuleId } from '@/hooks/use-modules';
import { useAppLock } from '@/hooks/use-app-lock';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';
import { LockScreen } from '@/components/app-lock/LockScreen';
import { AppLockRequiredPrompt } from '@/components/app-lock/AppLockRequiredPrompt';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, StartingScreen } from '@/components/ui/page-states';

/** Shows a page only while its module is on and unlocked; otherwise the lock screen in the page's frame, or how to turn the module back on. */
export default function ModuleGuard({ id, children }: { id: ModuleId; children: ReactNode }) {
  const { modules, isPending, error, isEnabled, refetch, isFetching } = useModules();
  const lock = useAppLock();
  // Only until the modules are first known, which is while UniHub starts.
  if (isPending || lock.status === 'checking') return <StartingScreen />;
  if (error) return (
    <div className="p-6">
      <ErrorState title="Could not check whether this page is on" error={error} onRetry={() => void refetch()} retrying={isFetching} />
    </div>
  );
  if (!isEnabled(id)) return (
    <EmptyState icon={PowerOff} className="min-h-full px-6"
      title={`${modules.find(module => module.id === id)?.label || id} is disabled`}
      description="Its data is kept and included in full backups."
      action={<div className="flex flex-wrap justify-center gap-2">
        <Button asChild><Link to="/settings?section=pages">Module settings</Link></Button>
        <Button asChild variant="outline"><Link to="/settings?section=backup">Backup and restore</Link></Button>
      </div>} />
  );
  // The module's lock sits inside its page: header and body, nothing of the module itself.
  if (lock.locked(id)) {
    const label = modules.find(module => module.id === id)?.label || id;
    return (
      <PageShell>
        <PageHeader title={label} />
        <PageBody width="reading">
          {lock.status === 'setup' ? <AppLockRequiredPrompt area={id} variant="inline" /> : <LockScreen area={id} variant="inline" />}
        </PageBody>
      </PageShell>
    );
  }
  return children;
}
