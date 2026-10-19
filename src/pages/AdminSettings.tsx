import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/useAuth';
import { fetchSignupMode, fetchStorageOverview, saveSignupMode, signupModeQueryKey, storageQueryKey, type SignupMode, type StorageUser } from '@/lib/admin-api';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadingState } from '@/components/ui/page-states';
import { useToast } from '@/hooks/use-toast';
import { KeyRound, Loader2 } from 'lucide-react';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { AuditLog } from '@/components/settings/AuditLog';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';

function formatBytes(value: number | null | undefined) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unitIndex]}`;
}

function formatUserLabel(user: StorageUser) {
  if (user.full_name && user.email) return `${user.full_name} (${user.email})`;
  return user.email || user.full_name || user.user_id;
}

const AdminSettings = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: signupMode = 'disabled', isLoading } = useQuery({
    queryKey: signupModeQueryKey,
    queryFn: ({ signal }) => fetchSignupMode(signal),
    enabled: user?.role === 'admin',
  });

  const { data: storageOverview, isLoading: storageLoading } = useQuery({
    queryKey: storageQueryKey,
    queryFn: ({ signal }) => fetchStorageOverview(signal),
    enabled: user?.role === 'admin',
  });

  const updateSignupMode = useMutation({
    mutationFn: (mode: SignupMode) => saveSignupMode(mode),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: signupModeQueryKey });
      toast({ title: 'Signup settings updated' });
    },
    onError: (err: Error) => {
      toast({ title: 'Failed to update settings', description: err.message, variant: 'destructive' });
    },
  });

  const body = user?.role !== 'admin' ? (
    <p className="text-sm text-muted-foreground">Only admins can see this page.</p>
  ) : (
    <>
      <SettingsSection title="Sign-ups">
        <SettingsRow label="Who can create an account" htmlFor="signup-mode"
          description={signupMode === 'open' ? 'Anyone can sign up and use UniHub right away.'
            : signupMode === 'approval' ? 'Anyone can sign up, and an admin approves them in Users.'
            : 'Nobody can sign up. Existing accounts keep working.'}>
          {isLoading ? <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin text-muted-foreground" /> : (
            <Select value={signupMode} onValueChange={mode => updateSignupMode.mutate(mode as SignupMode)} disabled={updateSignupMode.isPending}>
              <SelectTrigger id="signup-mode" className="w-full sm:w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="open">Anyone</SelectItem>
                <SelectItem value="approval">Anyone, with approval</SelectItem>
                <SelectItem value="disabled">Nobody</SelectItem>
              </SelectContent>
            </Select>
          )}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Storage">
        {storageLoading ? <SettingsBlock><LoadingState compact label="Scanning storage…" /></SettingsBlock>
          : !storageOverview ? <SettingsBlock><p className="text-sm text-muted-foreground">Storage overview is unavailable.</p></SettingsBlock>
          : (
            <>
              <SettingsBlock>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
                  {[
                    ['Total', formatBytes(storageOverview.totals.bytes), `${storageOverview.totals.files} files`],
                    ['Users', String(storageOverview.totals.users), `${storageOverview.totals.active_users} active`],
                    ['Emails', String(storageOverview.totals.emails), `${storageOverview.totals.mail_accounts} accounts`],
                    ['Records', String(storageOverview.totals.contacts + storageOverview.totals.calendar_events), `${storageOverview.totals.contacts} contacts, ${storageOverview.totals.calendar_events} events and tasks`],
                  ].map(([label, value, detail]) => (
                    <div key={label}>
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="mt-0.5 text-xl font-semibold tabular-nums">{value}</dd>
                      <dd className="text-xs text-muted-foreground">{detail}</dd>
                    </div>
                  ))}
                </dl>
              </SettingsBlock>
              {storageOverview.sections.map(section => (
                <SettingsRow key={section.key} label={section.label}
                  description={<>
                    {[`${section.files} files`, section.tracked_items !== undefined && `${section.tracked_items} tracked`, section.ready_items !== undefined && `${section.ready_items} ready`].filter(Boolean).join(', ')}
                    {(!section.path_exists || section.scan_error) && <span className="block text-destructive">{section.scan_error || 'The storage folder does not exist yet.'}</span>}
                  </>}>
                  <span className="text-sm font-medium tabular-nums">{formatBytes(section.bytes)}</span>
                </SettingsRow>
              ))}
            </>
          )}
      </SettingsSection>

      {storageOverview && (
        <SettingsSection title="Storage per person" description={`Last scanned ${new Date(storageOverview.generated_at).toLocaleString()}.`}>
          {(storageOverview.users || []).length === 0 ? <SettingsBlock><p className="text-sm text-muted-foreground">No stored files yet.</p></SettingsBlock>
            : storageOverview.users.map(storageUser => {
              const share = storageOverview.totals.bytes > 0 ? Math.min(100, (storageUser.bytes / storageOverview.totals.bytes) * 100) : 0;
              const sections = storageUser.sections || {};
              return (
                <SettingsBlock key={storageUser.user_id} className="space-y-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="min-w-0 truncate text-sm font-medium">
                      {formatUserLabel(storageUser)}
                      {storageUser.orphaned ? <span className="font-normal text-warning"> (no longer has an account)</span> : !storageUser.is_active ? <span className="font-normal text-muted-foreground"> (inactive)</span> : null}
                    </p>
                    <p className="shrink-0 text-sm tabular-nums">{formatBytes(storageUser.bytes)} <span className="text-muted-foreground">({share.toFixed(1)}%)</span></p>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${share}%` }} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Attachments {formatBytes(sections.mail_attachments?.bytes)}, raw mail {formatBytes(sections.mail_raw?.bytes)}, recordings {formatBytes(sections.recordings?.bytes)}, exports {formatBytes(sections.exports?.bytes)}. {storageUser.files} files.
                  </p>
                </SettingsBlock>
              );
            })}
        </SettingsSection>
      )}

      <SettingsSection title="Deployment secrets">
        <SettingsBlock>
          <p className="flex gap-3 text-sm text-muted-foreground">
            <KeyRound aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>UniHub cannot check whether JWT_SECRET and ENCRYPTION_KEY are strong. Keep them long, random, unique and stored outside the app. Changing ENCRYPTION_KEY needs planning, because stored mail and calendar sign-ins depend on it.</span>
          </p>
        </SettingsBlock>
      </SettingsSection>

      <AuditLog />
    </>
  );

  return (
    <PageShell panel={<SettingsPanel active="admin-settings" />} panelLabel="Settings sections" panelId="settings">
      <PageHeader title="Settings" scope="Server settings" />
      <PageBody width="reading">{body}</PageBody>
    </PageShell>
  );
};

export default AdminSettings;
