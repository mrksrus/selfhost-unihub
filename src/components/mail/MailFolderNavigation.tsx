import { useState, type ComponentType } from 'react';
import { ChevronDown, ChevronRight, FolderCog, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PanelGroup, PanelItem } from '@/components/layout/PageShell';

type Folder = { id: string; label: string; icon: ComponentType<{ className?: string }> };
type Props = {
  folders: Folder[]; systemIds: string[]; selectedFolder: string; accountLabel: string;
  unreadByFolder: Record<string, number>;
  onSelect: (id: string) => void; onManage: () => void;
};

// A filter field only helps once the list is long.
const FILTER_FROM = 12;

export default function MailFolderNavigation({ folders, systemIds, selectedFolder, accountLabel,
  unreadByFolder, onSelect, onManage }: Props) {
  const [search, setSearch] = useState('');
  const [customOpen, setCustomOpen] = useState(true);
  const query = search.trim().toLocaleLowerCase();
  const visible = folders.filter(folder => !query || folder.label.toLocaleLowerCase().includes(query));
  const isSystem = (folder: Folder) => folder.id === 'all' || systemIds.includes(folder.id);
  const builtins = visible.filter(isSystem);
  const custom = visible.filter(folder => !isSystem(folder));
  const renderFolder = (folder: Folder) => (
    <PanelItem key={folder.id} icon={folder.icon} active={selectedFolder === folder.id} onSelect={() => onSelect(folder.id)}
      count={folder.id !== 'all' ? unreadByFolder[folder.id] || 0 : 0} countLabel="unread">
      {folder.label}
    </PanelItem>
  );
  return <section className="flex min-h-0 flex-1 flex-col border-t border-border" aria-label="Mailbox folders">
    <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-3">
      <div className="min-w-0"><h2 className="text-xs font-medium text-muted-foreground">Folders</h2>
        <p className="truncate text-xs text-muted-foreground/80" title={accountLabel}>{accountLabel}</p></div>
      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onManage} aria-label="Manage folders"><FolderCog aria-hidden="true" /></Button>
    </div>
    {folders.length >= FILTER_FROM && <div className="relative mx-3 mb-1 mt-1"><Search aria-hidden="true" className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
      <Input className="h-9 pl-8" aria-label="Find a folder" placeholder="Find a folder" value={search} onChange={event => setSearch(event.target.value)} /></div>}
    <nav aria-label="Mail folders" className="min-h-0 flex-1 overflow-y-auto pb-3">
      <PanelGroup className="py-1">{builtins.map(renderFolder)}</PanelGroup>
      {custom.length > 0 && <PanelGroup className="py-1">
        <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={customOpen || !!query} onClick={() => setCustomOpen(!customOpen)}>
          {customOpen || query ? <ChevronDown aria-hidden="true" className="h-3 w-3" /> : <ChevronRight aria-hidden="true" className="h-3 w-3" />} Custom folders ({custom.length})
        </button>
        {(customOpen || query) && custom.map(renderFolder)}
      </PanelGroup>}
      {visible.length === 0 && <p className="px-4 py-2 text-sm text-muted-foreground">No matching folders.</p>}
    </nav>
  </section>;
}
