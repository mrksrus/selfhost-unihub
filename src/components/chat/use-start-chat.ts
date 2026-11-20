import { useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthContext } from '@/contexts/auth-context';
import { useChatEngine } from '@/hooks/use-chat-engine';
import { useToast } from '@/hooks/use-toast';
import { useSessionScope } from '@/lib/session-scope';
import { chatHref } from '@/components/chat/chat-state';

/**
 * "Message" for a colleague: opens the one chat with them. Null when there
 * is nobody to write to: no colleague, oneself, or Chat is off.
 */
export function useStartChat(userId: string | undefined): (() => void) | null {
  const engine = useChatEngine();
  const ownId = useContext(AuthContext)?.user?.id;
  const navigate = useNavigate();
  const scope = useSessionScope();
  const { toast } = useToast();
  if (!engine || !userId || userId === ownId) return null;
  return () => {
    // An answer that comes after the session ended opens nothing in the next person's page.
    engine.openConversation(userId).then(
      id => { if (!scope.ended) navigate(chatHref(id)); },
      (error: unknown) => { if (!scope.ended) toast({ title: 'Could not open the chat', description: error instanceof Error ? error.message : undefined, variant: 'destructive' }); },
    );
  };
}
