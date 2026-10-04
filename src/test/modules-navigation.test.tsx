import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import StartRedirect from '@/pages/StartRedirect';
import ModuleGuard from '@/components/modules/ModuleGuard';
import ModuleSettings from '@/components/settings/ModuleSettings';
import BottomNav from '@/components/layout/BottomNav';
import { PAGES_QUERY_KEY, useModules, type ModulePreference, type PagePreference } from '@/hooks/use-modules';
import { defaultPages, knownModules } from '@/lib/modules';
import { api } from '@/lib/api';

vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function renderWithClient(children: React.ReactNode, modules?: ModulePreference[], path = '/', pages?: PagePreference[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (modules) client.setQueryData(['modules'], modules);
  if (pages) client.setQueryData(PAGES_QUERY_KEY, pages);
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}>{children}</MemoryRouter></QueryClientProvider>);
}
const module = (id: ModulePreference['id'], label: string, extra: Partial<ModulePreference> = {}): ModulePreference =>
  ({ id, label, visible: true, enabled: true, background: true, ...extra });
const defaults = [module('mail', 'Mail'), module('calendar', 'Calendar and ToDo'), module('contacts', 'Contacts'), module('recordings', 'Recordings and Music')];
const pageNames = (pages: PagePreference[]) => pages.map(page => page.label);
const reorder = (pages: PagePreference[], ids: string[]) => ids.map(id => pages.find(page => page.id === id)!);
function NavigationProbe() { const { canNavigate } = useModules(); return <span>{canNavigate('/contacts') ? 'Navigation shown' : 'Navigation hidden'}</span>; }

describe('optional module access', () => {
  it('keeps hidden modules accessible by direct route', () => {
    renderWithClient(<><NavigationProbe /><ModuleGuard id="contacts"><p>Contact content</p></ModuleGuard></>, [module('contacts', 'Contacts', { visible: false })]);
    expect(screen.getByText('Navigation hidden')).toBeInTheDocument();
    expect(screen.getByText('Contact content')).toBeInTheDocument();
  });
  it('does not mount a disabled page and keeps recovery reachable', () => {
    const mounted = vi.fn(); function Page() { mounted(); return <p>Private content</p>; }
    renderWithClient(<ModuleGuard id="contacts"><Page /></ModuleGuard>, [module('contacts', 'Contacts', { enabled: false })]);
    expect(mounted).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Data management' })).toHaveAttribute('href', '/settings?tab=data');
    expect(screen.getByText('Contacts is disabled')).toBeInTheDocument();
  });
  it('ignores removed modules in saved device snapshots', () => {
    const saved = [...defaults, { ...module('mail', 'Notes'), id: 'notes' as ModulePreference['id'] }];
    expect(knownModules(saved).map(item => item.id)).toEqual(['mail', 'calendar', 'contacts', 'recordings']);
  });
});

describe('pages', () => {
  it('follows the module order and module visibility until pages are set up', () => {
    const order = [defaults[3], { ...defaults[1], visible: false }, defaults[0], defaults[2]];
    const pages = defaultPages(order);
    expect(pageNames(pages)).toEqual(['Recordings', 'Music', 'Calendar', 'ToDo', 'Mail', 'Contacts', 'Today']);
    expect(pages.filter(page => !page.visible).map(page => page.id)).toEqual(['calendar', 'todo']);
  });

  it('shows and hides pages of one module separately but enables them together', () => {
    const pages = defaultPages(defaults).map(page => page.id === 'todo' || page.id === 'today' ? { ...page, visible: false } : page);
    renderWithClient(<BottomNav />, defaults, '/mail', pages);
    expect(within(screen.getByRole('navigation')).getAllByRole('link').map(link => link.textContent))
      .toEqual(['Mail', 'Calendar', 'Contacts', 'Recordings', 'More']);
    cleanup();
    const recordingsOff = defaults.map(item => item.id === 'recordings' ? { ...item, enabled: false } : item);
    function Probe() { const { canNavigate, canAccess } = useModules(); return <p>{[canNavigate('/music'), canAccess('/music'), canNavigate('/dashboard'), canNavigate('/todo'), canAccess('/todo')].join(' ')}</p>; }
    renderWithClient(<Probe />, recordingsOff, '/', pages);
    expect(screen.getByText('false false false false true')).toBeInTheDocument();
  });

  it('shows the first four pages in the mobile bar and marks More for the rest', () => {
    const pages = reorder(defaultPages(defaults), ['recordings', 'contacts', 'mail', 'today', 'calendar', 'todo', 'music']);
    renderWithClient(<BottomNav />, defaults, '/todo', pages);
    const links = within(screen.getByRole('navigation')).getAllByRole('link');
    expect(links.map(link => link.textContent)).toEqual(['Recordings', 'Contacts', 'Mail', 'Today', 'More']);
    expect(links[4].className).toContain('text-accent');
  });

  it('opens a hidden start page, and falls back to the first shown page when its module is disabled', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: { preferences: { default_start_page: 'music' } } });
    function Where() { return <p>At {useLocation().pathname}</p>; }
    const app = <Routes><Route path="/" element={<StartRedirect />} /><Route path="*" element={<Where />} /></Routes>;
    const pages = reorder(defaultPages(defaults), ['contacts', 'mail', 'calendar', 'todo', 'recordings', 'music', 'today'])
      .map(page => page.id === 'music' ? { ...page, visible: false } : page);
    renderWithClient(app, defaults, '/', pages);
    expect(await screen.findByText('At /music')).toBeInTheDocument();
    cleanup();
    renderWithClient(app, defaults.map(item => item.id === 'recordings' ? { ...item, enabled: false } : item), '/', pages);
    expect(await screen.findByText('At /contacts')).toBeInTheDocument();
  });

  it('moves a page and saves the full page order', async () => {
    const pages = defaultPages(defaults);
    const moved = reorder(pages, ['calendar', 'mail', 'todo', 'contacts', 'recordings', 'music', 'today']);
    const put = vi.spyOn(api, 'put').mockResolvedValue({ data: { modules: defaults, pages: moved } });
    renderWithClient(<ModuleSettings />, defaults, '/', pages);
    expect(screen.getByRole('button', { name: 'Move Mail up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Today down' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move Mail down' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/modules', { page_order: ['calendar', 'mail', 'todo', 'contacts', 'recordings', 'music', 'today'] }));
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 3 }).slice(0, 3).map(heading => heading.textContent))
      .toEqual(['Calendar', 'Mail', 'ToDo']));
  });

  it('hides one page without touching its module', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({ data: { modules: defaults, pages: defaultPages(defaults) } });
    renderWithClient(<ModuleSettings />, defaults, '/', defaultPages(defaults));
    fireEvent.click(screen.getByRole('switch', { name: 'Music: show in navigation' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/modules', { pages: { music: { visible: false } } }));
    expect(screen.queryByRole('switch', { name: 'Recordings and Music: visible' })).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Recordings and Music: enabled' })).toBeChecked();
  });

  it('puts rows back when the order is not saved', async () => {
    vi.spyOn(api, 'put').mockResolvedValue({ error: 'Page order must list every page once', status: 400 });
    renderWithClient(<ModuleSettings />, defaults, '/', defaultPages(defaults));
    fireEvent.click(screen.getByRole('button', { name: 'Move Contacts up' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Page order must list every page once');
    expect(screen.getAllByRole('heading', { level: 3 }).slice(0, 7).map(heading => heading.textContent))
      .toEqual(['Mail', 'Calendar', 'ToDo', 'Contacts', 'Recordings', 'Music', 'Today']);
  });
});
