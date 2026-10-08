import type { BackupPayload } from '../../types';
import imported1 = require('./v3');
const { readV3 } = imported1;

// Old archives remain readable. No provider observation or raw-integrity claim
// is fabricated by a format upgrade; the restore layer quarantines live work.
function readV4<T extends BackupPayload>(backup: T): T {
  readV3(backup);
  return backup;
}
export = { readV4 };
