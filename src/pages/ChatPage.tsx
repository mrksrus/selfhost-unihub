import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { MessageCircle, MessageCircleOff, Plus, Users } from 'lucide-react';
import { useChatEngine } from '@/hooks/use-chat-engine';
import { useAppLock } from '@/hooks/use-app-lock';
import { useModules } from '@/hooks/use-modules';
import { cn } from '@/lib/utils';
import { PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/page-states';
import { ChatPassphraseGate } from '@/components/chat/ChatPassphraseGate';
import { ChatThread } from '@/components/chat/ChatThread';
import { ConversationList } from '@/components/chat/ConversationList';
import { NewGroupDialog } from '@/components/chat/NewGroupDialog';
import { useChatSnapshot } from '@/components/chat/chat-state';
import { UPDATE_APP_TO_LOCK_CHAT } from '@/components/app-lock/area-names';
import type { ChatEngine } from '@/lib/chat/types';

/**
 * Chat: the conversations beside the open one on a wide window, one of the
 * two on a narrow one. Everything shown comes from the engine of the
 * signed-in person; a conversation the engine does not list is not opened.
 */
export default function ChatPage() {
  const engine = useChatEngine();
  const snapshot = useChatSnapshot(engine);
  const { canAccess } = useModules();
  const [params] = useSearchParams();
  const activeId = params.get('c');
  // Unsent text per conversation, for as long as the page stays open.
  const drafts = useRef(new Map<string, string>());

  const lock = useAppLock();
  // The engine whose passphrase prompt was put off ("Not now"): its chats show, with a line that brings the prompt back.
  const [later, setLater] = useState<ChatEngine | null>(null);

  const readiness = snapshot?.readiness ?? { state: 'starting' as const };
  const waiting = readiness.state === 'enter-passphrase' && later === engine;
  // The server refuses Chat until a required app lock is set up; once it is, starting is tried again.
  const lockMet = lock.status !== 'setup' && lock.requirement?.meets !== false;
  useEffect(() => { if (lockMet && engine?.snapshot().readiness.state === 'failed') engine.restart(); }, [engine, lockMet]);
  const conversations = snapshot?.conversations ?? [];
  const active = activeId ? conversations.find(conversation => conversation.id === activeId) ?? null : null;
  // A chat starts at a colleague: their entry in the company directory has Message.
  const directory = canAccess('/contacts');
  const newChat = directory && <Button asChild size="sm"><Link to="/contacts?book=company"><Plus aria-hidden="true" />New chat</Link></Button>;
  const [newGroup, setNewGroup] = useState(false);
  // A chat that goes while it is open (the person left it or was removed from it): back to the list.
  const navigate = useNavigate();
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (active) opened.current = active.id;
    else if (activeId && opened.current === activeId) navigate('/chat', { replace: true });
  }, [active, activeId, navigate]);

  return (
    <PageShell>
      <PageHeader title="Chat" className={activeId ? 'hidden lg:block' : undefined} actions={(readiness.state === 'ready' || waiting) && <><Button variant="outline" size="sm" onClick={() => setNewGroup(true)}><Users aria-hidden="true" />New group</Button>{newChat}</>} />
      {newGroup && engine && <NewGroupDialog engine={engine} onClose={() => setNewGroup(false)} />}
      {!engine || !snapshot || readiness.state === 'starting' ? <PageBody width="reading"><LoadingState label="Opening Chat…" /></PageBody>
        : readiness.state === 'unsupported' ? <PageBody width="reading"><EmptyState icon={MessageCircleOff} title="Chat cannot run in this browser" description={readiness.reason} /></PageBody>
        : readiness.state === 'failed' ? <PageBody width="reading"><ErrorState title="Chat could not start" error={lock.method.appUpdateForChat ? `${readiness.reason} ${UPDATE_APP_TO_LOCK_CHAT}` : readiness.reason} onRetry={() => engine.restart()} /></PageBody>
        : readiness.state !== 'ready' && !waiting ? <PageBody width="reading"><ChatPassphraseGate engine={engine} state={readiness.state} onLater={() => setLater(engine)} /></PageBody>
        : conversations.length === 0 && !activeId && !waiting ? (
          <PageBody width="reading">
            <EmptyState icon={MessageCircle} title="No chats yet" action={newChat || undefined}
              description={`${directory ? 'Open a colleague in the company directory and choose Message.' : 'A chat starts when a colleague writes to you.'} Only the two of you can read what you write.`} />
          </PageBody>
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className={cn('min-h-0 min-w-0 flex-col lg:flex lg:w-80 lg:shrink-0 lg:border-r lg:border-border', activeId ? 'hidden' : 'flex flex-1')}>
              {waiting && (
                <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2 text-xs text-muted-foreground">
                  <p>Your earlier messages are not on this device yet.</p>
                  <Button variant="outline" size="sm" className="shrink-0" onClick={() => setLater(null)}>Enter passphrase</Button>
                </div>
              )}
              {snapshot.restore && (
                <p role="status" className="shrink-0 border-b border-border px-4 py-2 text-xs text-muted-foreground">
                  Getting your earlier messages… {snapshot.restore.done.toLocaleString('en')}{snapshot.restore.total !== null && ` of ${snapshot.restore.total.toLocaleString('en')}`}
                </p>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto pb-mobile-nav md:pb-0">
                <ConversationList conversations={conversations} activeId={activeId} />
              </div>
            </div>
            {active ? (
              <ChatThread key={active.id} engine={engine} conversation={active} draft={drafts.current.get(active.id) ?? ''} onDraft={text => { drafts.current.set(active.id, text); }} />
            ) : (
              <div className={cn('min-w-0 flex-1 items-center justify-center px-6', activeId ? 'flex' : 'hidden lg:flex')}>
                {activeId
                  ? <EmptyState title="This chat is not available" action={<Button asChild variant="outline"><Link to="/chat">Back to chats</Link></Button>} />
                  : <EmptyState icon={MessageCircle} title="Choose a chat" description={directory ? 'Or start one from a colleague\'s entry in the company directory.' : undefined} />}
              </div>
            )}
          </div>
        )}
    </PageShell>
  );
}
