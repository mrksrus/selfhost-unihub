// Data schema 6 (0.27.0): the Calendar section carries task_order, the hand
// order of tasks (services/task-order.ts), and the Settings section may hold
// calendar references (default_task_list_id, default_calendar_id). Archives
// up to schema 5 have neither: every task keeps its date's place and the
// defaults are UniHub's choice. Nothing is converted; the schema number makes
// a release before 0.27 refuse this archive as newer instead of dropping the
// order without a word.
import type { BackupPayload } from '../../types';
import { readV5 } from './v5';

function readV6<T extends BackupPayload>(backup: T): T {
  return readV5(backup);
}

export { readV6 };
