import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ModuleGuard from '@/components/modules/ModuleGuard';
import ModuleSettings from '@/components/settings/ModuleSettings';
import BottomNav from '@/components/layout/BottomNav';
import { useModules, type ModulePreference } from '@/hooks/use-modules';
import { orderedModulePages } from '@/lib/navigation';
import { knownModules } from '@/lib/modules';
import { api } from '@/lib/api';

vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function renderWithClient(children: React.ReactNode, modules?: ModulePreference[], path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (modules) client.setQueryData(['modules'], modules);
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}>{children}</MemoryRouter></QueryClientProvider>);
}
const module = (id: ModulePreference['id'], label: string, extra: Partial<ModulePreference> = {}): ModulePreference =>
  ({ id, label, visible: true, enabled: true, background: true, ...extra });
const defaults = [module('mail', 'Mail'), module('calendar', 'Calendar and ToDo'), module('contacts', 'Contacts'), module('recordings', 'Recordings')];
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

describe('module order', () => {
  it('orders module pages by the saved module order and keeps Calendar before ToDo', () => {
    const order = [defaults[3], defaults[1], defaults[0], defaults[2]];
    expect(orderedModulePages(order, () => true).map(page => page.name)).toEqual(['Recordings', 'Calendar', 'ToDo', 'Mail', 'Contacts']);
    expect(orderedModulePages(order, href => href !== '/calendar').map(page => page.name)).toEqual(['Recordings', 'ToDo', 'Mail', 'Contacts']);
  });

  it('shows the first four pages in the mobile bar and marks More for the rest', () => {
    renderWithClient(<BottomNav />, [defaults[3], defaults[2], defaults[0], defaults[1]], '/todo');
    const links = within(screen.getByRole('navigation')).getAllByRole('link');
    expect(links.map(link => link.textContent)).toEqual(['Recordings', 'Contacts', 'Mail', 'Calendar', 'More']);
    expect(links[4].className).toContain('text-accent');
  });

  it('moves a module and saves the full order', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({ data: { modules: [defaults[1], defaults[0], defaults[2], defaults[3]] } });
    renderWithClient(<ModuleSettings />, defaults);
    expect(screen.getByRole('button', { name: 'Move Mail up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Recordings down' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move Mail down' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/modules', { order: ['calendar', 'mail', 'contacts', 'recordings'] }));
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent))
      .toEqual(['Calendar and ToDo', 'Mail', 'Contacts', 'Recordings']));
  });

  it('puts rows back when the order is not saved', async () => {
    vi.spyOn(api, 'put').mockResolvedValue({ error: 'Module order must list every module once', status: 400 });
    renderWithClient(<ModuleSettings />, defaults);
    fireEvent.click(screen.getByRole('button', { name: 'Move Contacts up' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Module order must list every module once');
    expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual(['Mail', 'Calendar and ToDo', 'Contacts', 'Recordings']);
  });
});
