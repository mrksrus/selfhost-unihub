import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../../types';
interface BatchAccount { id: string; user_id: string }
interface BatchOptions { operationId?: string | null; signal?: AbortSignal; [key: string]: unknown }
interface BatchDependencies<T> { process?: (account: BatchAccount, connection: T, options: BatchOptions & { operationId: string }) => Promise<{ needsSync?: boolean; connectionFailed?: boolean }>; limit?: number; executor?: SqlExecutor }

// A claimed 'operation' job drains other due, undispatched operations of the
// same account on its one transport. Every operation still goes through the
// executor with its own fence check and attempt record; dispatched/uncertain
// outcomes stay with their own reconcile jobs. Sibling jobs whose operation
// was settled here find nothing due and finish without connecting.
import imported1 = require('../../state');
const { db } = imported1;
const OPERATION_BATCH_LIMIT = 50;
const DUE = `((is_current=TRUE AND state IN ('queued','retry_wait')) OR (action='move' AND dispatched=TRUE AND state IN ('executing','verifying','reconciling'))
  OR (action IN ('read','star') AND dispatched=TRUE AND state IN ('executing','verifying','reconciling'))) AND available_at<=UTC_TIMESTAMP()`;

// Mirrors the executor's selection for one operation id.
async function operationDue(account: BatchAccount, operationId: string, executor: SqlExecutor = db) {
  const [rows] = await executor.execute<(RowDataPacket & { id: string })[]>(`SELECT id FROM mail_writebacks WHERE id=? AND mail_account_id=? AND user_id=? AND ${DUE} LIMIT 1`,
    [operationId, account.id, account.user_id]);
  return rows.length > 0;
}
async function processOperationBatch<T>(account: BatchAccount, connection: T, options: BatchOptions, { process, limit = OPERATION_BATCH_LIMIT, executor = db }: BatchDependencies<T> = {}) {
  let needsSync = false, connectionFailed = false, processed = 0;
  const run = async (operationId: string) => {
    const result = await process!(account, connection, { ...options, operationId });
    needsSync ||= !!result.needsSync; connectionFailed ||= !!result.connectionFailed; processed++;
  };
  if (options.operationId) await run(options.operationId);
  if (connectionFailed || options.signal?.aborted) return { needsSync, connectionFailed, processed };
  const [rows] = await executor.execute<(RowDataPacket & { id: string })[]>(`SELECT id FROM mail_writebacks WHERE mail_account_id=? AND user_id=?
    AND is_current=TRUE AND dispatched=FALSE AND state IN ('queued','retry_wait') AND available_at<=UTC_TIMESTAMP()
    ORDER BY created_at,id LIMIT ${Math.max(1, Math.floor(limit))}`, [account.id, account.user_id]);
  for (const { id } of rows) {
    if (id === options.operationId) continue;
    if (connectionFailed || options.signal?.aborted || processed >= limit) break;
    await run(id);
  }
  return { needsSync, connectionFailed, processed };
}
export = { operationDue, processOperationBatch, OPERATION_BATCH_LIMIT };
