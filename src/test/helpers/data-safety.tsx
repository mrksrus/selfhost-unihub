import type { ReactNode } from 'react';
import { permissionsOf } from '../../../api/src/security/permissions';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthContext, type AuthContextType, type User } from '@/contexts/auth-context';
import { defaultPolicies, type EffectivePoliciesResponse, type PolicyKey, type PolicyValues } from '@/lib/policies-api';

/** The answer of GET /policies/effective with these keys forbidden (reason: the registry's sentence) or set. */
export function policiesAnswer(changes: Partial<{ [K in PolicyKey]: { value: PolicyValues[K]; allowed?: boolean; reason: string } }> = {}, revision = 1): { data: EffectivePoliciesResponse } {
  const policies = defaultPolicies();
  for (const [key, change] of Object.entries(changes) as [PolicyKey, { value: unknown; allowed?: boolean; reason: string }][]) {
    policies[key] = { value: change.value, source: 'policy', allowed: change.allowed ?? false, reason: change.reason } as never;
  }
  return { data: { policies, revision, acknowledged_revision: revision, rules: [] } };
}

export const OWNER: User = { id: 'user-ada', email: 'ada@example.com', full_name: 'Ada Example', role: 'user' };
export const ADMIN: User = { id: 'user-admin', email: 'admin@example.com', full_name: 'Avery Admin', role: 'admin', permissions: permissionsOf('admin') };

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
