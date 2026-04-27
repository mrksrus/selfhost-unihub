import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Calendar, CheckSquare, LayoutDashboard, Mail, Plus, Search, Settings, Users } from 'lucide-react';
import { api } from '@/lib/api';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';

type SearchResult = {
  id: string;
  type: 'contact' | 'mail' | 'calendar' | 'todo';
  title: string;
  subtitle?: string;
  href: string;
};

const staticActions = [
  { id: 'dashboard', label: 'Open Dashboard', href: '/', icon: LayoutDashboard },
  { id: 'contacts', label: 'Open Contacts', href: '/contacts', icon: Users },
  { id: 'new-contact', label: 'Add Contact', href: '/contacts?action=new', icon: Plus },
  { id: 'calendar', label: 'Open Calendar', href: '/calendar', icon: Calendar },
  { id: 'new-event', label: 'Create Event', href: '/calendar?action=new', icon: Plus },
  { id: 'todo', label: 'Open ToDo', href: '/todo', icon: CheckSquare },
  { id: 'mail', label: 'Open Mail', href: '/mail', icon: Mail },
  { id: 'compose', label: 'Compose Email', href: '/mail?action=compose', icon: Plus },
  { id: 'settings', label: 'Open Settings', href: '/settings', icon: Settings },
];

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
}

function getResultIcon(type: SearchResult['type']) {
  if (type === 'contact') return Users;
  if (type === 'mail') return Mail;
  if (type === 'todo') return CheckSquare;
  return Calendar;
}

const GlobalCommandPalette = () => {
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

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const { data: searchResults = [], isFetching } = useQuery({
    queryKey: ['global-search', debouncedQuery],
    queryFn: async () => {
      const response = await api.get<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(debouncedQuery)}&limit=6`);
      if (response.error) throw new Error(response.error);
      return response.data?.results || [];
    },
    enabled: open && debouncedQuery.trim().length >= 2,
    staleTime: 30000,
  });

  const filteredActions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return staticActions;
    return staticActions.filter((action) => action.label.toLowerCase().includes(needle));
  }, [query]);

  const runCommand = (href: string) => {
    setOpen(false);
    setQuery('');
    navigate(href);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder="Search mail, contacts, calendar, todos, or run a command..."
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>{isFetching ? 'Searching...' : 'No results found.'}</CommandEmpty>
        {filteredActions.length > 0 && (
          <CommandGroup heading="Commands">
            {filteredActions.map((action) => (
              <CommandItem key={action.id} value={action.label} onSelect={() => runCommand(action.href)}>
                <action.icon className="mr-2 h-4 w-4" />
                <span>{action.label}</span>
                {action.id === 'dashboard' && <CommandShortcut>Home</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {searchResults.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Search Results">
              {searchResults.map((result) => {
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
        {query.trim().length < 2 && (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
            <Search className="h-3.5 w-3.5" />
            Type at least two characters for global search.
          </div>
        )}
      </CommandList>
    </CommandDialog>
  );
};

export default GlobalCommandPalette;
