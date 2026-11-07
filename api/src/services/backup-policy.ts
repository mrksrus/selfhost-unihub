import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { PolicyActor } from './settings';
import { db } from '../state';
import { policyForbids, resolvePolicy } from './settings';

// How long a user backup is kept at least (D36, P-35):
// backup.server_retention_days is a minimum, not a deadline. While it is set,
// a person's DELETE of a finished backup younger than that many days is
// refused with POLICY_FORBIDS; nothing is ever deleted because it got older.
// The administrator's path deletes earlier, after their password and with an
// activity-log entry. backup.delete forbidden refuses every delete at the
// request boundary before this.

const day = (value: Date | string) => (value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`)).toISOString().slice(0, 10);

/** Refuses deleting the person's backup `jobId` while the minimum keeps it; anything else is for the delete to answer. */
async function assertBackupDeletable(userId: string, jobId: string, { adminId }: PolicyActor = {}, executor: SqlExecutor = db) {
  if (adminId) return;
  const days = (await resolvePolicy(userId, 'backup.server_retention_days', executor)).value;
  if (days === null) return;
  // A finished archive only: a failed or cancelled job holds no backup.
  const [[job]] = await executor.execute<RowDataPacket[]>(`SELECT created_at + INTERVAL ? DAY AS deletable_from, created_at > UTC_TIMESTAMP() - INTERVAL ? DAY AS young
    FROM data_export_jobs WHERE id = ? AND user_id = ? AND status = 'ready'`, [days, days, jobId, userId]);
  if (!job || !Number(job.young)) return;
  throw policyForbids('backup.server_retention_days', `Your administrator keeps every backup at least ${days} days. This one can be deleted from ${day(job.deletable_from)}.`);
}

export { assertBackupDeletable };
