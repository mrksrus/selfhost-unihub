import { useModules, useUpdateModule } from '@/hooks/use-modules';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
export default function ModuleSettings() {
  const { modules, isPending, error, refetch } = useModules();
  const update = useUpdateModule();
  return <section className="space-y-5 max-w-4xl"><div><h2 className="text-xl font-semibold">Modules</h2><p className="text-sm text-muted-foreground mt-2 max-w-prose">Hide a module to remove navigation links. Disable it to stop access. Background work has its own switch and only runs for enabled modules. Your data stays in place and full backups include disabled modules. Calendar and ToDo share these settings. Disabling a module clears this browser’s offline copy. Refresh or clear saved offline data on other devices separately.</p></div>
    {isPending && <p role="status">Loading modules…</p>}
    {error && <div role="alert">{error.message} <Button variant="outline" onClick={() => void refetch()}>Try again</Button></div>}
    {update.error && <p role="alert" className="text-destructive">{update.error.message}</p>}
    <div className="divide-y border rounded-md">{modules.map(module => <div key={module.id} className="p-4 flex flex-wrap items-center justify-between gap-4"><h3 className="font-medium min-w-32">{module.label}</h3><div className="flex flex-wrap gap-5">{(['visible', 'enabled', 'background'] as const).filter(key => key !== 'background' || module.backgroundSupported).map(key => <label key={key} className="flex items-center gap-2 text-sm"><Switch aria-label={`${module.label}: ${key}`} checked={module[key]} disabled={update.isPending} onCheckedChange={value => update.mutate({ id: module.id, patch: { [key]: value } })} />{key === 'visible' ? 'Show in navigation' : key === 'enabled' ? 'Enabled' : 'Background work'}</label>)}</div></div>)}</div>
  </section>;
}
