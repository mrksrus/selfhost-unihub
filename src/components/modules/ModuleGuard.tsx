import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useModules, type ModuleId } from '@/hooks/use-modules';
import { Button } from '@/components/ui/button';
export default function ModuleGuard({ id, children }: { id: ModuleId; children: ReactNode }) {
  const { modules, isPending, error, isEnabled, refetch } = useModules();
  if (isPending) return <p role="status" className="p-6">Loading module preferences…</p>;
  if (error) return <section className="p-6 space-y-3"><p role="alert">Cannot check module access: {error.message}</p><Button onClick={() => void refetch()}>Try again</Button><Button asChild variant="outline"><Link to="/settings">Settings and recovery</Link></Button></section>;
  if (!isEnabled(id)) return <section className="p-6 space-y-3"><h1 className="text-2xl font-semibold">{modules.find(module => module.id === id)?.label || id} is disabled</h1><p className="max-w-prose text-muted-foreground">Your data is retained and included in full backups. Enable this module in Settings to use it again.</p><Button asChild><Link to="/settings?tab=modules">Module settings</Link></Button><Button asChild variant="outline"><Link to="/settings?tab=data">Data management</Link></Button></section>;
  return children;
}
