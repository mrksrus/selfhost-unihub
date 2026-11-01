import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Auth from '@/pages/Auth';

const signIn = vi.fn(async () => ({ error: null as Error | null }));

vi.mock('@/contexts/useAuth', () => ({
  useAuth: () => ({ user: null, loading: false, signIn, signUp: vi.fn(), verifyTwoFactorLogin: vi.fn() }),
}));
vi.mock('@/lib/auth-api', () => ({ fetchPublicSignupMode: vi.fn(async () => 'disabled') }));

beforeEach(() => signIn.mockClear());

// The form checks the address and the password length in the browser before
// anything is sent (src/pages/Auth.tsx, zod).
describe('the sign-in form', () => {
  const fill = (email: string, password: string) => {
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
    // Submits past the inputs' own browser checks, so only the page's validation decides.
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form')!);
  };

  it('names a wrong address and a short password and sends nothing', async () => {
    render(<MemoryRouter><Auth /></MemoryRouter>);
    fill('not-an-address', 'short');
    expect(await screen.findByText('Please enter a valid email address')).toBeInTheDocument();
    expect(screen.getByText('Password must be at least 12 characters')).toBeInTheDocument();
    expect(signIn).not.toHaveBeenCalled();
  });

  it('signs in with a valid address and a long enough password', async () => {
    render(<MemoryRouter><Auth /></MemoryRouter>);
    fill('person@example.com', 'a-long-enough-password');
    await waitFor(() => expect(signIn).toHaveBeenCalledWith('person@example.com', 'a-long-enough-password'));
    expect(screen.queryByText('Please enter a valid email address')).not.toBeInTheDocument();
  });
});
