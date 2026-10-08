// Historical schema 2, including provider-folder mappings. Keep this reader;
// compatibility is selected from archive metadata, never a user-selected script.
import type { BackupPayload } from '../../types';

function readV2<T extends BackupPayload>(backup: T): T {
  return backup;
}

export { readV2 };
