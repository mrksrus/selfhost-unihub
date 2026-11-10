import type { UnlockResult } from '@/hooks/use-app-lock';

/** What a refused try says, in plain words; null for a result that needs no sentence. */
export function unlockMessage(result: Exclude<UnlockResult, { ok: true }>): string | null {
  switch (result.reason) {
    case 'wrong': return 'That is not the PIN.';
    case 'wait': return 'Too many wrong PINs. Wait before the next try.';
    case 'invalid': return 'A PIN has 6 to 12 digits.';
    case 'signed-out': return 'Too many wrong PINs: this device is signed out.';
    case 'no-pin': return 'No PIN is set on this device.';
    case 'cancelled': return null;
    case 'lockout': return 'The phone has locked fingerprint and face unlock after too many tries. Try again later, or use the phone\'s PIN.';
    case 'unavailable': return 'The phone\'s unlock is not available right now. Try again.';
    case 'pin-needed': return null;
  }
}
