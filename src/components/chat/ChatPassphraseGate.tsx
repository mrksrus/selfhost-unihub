import { KeyRound } from 'lucide-react';
import type { ChatEngine } from '@/lib/chat/types';
import { EmptyState } from '@/components/ui/page-states';

interface Props {
  engine: ChatEngine;
  /** `choose-passphrase` at the first Chat open, `enter-passphrase` on a device that does not hold the history key yet. */
  state: 'choose-passphrase' | 'enter-passphrase';
}

/**
 * Where the chat passphrase is chosen or entered before Chat opens. A
 * stand-in for those two screens: it only says that Chat is not ready.
 */
export function ChatPassphraseGate(_props: Props) {
  return <EmptyState icon={KeyRound} title="Chat is being set up" description="It needs your chat passphrase before messages can be read on this device." />;
}
