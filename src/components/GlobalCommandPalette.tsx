import { onAppEvent } from '@/lib/app-events';
import { useModules } from '@/hooks/use-modules';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Calendar, CheckSquare, Mail, Mic, Plus, Settings, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { navigationPages } from '@/lib/navigation';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';

type SearchResult = {
  id: string;
  type: 'contact' | 'mail' | 'calendar' | 'todo' | 'recording';
  title: string;
  subtitle?: string;
  href: string;
};

// Things to start from anywhere. Each link opens its page with the new item's form.
const createActions = [
  { id: 'compose', label: 'New email', href: '/mail?action=compose', icon: Mail },
  { id: 'new-event', label: 'New event', href: '/calendar?action=new', icon: Calendar },
  { id: 'new-task', label: 'New task', href: '/todo?action=new', icon: CheckSquare },
  { id: 'new-contact', label: 'New contact', href: '/contacts?action=new', icon: Users },
];

function getResultIcon(type: SearchResult['type']) {
  if (type === 'contact') return Users;
  if (type === 'mail') return Mail;
  if (type === 'recording') return Mic;
  if (type === 'todo') return CheckSquare;
  return Calendar;
}

const GlobalCommandPalette = () => {
  const { pages, canNavigate, canAccess } = useModules();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 200);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };

    const openCommandPalette = () => setOpen(true);

    window.addEventListener('keydown', onKeyDown);
    const stopListening = onAppEvent('unihub:open-search', openCommandPalette);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      stopListening();
    };
  }, []);

  const { data: searchResults = [], isFetching } = useQuery({
    queryKey: ['global-search', debouncedQuery],
    queryFn: async ({ signal }) => {
      const response = await api.get<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(debouncedQuery)}&limit=6`, { signal });
      if (response.error) throw new Error(response.error);
      return response.data?.results || [];
    },
    enabled: open && debouncedQuery.trim().length >= 2,
    staleTime: 30000,
  });

  const commands = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (label: string) => !needle || label.toLowerCase().includes(needle);
    return {
      create: createActions.filter(action => canAccess(action.href) && matches(action.label)),
      pages: [
        ...navigationPages(pages, canNavigate).map(page => ({ id: page.id, label: page.name, href: page.href, icon: page.icon })),
        { id: 'settings', label: 'Settings', href: '/settings', icon: Settings },
      ].filter(page => matches(page.label)),
    };
  }, [query, pages, canNavigate, canAccess]);

  const runCommand = (href: string) => {
    setOpen(false);
    setQuery('');
    navigate(href);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder="Search or go to…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>{isFetching ? 'Searching…' : 'Nothing found.'}</CommandEmpty>
        {commands.create.length > 0 && (
          <CommandGroup heading="Create">
            {commands.create.map(action => (
              <CommandItem key={action.id} value={action.label} onSelect={() => runCommand(action.href)}>
                <Plus className="mr-2 h-4 w-4" />
                <span>{action.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {commands.pages.length > 0 && (
          <CommandGroup heading="Go to">
            {commands.pages.map(page => (
              <CommandItem key={page.id} value={`Go to ${page.label}`} onSelect={() => runCommand(page.href)}>
                <page.icon className="mr-2 h-4 w-4" />
                <span>{page.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {searchResults.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Results">
              {searchResults.filter(result => canAccess(result.href)).map((result) => {
                const Icon = getResultIcon(result.type);
                return (
                  <CommandItem
                    key={result.id}
                    value={`${result.type} ${result.title} ${result.subtitle || ''}`}
                    onSelect={() => runCommand(result.href)}
                  >
                    <Icon className="mr-2 h-4 w-4" />
                    <div className="min-w-0">
                      <p className="truncate">{result.title}</p>
                      {result.subtitle && <p className="truncate text-xs text-muted-foreground">{result.subtitle}</p>}
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
};

export default GlobalCommandPalette;
