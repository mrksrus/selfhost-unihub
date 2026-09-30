import { useState, type ComponentType } from 'react';
import { ChevronDown, ChevronRight, FolderOpen, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Folder = { id: string; label: string; icon: ComponentType<{ className?: string }> };
type Props = {
  folders: Folder[]; systemIds: string[]; selectedFolder: string; accountLabel: string;
  collapsed: boolean; unreadByFolder: Record<string, number>;
  onSelect: (id: string) => void; onManage: () => void;
};

export default function MailFolderNavigation({ folders, systemIds, selectedFolder, accountLabel,
  collapsed, unreadByFolder, onSelect, onManage }: Props) {
  const [search, setSearch] = useState('');
  const [customOpen, setCustomOpen] = useState(true);
  const query = search.trim().toLocaleLowerCase();
  const visible = folders.filter(folder => !query || folder.label.toLocaleLowerCase().includes(query));
  const isSystem = (folder: Folder) => folder.id === 'all' || systemIds.includes(folder.id);
  const builtins = visible.filter(isSystem);
  const custom = visible.filter(folder => !isSystem(folder));
  const renderFolder = (folder: Folder) => (
    <button key={folder.id} type="button" onClick={() => onSelect(folder.id)}
      aria-label={folder.label} aria-current={selectedFolder === folder.id ? 'page' : undefined}
      className={`relative flex w-full items-center rounded-md px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${collapsed ? 'justify-center' : 'gap-3'} ${selectedFolder === folder.id ? 'bg-accent/10 text-accent font-medium' : 'text-muted-foreground hover:bg-muted'}`}
      title={collapsed ? folder.label : undefined}>
      <folder.icon className="h-4 w-4 shrink-0" />
      {!collapsed && <><span className="min-w-0 flex-1 truncate text-left">{folder.label}</span>
        {folder.id !== 'all' && (unreadByFolder[folder.id] || 0) > 0 && <span className="tabular-nums text-xs">{unreadByFolder[folder.id]}</span>}</>}
      {collapsed && folder.id !== 'all' && (unreadByFolder[folder.id] || 0) > 0 && <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-accent" />}
    </button>
  );
  return <section className="flex min-h-0 flex-1 flex-col pt-4" aria-label="Mailbox folders">
    <div className={`flex items-center px-4 pb-2 ${collapsed ? 'justify-center' : 'justify-between gap-2'}`}>
      {!collapsed && <div className="min-w-0"><h2 className="text-sm font-medium">Folders</h2><p className="truncate text-xs text-muted-foreground" title={accountLabel}>{accountLabel}</p></div>}
      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onManage} aria-label="Manage folders"><FolderOpen className="h-4 w-4" /></Button>
    </div>
    {!collapsed && <div className="relative mx-3 mb-2"><Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="h-9 pl-8" aria-label="Find a folder" placeholder="Find a folder" value={search} onChange={event => setSearch(event.target.value)} /></div>}
    <nav aria-label="Mail folders" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 space-y-1">
      {builtins.map(renderFolder)}
      {custom.length > 0 && <>
        {!collapsed && <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={customOpen || !!query} onClick={() => setCustomOpen(!customOpen)}>
          {customOpen || query ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} Custom folders ({custom.length})
        </button>}
        {(collapsed || customOpen || query) && custom.map(renderFolder)}
      </>}
      {visible.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">No matching folders.</p>}
    </nav>
  </section>;
}
