import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthContext, type AuthContextType, type User } from '@/contexts/auth-context';
import { defaultPolicies, type EffectivePoliciesResponse, type PolicyKey, type PolicyValues } from '@/lib/policies-api';
import type { Person } from '@/lib/admin-api';

/** The answer of GET /policies/effective with these keys forbidden (reason: the registry's sentence) or set. */
export function policiesAnswer(changes: Partial<{ [K in PolicyKey]: { value: PolicyValues[K]; allowed?: boolean; reason: string } }> = {}, revision = 1): { data: EffectivePoliciesResponse } {
  const policies = defaultPolicies();
  for (const [key, change] of Object.entries(changes) as [PolicyKey, { value: unknown; allowed?: boolean; reason: string }][]) {
    policies[key] = { value: change.value, source: 'policy', allowed: change.allowed ?? false, reason: change.reason } as never;
  }
  return { data: { policies, revision, acknowledged_revision: revision, rules: [] } };
}

export const OWNER: User = { id: 'user-ada', email: 'ada@example.com', full_name: 'Ada Example', role: 'user' };
/** What the server grants an administrator (api/src/security/permissions.ts); the owner also has the last two. */
export const ADMIN_PERMISSIONS = ['users.read', 'users.manage', 'server.settings', 'storage.read', 'audit.read', 'groups.manage'] as const;
export const OWNER_PERMISSIONS = [...ADMIN_PERMISSIONS, 'admins.manage', 'owner.transfer'] as const;
export const ADMIN: User = { id: 'user-admin', email: 'admin@example.com', full_name: 'Avery Admin', role: 'admin', permissions: [...ADMIN_PERMISSIONS] };
export const SERVER_OWNER: User = { ...ADMIN, role: 'owner', permissions: [...OWNER_PERMISSIONS] };

/** A row of GET /api/admin/users (contracts/organisation.ts Person) with these fields set. */
export function person(fields: Partial<Person> & Pick<Person, 'id' | 'email'>): Person {
  return { full_name: null, role: 'user', status: 'active', is_active: true, two_factor_enabled: false, two_factor_grace_ends_at: null, groups: [], created_at: '2026-01-01T00:00:00.000Z', last_active_at: null, ...fields };
}

export const testClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

/** Mounts a view inside a signed-in session (the policies hook reads it), a query client and a router. */
export function mountSignedIn(view: ReactNode, { user = OWNER, path = '/', routePath = '*', client = testClient(), auth = {} }: { user?: User; path?: string; routePath?: string; client?: QueryClient; auth?: Partial<AuthContextType> } = {}) {
  const session = { user, session: { authenticated: true }, loading: false, serverUnavailable: false, isOffline: false, ...auth } as unknown as AuthContextType;
  return render(
    <AuthContext.Provider value={session}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes><Route path={routePath} element={view} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

/** jsdom lacks what Radix Select and the checkbox measure. */
export function stubBrowserApis() {
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
}
