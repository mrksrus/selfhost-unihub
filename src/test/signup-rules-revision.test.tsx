import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '@/contexts/AuthContext';
import Auth from '@/pages/Auth';
import { api } from '@/lib/api';

vi.mock('@/utils/service-worker', () => ({
  resetBackgroundNotificationState: vi.fn(async () => {}),
  revokeDevicePushSubscription: vi.fn(async () => {}),
}));
vi.mock('@/lib/offline', () => ({
  clearOfflineData: vi.fn(async () => {}), loadOfflineSession: vi.fn(async () => null),
  setOfflineAccount: vi.fn(), setOfflineMode: vi.fn(), isOfflineMode: vi.fn(() => false),
  readOfflineResponse: vi.fn(async () => null),
}));

const RULES = ['Your administrator does not allow deleting items from the bin for good.'];

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// The rules notice at sign-up: the form lists the rules of one signup-mode answer and the
// account confirms exactly that revision, through the real provider and the
// real request helper; only the network is mocked.
describe('sign-up and the data rules', () => {
  it('sends the revision of the signup-mode answer whose rules it listed', { timeout: 20_000 }, async () => {
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/auth/me') return { error: 'Not signed in', status: 401 };
      if (path === '/auth/signup-mode') return { data: { signup_mode: 'open', data_rules: RULES, rules_revision: 7 } };
      throw new Error(`unexpected GET ${path}`);
    });
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { requiresApproval: true, message: 'Account created. Waiting for admin approval.' } });
    render(<AuthProvider><MemoryRouter><Auth /></MemoryRouter></AuthProvider>);
    const tab = await screen.findByRole('tab', { name: 'Create account' });
    fireEvent.mouseDown(tab, { button: 0 }); fireEvent.focus(tab); fireEvent.click(tab);
    const section = (await screen.findByRole('heading', { name: 'Rules on this server' })).closest('section')!;
    expect(section).toHaveTextContent(RULES[0]);
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'New Person' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-long-enough-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/auth/signup', { email: 'new@example.com', password: 'a-long-enough-password', full_name: 'New Person', rules_revision: 7 }));
  });

  it('sends no revision when the answer named none', { timeout: 20_000 }, async () => {
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/auth/me') return { error: 'Not signed in', status: 401 };
      if (path === '/auth/signup-mode') return { data: { signup_mode: 'open', data_rules: [] } };
      throw new Error(`unexpected GET ${path}`);
    });
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { requiresApproval: true } });
    render(<AuthProvider><MemoryRouter><Auth /></MemoryRouter></AuthProvider>);
    const tab = await screen.findByRole('tab', { name: 'Create account' });
    fireEvent.mouseDown(tab, { button: 0 }); fireEvent.focus(tab); fireEvent.click(tab);
    await screen.findByRole('button', { name: 'Create account' });
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'New Person' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-long-enough-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/auth/signup', { email: 'new@example.com', password: 'a-long-enough-password', full_name: 'New Person' }));
  });
});
