import { useModules, useReorderModules, useUpdateModule } from '@/hooks/use-modules';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { ChevronDown, ChevronUp } from 'lucide-react';
export default function ModuleSettings() {
  const { modules, isPending, error, refetch, isFetching } = useModules();
  const update = useUpdateModule();
  const reorder = useReorderModules();
  const move = (index: number, offset: number) => {
    const order = modules.map(module => module.id);
    [order[index], order[index + offset]] = [order[index + offset], order[index]];
    reorder.mutate(order);
  };
  const failure = update.error || reorder.error;
  return <section className="space-y-5 max-w-4xl"><div><h2 className="text-xl font-semibold">Modules</h2><p className="text-sm text-muted-foreground mt-2 max-w-prose">Disabled modules keep their data, and backups still include it.</p></div>
    {isPending && <LoadingState compact label="Loading modules…" />}
    {error && <ErrorState title="Could not load modules" error={error} onRetry={() => void refetch()} retrying={isFetching} />}
    {failure && <p role="alert" className="text-destructive">{failure.message}</p>}
    <div className="divide-y border rounded-md">{modules.map((module, index) => <div key={module.id} className="p-4 flex flex-wrap items-center justify-between gap-4"><div className="flex items-center gap-2 min-w-32"><div className="flex flex-col"><Button type="button" variant="ghost" size="icon" className="h-6 w-6" aria-label={`Move ${module.label} up`} disabled={index === 0 || reorder.isPending} onClick={() => move(index, -1)}><ChevronUp className="h-4 w-4" /></Button><Button type="button" variant="ghost" size="icon" className="h-6 w-6" aria-label={`Move ${module.label} down`} disabled={index === modules.length - 1 || reorder.isPending} onClick={() => move(index, 1)}><ChevronDown className="h-4 w-4" /></Button></div><h3 className="font-medium">{module.label}</h3></div><div className="flex flex-wrap gap-5">{(['visible', 'enabled', 'background'] as const).filter(key => key !== 'background' || module.backgroundSupported).map(key => <label key={key} className="flex items-center gap-2 text-sm"><Switch aria-label={`${module.label}: ${key}`} checked={module[key]} disabled={update.isPending} onCheckedChange={value => update.mutate({ id: module.id, patch: { [key]: value } })} />{key === 'visible' ? 'Show in navigation' : key === 'enabled' ? 'Enabled' : 'Background work'}</label>)}</div></div>)}</div>
  </section>;
}
