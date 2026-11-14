import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MoreHorizontal, UserPlus } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { usePeople } from '@/hooks/use-organisation';
import { useToast } from '@/hooks/use-toast';
import { lastActiveLabel } from '@/lib/account-api';
import type { Person } from '@/lib/admin-api';
import { can } from '@/lib/permissions';
import { cn } from '@/lib/utils';
import { AddPersonDialog } from '@/components/admin/AddPersonDialog';
import { usePersonActions } from '@/components/admin/PersonActions';
import { ROLE_LABELS, ROW_LINK, personName, signInState } from '@/components/admin/person-words';
import { Button } from '@/components/ui/button';
import { Chip, ChipGroup } from '@/components/ui/chips';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { PolicyMenuItem } from '@/components/ui/policy-note';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';
import { SettingsPanel } from '@/components/settings/SettingsPanel';

// Server › People: everyone with an account on this server, one row each.
// The row opens the person's page; its menu holds the quick account changes.
// On wide windows the facts stand in columns under their headings; on a
// phone the same cells follow the name as one line.

const ALL = 'all';
const NO_GROUP = 'none';
/** The columns after the name: role, groups, sign-in, last active. */
const COLUMNS = 'md:grid md:grid-cols-[minmax(0,2.2fr)_7rem_minmax(0,1.6fr)_minmax(0,1.3fr)_6.5rem_2.5rem] md:items-center md:gap-x-4';
/** A cell is a column on wide windows and one part of the second line on a phone, the parts set apart by a dot. */
const cell = 'max-md:inline max-md:after:text-muted-foreground max-md:after:content-["_·_"] max-md:last:after:content-none md:truncate md:first-letter:uppercase';

function groupsText(person: Person) {
  if (person.groups.length === 0) return 'No group';
  return person.groups.map(group => (group.role === 'manager' ? `${group.name} (manager)` : group.name)).join(', ');
}

const AdminUsers = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [filter, setFilter] = useState(ALL);
  const [adding, setAdding] = useState(false);
  const { data, isLoading, error, refetch, isFetching } = usePeople();
  const actions = usePersonActions({ people: data });
  const people = data ?? [];

  // The filter's groups are those people are in: a group without members filters nothing.
  const groups = [...new Map(people.flatMap(person => person.groups).map(group => [group.id, group.name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const count = (id: string) => people.filter(person => (id === NO_GROUP ? person.groups.length === 0 : person.groups.some(group => group.id === id))).length;
  // A filter whose group lost its last member reads as All.
  const active = filter === ALL || (filter === NO_GROUP ? count(NO_GROUP) > 0 : groups.some(([id]) => id === filter)) ? filter : ALL;
  const shown = people.filter(person => active === ALL || (active === NO_GROUP ? person.groups.length === 0 : person.groups.some(group => group.id === active)));

  const list = isLoading ? <LoadingState label="Loading people…" />
    : error ? <ErrorState title="Could not load people" error={error} onRetry={() => void refetch()} retrying={isFetching} />
    : (
      <>
        {groups.length > 0 && (
          <ChipGroup label="Group" className="mb-4">
            <Chip selected={active === ALL} onSelect={() => setFilter(ALL)} count={people.length} countLabel="people">Everyone</Chip>
            {groups.map(([id, name]) => <Chip key={id} selected={active === id} onSelect={() => setFilter(id)} count={count(id)} countLabel="people">{name}</Chip>)}
            {count(NO_GROUP) > 0 && <Chip selected={active === NO_GROUP} onSelect={() => setFilter(NO_GROUP)} count={count(NO_GROUP)} countLabel="people">No group</Chip>}
          </ChipGroup>
        )}
        <div aria-hidden="true" className={cn('hidden border-b border-border pb-2 text-xs text-muted-foreground', COLUMNS)}>
          <span>Name</span><span>Role</span><span>Groups</span><span>Sign-in</span><span>Last active</span><span />
        </div>
        <ul aria-label="People" className="divide-y divide-border border-b border-border max-md:border-t">
          {shown.map(person => {
            const able = actions.abilities(person);
            const state = signInState(person);
            return (
              <li key={person.id} className={cn('relative flex items-center gap-3 py-3', COLUMNS)}>
                <div className="min-w-0 flex-1 md:contents">
                  <div className="min-w-0">
                    <p className="flex min-w-0 items-baseline gap-1 text-sm font-medium">
                      {/* The link itself is cut short, not its line: its box then ends where its text does. */}
                      <Link to={`/admin/users/${encodeURIComponent(person.id)}`} className={cn(ROW_LINK, 'truncate')}>{personName(person)}</Link>
                      {able.self && <span className="shrink-0 font-normal text-muted-foreground">(you)</span>}
                    </p>
                    {person.full_name && <p className="truncate text-xs text-muted-foreground">{person.email}</p>}
                  </div>
                  <p className="text-xs text-muted-foreground max-md:mt-0.5 md:contents md:text-sm">
                    <span className={cn(cell, person.role !== 'user' && 'md:text-foreground')}><span className="sr-only">Role: </span>{ROLE_LABELS[person.role]}</span>
                    <span className={cell} title={groupsText(person)}><span className="sr-only">Groups: </span>{groupsText(person)}</span>
                    <span className={cn(cell, state.attention && 'text-warning')}><span className="sr-only">Sign-in: </span>{state.text}</span>
                    <span className={cell}><span className="sr-only">Last active: </span>{person.last_active_at ? lastActiveLabel(person.last_active_at) : 'never'}</span>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2 md:justify-end">
                  {able.manage && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={`Actions for ${person.email}`}><MoreHorizontal aria-hidden="true" /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild><Link to={`/admin/users/${encodeURIComponent(person.id)}`}>Groups, devices and data</Link></DropdownMenuItem>
                        {able.activate && <DropdownMenuItem onClick={() => actions.activate(person)} disabled={actions.busy}>Activate</DropdownMenuItem>}
                        {able.role && <PolicyMenuItem lock={able.roleLock} onClick={() => actions.open('role', person)}>{person.role === 'admin' ? 'Remove administrator rights' : 'Make administrator'}</PolicyMenuItem>}
                        {able.setupLink && <DropdownMenuItem onClick={() => actions.open('setup-link', person)}>New setup link</DropdownMenuItem>}
                        {able.revokeLink && <DropdownMenuItem onClick={() => actions.revokeLink(person)} disabled={actions.busy}>Revoke setup link</DropdownMenuItem>}
                        {able.password && <DropdownMenuItem onClick={() => actions.open('password', person)}>{able.pending ? 'Set a password' : 'Set a new password'}</DropdownMenuItem>}
                        {able.resetTwoFactor && <DropdownMenuItem onClick={() => actions.open('reset-2fa', person)}>Reset 2FA</DropdownMenuItem>}
                        {able.deactivate && <PolicyMenuItem lock={able.protectedLock} onClick={() => actions.open('deactivate', person)}>Deactivate</PolicyMenuItem>}
                        {able.remove && <>
                          <DropdownMenuSeparator />
                          <PolicyMenuItem lock={able.protectedLock} className="text-destructive focus:text-destructive" onClick={() => actions.open('delete', person)}>Delete person</PolicyMenuItem>
                        </>}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </>
    );

  return (
    <PageShell panel={<SettingsPanel active="admin-users" />} panelLabel="Settings sections" panelId="settings">
      <PageHeader title="Settings" scope="People" />
      <PageBody width="wide">
        {!can(user, 'users.read') ? <p className="text-sm text-muted-foreground">Only administrators can see this page.</p> : (
          <>
            <div className="mb-4 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-base font-semibold">People</h2>
                <p className="mt-1 text-sm text-muted-foreground">{data ? `${data.length} ${data.length === 1 ? 'person' : 'people'} on this server.` : 'Everyone with an account on this server.'}</p>
              </div>
              {can(user, 'users.manage') && <Button onClick={() => setAdding(true)}><UserPlus aria-hidden="true" />Add person</Button>}
            </div>
            {list}
          </>
        )}
      </PageBody>
      <AddPersonDialog open={adding} onClose={() => setAdding(false)} onAdded={answer => {
        setAdding(false);
        if (answer.setup_link) actions.showLink(answer.setup_link, personName(answer.user));
        else toast({ title: `${personName(answer.user)} added`, description: 'They can sign in with the password you set.' });
      }} />
      {actions.dialogs}
    </PageShell>
  );
};

export default AdminUsers;
