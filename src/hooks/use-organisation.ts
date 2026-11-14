import { useQuery, type QueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/useAuth';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import {
  adminGroupsQueryKey, adminPoliciesQueryKey, adminPoliciesQueryKeyFor, adminUsersQueryKey, fetchAdminGroups, fetchAdminPolicies, fetchAdminUsers,
  fetchPersonDevices, personDevicesQueryKey, type PolicyScope,
} from '@/lib/admin-api';
import { fetchGroup, fetchGroupCandidates, fetchMyGroups, groupsQueryKeys } from '@/lib/groups-api';
import { can } from '@/lib/permissions';
import { policiesQueryKey } from '@/lib/policies-api';

// People, groups and policies by scope (0.30). Each query runs only for a
// person the server gave the permission, and never offline: these are live
// administration views, not part of the offline copy.

function useOnline() {
  const { user, isOffline } = useAuth();
  return { user, online: !!user && !isOffline };
}

/** Server › People. */
export function usePeople() {
  const { user, online } = useOnline();
  return useQuery({ queryKey: adminUsersQueryKey, queryFn: ({ signal }) => fetchAdminUsers(signal), enabled: online && can(user, 'users.read') });
}

/** A person's devices with a live session (the person page). */
export function usePersonDevices(userId: string | undefined) {
  const { user, online } = useOnline();
  return useQuery({
    queryKey: personDevicesQueryKey(userId ?? ''),
    queryFn: ({ signal }) => fetchPersonDevices(userId!, signal),
    enabled: online && !!userId && can(user, 'users.read'),
  });
}

/** Server › Groups: every group. */
export function useAdminGroups() {
  const { user, online } = useOnline();
  return useQuery({ queryKey: adminGroupsQueryKey, queryFn: ({ signal }) => fetchAdminGroups(signal), enabled: online && can(user, 'users.read') });
}

/** The policies of Everyone (no scope) or of one group, as administrators edit them. */
export function useAdminPolicies(scope?: PolicyScope) {
  const { user, online } = useOnline();
  return useQuery({
    queryKey: adminPoliciesQueryKeyFor(scope),
    queryFn: ({ signal }) => fetchAdminPolicies(signal, scope),
    enabled: online && can(user, 'server.settings'),
  });
}

/** The signed-in person's groups and their role in each. */
export function useMyGroups() {
  const { online } = useOnline();
  return useQuery({ queryKey: groupsQueryKeys.mine, queryFn: ({ signal }) => fetchMyGroups(signal), enabled: online });
}

/** One group as the signed-in person may see it (members only for those who manage it). */
export function useGroup(groupId: string | undefined) {
  const { online } = useOnline();
  return useQuery({ queryKey: groupsQueryKeys.group(groupId ?? ''), queryFn: ({ signal }) => fetchGroup(groupId!, signal), enabled: online && !!groupId });
}

/** People to add to a group, searched as the manager types. */
export function useGroupCandidates(groupId: string | undefined, query: string, enabled = true) {
  const { online } = useOnline();
  const search = useDebouncedValue(query.trim());
  return useQuery({
    queryKey: groupsQueryKeys.candidates(groupId ?? '', search),
    queryFn: ({ signal }) => fetchGroupCandidates(groupId!, search, signal),
    enabled: online && !!groupId && enabled,
  });
}

/**
 * After a change to people, groups, memberships or policies: every list that
 * may show it, and the signed-in person's own rules (their groups may have
 * changed them).
 */
export function invalidateOrganisation(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: adminUsersQueryKey }),
    client.invalidateQueries({ queryKey: adminGroupsQueryKey }),
    client.invalidateQueries({ queryKey: adminPoliciesQueryKey }),
    client.invalidateQueries({ queryKey: ['groups'] }),
    client.invalidateQueries({ queryKey: policiesQueryKey }),
  ]);
}
