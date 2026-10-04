import { useModules, useReorderPages, useUpdateModule, useUpdatePage } from '@/hooks/use-modules';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { pageLink } from '@/lib/navigation';
export default function ModuleSettings() {
  const { modules, pages, isPending, error, refetch, isFetching } = useModules();
  const update = useUpdateModule();
  const updatePage = useUpdatePage();
  const reorder = useReorderPages();
  const move = (index: number, offset: number) => {
    const order = pages.map(page => page.id);
    [order[index], order[index + offset]] = [order[index + offset], order[index]];
    reorder.mutate(order);
  };
  const failure = update.error || updatePage.error || reorder.error;
  return <section className="space-y-8 max-w-4xl">
    {isPending && <LoadingState compact label="Loading modules…" />}
    {error && <ErrorState title="Could not load modules" error={error} onRetry={() => void refetch()} retrying={isFetching} />}
    {failure && <p role="alert" className="text-destructive">{failure.message}</p>}
    {!isPending && !error && <>
      <div className="space-y-4">
        <div><h2 className="text-xl font-semibold">Pages</h2><p className="text-sm text-muted-foreground mt-2 max-w-prose">Choose which pages appear in the navigation and in which order. On phones the first four are in the bottom bar, the rest under More. Hidden pages still open from links.</p></div>
        <div className="divide-y border rounded-md">{pages.map((page, index) => {
          const Icon = pageLink(page.id).icon;
          const module = modules.find(entry => entry.id === page.module);
          return <div key={page.id} className="p-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex flex-col">
                <Button type="button" variant="ghost" size="icon" className="h-6 w-6" aria-label={`Move ${page.label} up`} disabled={index === 0 || reorder.isPending} onClick={() => move(index, -1)}><ChevronUp className="h-4 w-4" /></Button>
                <Button type="button" variant="ghost" size="icon" className="h-6 w-6" aria-label={`Move ${page.label} down`} disabled={index === pages.length - 1 || reorder.isPending} onClick={() => move(index, 1)}><ChevronDown className="h-4 w-4" /></Button>
              </div>
              <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="min-w-0"><h3 className="font-medium">{page.label}</h3>{module && !module.enabled && <p className="text-xs text-muted-foreground">Off while {module.label} is disabled</p>}</div>
            </div>
            <label className="flex items-center gap-2 text-sm shrink-0"><Switch aria-label={`${page.label}: show in navigation`} checked={page.visible} disabled={updatePage.isPending} onCheckedChange={visible => updatePage.mutate({ id: page.id, visible })} /><span className="sm:hidden">Show</span><span className="hidden sm:inline">Show in navigation</span></label>
          </div>;
        })}</div>
      </div>
      <div className="space-y-4">
        <div><h2 className="text-xl font-semibold">Modules</h2><p className="text-sm text-muted-foreground mt-2 max-w-prose">A module switches all of its pages on or off together. Disabled modules keep their data, and backups still include it.</p></div>
        <div className="divide-y border rounded-md">{modules.map(module => <div key={module.id} className="p-4 flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-32"><h3 className="font-medium">{module.label}</h3><p className="text-xs text-muted-foreground">{pages.filter(page => page.module === module.id).map(page => page.label).join(', ')}</p></div>
          <div className="flex flex-wrap gap-5">{(['enabled', 'background'] as const).filter(key => key !== 'background' || module.backgroundSupported).map(key => <label key={key} className="flex items-center gap-2 text-sm"><Switch aria-label={`${module.label}: ${key}`} checked={module[key]} disabled={update.isPending} onCheckedChange={value => update.mutate({ id: module.id, patch: { [key]: value } })} />{key === 'enabled' ? 'Enabled' : 'Background work'}</label>)}</div>
        </div>)}</div>
      </div>
    </>}
  </section>;
}
