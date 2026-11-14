import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { INVITE_INVALID, checkInvite, inviteTokenFromHash, takeInviteToken } from '@/lib/auth-api';
import { hasCode } from '@/lib/api-error';
import { UniHubMark } from '@/components/app-lock/UniHubMark';
import { formatDayTime } from '@/components/admin/person-words';
import { RulesList } from '@/components/policies/PolicyNoticeDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingState, StartingScreen } from '@/components/ui/page-states';

// /invite#<token>: a person an administrator added chooses their password
// here and is signed in (0.30). Public, and made for a phone first: one
// column, the rules that will apply to them before the password. The token
// is in the fragment, so no server or proxy log has it; the page takes it
// out of the address bar at once and sends no referrer. The server answers
// one "invalid" for a link that is unknown, used, replaced or expired.

const InviteAccept = () => {
  const { user, acceptInvite } = useAuth();
  const navigate = useNavigate();
  // Read while rendering (a pure read, also when React renders twice); taken out of the address bar after the first paint.
  const [token] = useState(() => inviteTokenFromHash(window.location.hash));
  const [name, setName] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [used, setUsed] = useState(false);

  useEffect(() => {
    takeInviteToken();
    // No address of this page travels with a link the person follows from it.
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  // Signing in mounts the app anew for the new session (App.tsx keys it by the account): this page then has no token left and hands over to the app.
  const signedIn = !!user && !token;
  useEffect(() => { if (signedIn) navigate('/', { replace: true }); }, [signedIn, navigate]);

  const check = useQuery({ queryKey: ['invite', token], queryFn: () => checkInvite(token!), enabled: !!token, retry: false, staleTime: Infinity, gcTime: 0 });
  const invalid = !token || used || hasCode(check.error, INVITE_INVALID);
  const shownName = name ?? check.data?.full_name ?? '';

  const submit = async () => {
    if (!token || !check.data || busy) return;
    if (password !== again) { setError('The two passwords do not match.'); return; }
    setBusy(true);
    setError('');
    const result = await acceptInvite(token, password, shownName || null, check.data.rules_revision || null);
    setBusy(false);
    if (!result.error) { navigate('/', { replace: true }); return; }
    if (hasCode(result.error, INVITE_INVALID)) setUsed(true);
    else setError(result.error.message);
  };

  if (signedIn) return <StartingScreen />;

  return (
    <main className="flex min-h-dvh flex-col overflow-y-auto bg-background px-6 pb-[max(1.5rem,env(safe-area-inset-bottom,0px))] pt-[max(1.5rem,env(safe-area-inset-top,0px))]">
      <div className="m-auto flex w-full max-w-sm flex-col gap-6 py-8">
        <UniHubMark />
        {invalid ? (
          <>
            <div className="space-y-2">
              <h1 className="text-xl font-semibold tracking-tight">This setup link does not work</h1>
              <p className="text-sm text-muted-foreground">It was used already, replaced by a newer one, or has expired. Ask your administrator for a new link.</p>
            </div>
            <Button variant="outline" asChild className="w-full"><Link to="/auth">Go to sign in</Link></Button>
          </>
        ) : check.isLoading ? <LoadingState label="Checking the link…" className="items-start py-0 text-left" />
        : check.error || !check.data ? (
          <>
            <div className="space-y-2">
              <h1 className="text-xl font-semibold tracking-tight">Could not check the link</h1>
              <p role="alert" className="text-sm text-muted-foreground">{check.error?.message ?? 'The server gave no answer.'} The link itself is not used up.</p>
            </div>
            <Button variant="outline" className="w-full" disabled={check.isFetching} onClick={() => void check.refetch()}>{check.isFetching ? 'Trying…' : 'Try again'}</Button>
          </>
        ) : (
          <>
            <div className="space-y-2">
              <h1 className="text-xl font-semibold tracking-tight">Set up your UniHub account</h1>
              <p className="text-sm text-muted-foreground">Your administrator added you as <span className="font-medium text-foreground [overflow-wrap:anywhere]">{check.data.email}</span>. Choose a password to sign in.</p>
            </div>
            {check.data.data_rules.length > 0 && (
              <section aria-labelledby="invite-rules" className="space-y-2 border-y border-border py-4">
                <h2 id="invite-rules" className="text-sm font-medium">Rules that apply to you here</h2>
                <RulesList rules={check.data.data_rules} className="text-sm text-muted-foreground" />
              </section>
            )}
            <form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
              <div className="space-y-2">
                <Label htmlFor="invite-name">Name</Label>
                <Input id="invite-name" autoComplete="name" value={shownName} onChange={event => setName(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="invite-password">Password</Label>
                <Input id="invite-password" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} aria-describedby="invite-password-hint" />
                <p id="invite-password-hint" className="text-xs text-muted-foreground">At least 12 characters, or more where a rule above says so.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="invite-password-again">Password again</Label>
                <Input id="invite-password-again" type="password" autoComplete="new-password" value={again} onChange={event => setAgain(event.target.value)} />
              </div>
              <p role="alert" className="text-sm text-destructive empty:hidden">{error}</p>
              <Button type="submit" className="w-full" disabled={busy || !password || !again}>
                {busy && <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />}Set password and sign in
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">The link works once, until {formatDayTime(check.data.expires_at)}.</p>
          </>
        )}
      </div>
    </main>
  );
};

export default InviteAccept;
