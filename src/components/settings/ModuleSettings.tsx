import { MoreHorizontal } from 'lucide-react';
import { useModules, useReorderPages, useUpdateModule, useUpdatePage } from '@/hooks/use-modules';
import type { PagePreference } from '@/lib/modules';
import { pageLink } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { DragHandle, SortableList, draggingRowClass } from '@/components/ui/sortable-list';
import { SettingsSection } from '@/components/settings/SettingsLayout';

const pageId = (page: PagePreference) => page.id;
const pageName = (page: PagePreference) => page.label;

export default function ModuleSettings() {
  const { modules, pages, isPending, error, refetch, isFetching } = useModules();
  const update = useUpdateModule();
  const updatePage = useUpdatePage();
  const reorder = useReorderPages();
  // Dragging a row or Move up/down from its menu saves the whole order, as before; the rail and bottom bar follow.
  const move = (index: number, offset: number) => {
    const order = pages.map(page => page.id);
    [order[index], order[index + offset]] = [order[index + offset], order[index]];
    reorder.mutate(order);
  };
  const failure = update.error || updatePage.error || reorder.error;

  if (isPending) return <LoadingState compact label="Loading modules…" />;
  if (error) return <ErrorState title="Could not load modules" error={error} onRetry={() => void refetch()} retrying={isFetching} />;

  return (
    <>
      {failure && <p role="alert" className="mb-4 text-sm text-destructive">{failure.message}</p>}
      <SettingsSection title="Pages" description="Drag a page by its handle, or use its menu. On phones, the first four are in the bottom bar and the rest under More.">
        <SortableList items={pages} getId={pageId} getName={pageName} label="Pages" disabled={reorder.isPending} aria-label="Pages" className="divide-y divide-border"
          onReorder={({ order }) => reorder.mutate(order.map(page => page.id))}>
          {(page, row, index) => {
            const Icon = pageLink(page.id).icon;
            const module = modules.find(entry => entry.id === page.module);
            return (
              <li key={page.id} ref={row.setNodeRef} style={row.style} className={cn('flex items-center justify-between gap-3 py-2', row.dragging && draggingRowClass)}>
                <div className="flex min-w-0 items-center gap-2">
                  <DragHandle {...row.handle} label={`Reorder ${page.label}`} dragging={row.dragging} className="sm:-ml-2" />
                  <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <h3 className="text-sm font-medium">{page.label}</h3>
                    {module && !module.enabled && <p className="text-xs text-muted-foreground">Off while {module.label} is turned off</p>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 touch:gap-3">
                  <label className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span className="hidden sm:inline">Show in navigation</span>
                    <Switch aria-label={`${page.label}: show in navigation`} checked={page.visible} disabled={updatePage.isPending} onCheckedChange={visible => updatePage.mutate({ id: page.id, visible })} />
                  </label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="ghost" size="icon-sm" className="-mr-2 text-muted-foreground" aria-label={`More actions for ${page.label}`}>
                        <MoreHorizontal aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem disabled={index === 0 || reorder.isPending} onClick={() => move(index, -1)}>Move up</DropdownMenuItem>
                      <DropdownMenuItem disabled={index === pages.length - 1 || reorder.isPending} onClick={() => move(index, 1)}>Move down</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </li>
            );
          }}
        </SortableList>
      </SettingsSection>
      <SettingsSection title="Modules" description="A module that is off keeps its data, and backups include it.">
        {modules.map(module => (
          <div key={module.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
            <div className="min-w-32">
              <h3 className="text-sm font-medium">{module.label}</h3>
              {pages.filter(page => page.module === module.id).length > 1 && (
                <p className="text-xs text-muted-foreground">{pages.filter(page => page.module === module.id).map(page => page.label).join(', ')}</p>
              )}
            </div>
            <div className="flex flex-wrap gap-5">
              {(['enabled', 'background'] as const).filter(key => key !== 'background' || module.backgroundSupported).map(key => (
                <label key={key} className="flex items-center gap-2 text-sm text-muted-foreground">
                  {key === 'enabled' ? 'On' : 'Background work'}
                  <Switch aria-label={`${module.label}: ${key}`} checked={module[key]} disabled={update.isPending} onCheckedChange={value => update.mutate({ id: module.id, patch: { [key]: value } })} />
                </label>
              ))}
            </div>
          </div>
        ))}
      </SettingsSection>
    </>
  );
}
