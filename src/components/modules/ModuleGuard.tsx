import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PowerOff } from 'lucide-react';
import { useModules, type ModuleId } from '@/hooks/use-modules';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/page-states';

/** Shows a page only while its module is on; otherwise explains how to turn it back on. */
export default function ModuleGuard({ id, children }: { id: ModuleId; children: ReactNode }) {
  const { modules, isPending, error, isEnabled, refetch, isFetching } = useModules();
  if (isPending) return <LoadingState />;
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
  return children;
}
