import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import type {
  AddMembersRequest, GroupCandidatesResponse, GroupInput, GroupResponse, GroupSummary, MyGroupsResponse,
} from '../../api/src/contracts/organisation';

export type { GroupCandidate, GroupMember, GroupResponse, GroupRole, GroupSummary, MyGroupsResponse } from '../../api/src/contracts/organisation';

// A person's own groups and what a group manager may do (0.30): rename the
// group, add and remove its members. The server answers 404 GROUP_NOT_FOUND
// for a group the person cannot see and 403 GROUP_FORBIDDEN for one they can
// see but not manage; administrators manage groups under lib/admin-api.ts.

export const groupsQueryKeys = {
  mine: ['groups', 'mine'] as const,
  group: (groupId: string) => ['groups', groupId] as const,
  candidates: (groupId: string, query: string) => ['groups', groupId, 'candidates', query] as const,
};

const groupPath = (groupId: string, rest = '') => `/groups/${encodeURIComponent(groupId)}${rest}`;

export async function fetchMyGroups(signal?: AbortSignal): Promise<MyGroupsResponse['groups']> {
  return unwrap(await api.get<MyGroupsResponse>('/groups', { signal }))?.groups ?? [];
}

/** The group with its members for those who may manage it; others see its managers. */
export async function fetchGroup(groupId: string, signal?: AbortSignal): Promise<GroupResponse> {
  const answer = unwrap(await api.get<GroupResponse>(groupPath(groupId), { signal }));
  if (!answer?.group) throw new Error('The server did not answer with the group.');
  return { group: answer.group, can_manage: !!answer.can_manage, members: answer.members ?? [] };
}

export async function updateGroup(groupId: string, input: GroupInput) {
  return unwrap(await api.put<{ group: GroupSummary }>(groupPath(groupId), input))?.group;
}

/** At most 200 people at once (the server refuses more). */
export const MAX_MEMBERS_PER_ADD = 200;

export async function addGroupMembers(groupId: string, userIds: string[]) {
  if (userIds.length > MAX_MEMBERS_PER_ADD) throw new Error(`Add at most ${MAX_MEMBERS_PER_ADD} people at once.`);
  unwrap(await api.post(groupPath(groupId, '/members'), { user_ids: userIds } satisfies AddMembersRequest));
}

/** Removes a membership; a manager can be removed only by an administrator. */
export async function removeGroupMember(groupId: string, userId: string) {
  unwrap(await api.delete(groupPath(groupId, `/members/${encodeURIComponent(userId)}`)));
}

/** Active people not in the group matching `query` (name or email), at most 20. */
export async function fetchGroupCandidates(groupId: string, query: string, signal?: AbortSignal) {
  return unwrap(await api.get<GroupCandidatesResponse>(groupPath(groupId, `/candidates?q=${encodeURIComponent(query)}`), { signal }))?.people ?? [];
}
