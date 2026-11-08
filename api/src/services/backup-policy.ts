import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { PolicyActor } from './settings';
import { db } from '../state';
import { policyForbids, resolvePolicy } from './settings';

// How long a user backup is kept at least (D36, P-35):
// backup.server_retention_days is a minimum, not a deadline. While it is set,
// a person's DELETE of a finished backup younger than that many days is
// refused with POLICY_FORBIDS, as is one still being made; nothing is ever
// deleted because it got older.
// The administrator's path deletes earlier, after their password and with an
// activity-log entry. backup.delete forbidden refuses every delete at the
// request boundary before this.

const day = (value: Date | string) => (value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`)).toISOString().slice(0, 10);

// The refusal while the minimum keeps the job: every job but a failed or
// cancelled one, which holds no backup and never becomes one (its status
// is final, export-jobs.ts), and its age never goes down.
async function refuseYoung(userId: string, jobId: string, days: number | null, executor: SqlExecutor) {
  if (days === null) return;
  const [[job]] = await executor.execute<RowDataPacket[]>(`SELECT created_at + INTERVAL ? DAY AS deletable_from, created_at > UTC_TIMESTAMP() - INTERVAL ? DAY AS young
    FROM data_export_jobs WHERE id = ? AND user_id = ? AND status NOT IN ('failed', 'cancelled')`, [days, days, jobId, userId]);
  if (!job || !Number(job.young)) return;
  throw policyForbids('backup.server_retention_days', `Your administrator keeps every backup at least ${days} days. This one can be deleted from ${day(job.deletable_from)}.`);
}

/** The route's early answer: refuses deleting the person's backup `jobId` while the minimum keeps it. */
async function assertBackupDeletable(userId: string, jobId: string, { adminId }: PolicyActor = {}) {
  if (adminId) return;
  await refuseYoung(userId, jobId, (await resolvePolicy(userId, 'backup.server_retention_days')).value, db);
}

/**
 * The deletion's final step, in its transaction after the job's row lock
 * (export-jobs.ts deleteDataExportJob): backup.delete and the minimum, both
 * read under the rules lock (final-step.ts), so an administrator's save
 * commits before these reads or after the deletion. The administrator's
 * path passes both.
 */
async function assertBackupDeletableNow(connection: SqlExecutor, userId: string, jobId: string, actor: PolicyActor = {}) {
  const { assertFinalStep } = require('./final-step') as typeof import('./final-step');
  const step = await assertFinalStep(connection, { userId, policies: ['backup.delete'], actor });
  if (!actor.adminId) await refuseYoung(userId, jobId, step.policy('backup.server_retention_days').value, connection);
}

export { assertBackupDeletable, assertBackupDeletableNow };
