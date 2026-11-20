import type { ChatEngine } from '@/lib/chat/types';

/**
 * The signed-in person's chat engine; null while signed out or with Chat off.
 * A stand-in that has no engine yet: the screens read the engine only here.
 */
export function useChatEngine(): ChatEngine | null {
  return null;
}
