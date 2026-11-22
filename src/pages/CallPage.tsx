import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { PhoneOff } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { useChatCalls } from '@/hooks/use-chat-calls';
import { useModules } from '@/hooks/use-modules';
import { callSupport } from '@/lib/platform';
import { Button } from '@/components/ui/button';
import { EmptyState, LoadingState, StartingScreen } from '@/components/ui/page-states';
import { PreferenceAccent } from '@/components/theme/PreferenceAccent';
import { CallBody } from '@/components/chat/CallScreen';
import { useCallScreen } from '@/components/chat/call-state';
import { chatHref } from '@/components/chat/chat-state';

/**
 * The call alone on a page (/call?id=<call>): what a notification of a call
 * opens and what the Android app's call screen loads. It shows only the call,
 * also while UniHub is locked, and never answers by itself: "Answer" takes
 * the call the address names. "Open chat" leaves for the app, which asks for
 * the unlock.
 */
export default function CallPage() {
  const { user, loading } = useAuth();
  const held = useChatCalls();
  const { call, name, connected } = useCallScreen(held);
  const id = useSearchParams()[0].get('id') ?? undefined;
  const navigate = useNavigate();
  const calls = held?.calls;
  const modules = useModules();
  const cannot = callSupport() !== 'page' || (modules.isSuccess && !modules.isEnabled('chat'));
  // Nothing says "no call" before the server was asked.
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!calls) return;
    let stopped = false;
    void calls.sync().catch(() => undefined).then(() => { if (!stopped) setAsked(true); });
    return () => { stopped = true; };
  }, [calls]);

  if (loading) return <StartingScreen />;
  if (!user) return <Navigate to="/auth" replace />;
  const open = <Button asChild variant="outline"><Link to="/">Open UniHub</Link></Button>;
  return (
    <main className="flex h-dvh flex-col overflow-y-auto bg-background px-6 pb-[max(1.5rem,env(safe-area-inset-bottom,0px))] pt-[max(1.5rem,env(safe-area-inset-top,0px))]">
      <PreferenceAccent />
      <div className="m-auto w-full max-w-xs py-8">
        {held && call ? (
          <CallBody calls={held.calls} call={call} name={name} connected={connected} onAnswer={() => void held.calls.answer(id)}
            onOpenChat={call.conversation_id && call.state !== 'ringing' ? () => navigate(chatHref(call.conversation_id!)) : undefined} />
        ) : !cannot && !asked ? <LoadingState label="Looking for the call…" />
          : <EmptyState icon={PhoneOff} title={cannot ? 'Calls cannot run here' : 'No call now'} action={open}
            description={cannot ? 'This browser cannot make calls, or Chat is off for you.' : id ? 'This call has ended.' : undefined} />}
      </div>
    </main>
  );
}
