import { describe, expect, it } from 'vitest';
import { getBackupDownloadAction } from '@/lib/backup';

describe('backup download recovery state', () => {
  it('downloads unencrypted backups directly', () => {
    expect(getBackupDownloadAction({
      encryption_enabled: false,
      recovery_password_available: false,
      recovery_password_revealed: false,
    })).toBe('download');
  });

  it('requires reveal while the one-time password is available', () => {
    expect(getBackupDownloadAction({
      encryption_enabled: true,
      recovery_password_available: true,
      recovery_password_revealed: false,
    })).toBe('reveal_password');
  });

  it('blocks encrypted backups with missing recovery metadata', () => {
    expect(getBackupDownloadAction({
      encryption_enabled: true,
      recovery_password_available: false,
      recovery_password_revealed: false,
    })).toBe('missing_password_metadata');
  });

  it('downloads after the recovery password was revealed', () => {
    expect(getBackupDownloadAction({
      encryption_enabled: true,
      recovery_password_available: false,
      recovery_password_revealed: true,
    })).toBe('download');
  });
});
