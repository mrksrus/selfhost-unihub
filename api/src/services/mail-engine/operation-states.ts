// mail_writebacks.state: the life cycle of one accepted provider change. Every
// policy list is spelled here once and the SQL fragments are built from the
// arrays, so the executor, the scheduler, the routes, recovery and purge checks
// cannot drift apart on which states count as waiting, unresolved or settled.
import { sqlList } from './job-kinds';

const OPERATION_STATES = ['queued', 'retry_wait', 'executing', 'verifying', 'reconciling', 'needs_attention',
  'confirmed', 'rejected', 'cancelled', 'superseded'] as const;
type OperationState = (typeof OPERATION_STATES)[number];
// Each literal is checked against the union; the lists stay plain string
// arrays so a database column value (string) can be looked up in them.
const states = (...list: OperationState[]): readonly string[] => list;
// A one-off SQL list whose members are still checked against the union.
const sqlStates = (...list: OperationState[]) => sqlList(list);

// An undispatched intent waiting for an executor pass.
const WAITING = states('queued', 'retry_wait');
// Dispatched to the provider; a worker still owes the outcome check.
const UNRESOLVED = states('executing', 'verifying', 'reconciling');
// A dispatched effect not proven either way. needs_attention is a bounded
// worker outcome, not proof of the remote effect, so it belongs here too.
const UNPROVEN = [...UNRESOLVED, ...states('needs_attention')];
// A current intent still being worked on.
const ACTIVE = [...WAITING, ...UNRESOLVED];
// Final: no worker touches the row again. 'rejected' is final but keeps status
// 'conflict' so the user can retry it.
const SETTLED = states('confirmed', 'cancelled', 'superseded', 'rejected');
// Settled with status 'done'; setState never overwrites one of these.
const DONE = states('confirmed', 'cancelled', 'superseded');
// Shown to the user as a conflict that needs a decision.
const CONFLICT = states('needs_attention', 'rejected');

// mail_writebacks.status is the browser's coarse view of a state.
const statusFor = (state: string) => DONE.includes(state) ? 'done' : CONFLICT.includes(state) ? 'conflict' : 'pending';

// Rows one executor pass may act on: an undispatched current intent, or a
// dispatched effect whose outcome check is still owed. A dispatched MOVE is
// only ever re-checked on later passes, never re-sent; operation-batch selects
// by the same predicate for one id.
const DUE_SQL = `((is_current=TRUE AND state IN (${sqlList(WAITING)})) OR (action='move' AND dispatched=TRUE AND state IN (${sqlList(UNRESOLVED)}))
  OR (action IN ('read','star') AND dispatched=TRUE AND state IN (${sqlList(UNRESOLVED)}))) AND available_at<=UTC_TIMESTAMP()`;

interface OperationView { action: string; state: string; dispatched: unknown; is_current?: unknown }
const on = (value: unknown) => Boolean(Number(value));
// These predicates mirror the WHERE clauses of retryWriteback/cancelWriteback.
// A dispatched MOVE only gets a read-only outcome check and is never discarded:
// its provider effect may have happened. Flag set/clear is idempotent, so a
// stuck flag is retried from a fresh provider read or discarded.
const RETRYABLE = states('needs_attention', 'retry_wait', 'rejected', 'reconciling');
const CANCELLABLE = states('queued', 'retry_wait', 'needs_attention', 'reconciling');
// A dispatched MOVE in one of these may get another bounded outcome check.
const MOVE_RECHECK = states('needs_attention', 'reconciling', 'retry_wait');
const dispatchedMove = (op: OperationView) => op.action === 'move' && on(op.dispatched);
function canRetry(op: OperationView) {
  if (dispatchedMove(op)) return MOVE_RECHECK.includes(op.state);
  if (!on(op.is_current)) return false;
  return on(op.dispatched) ? op.state === 'needs_attention' : RETRYABLE.includes(op.state);
}
function canCancel(op: OperationView) {
  if (on(op.dispatched)) return op.action !== 'move' && op.state === 'needs_attention';
  return CANCELLABLE.includes(op.state);
}
// Mirrors the WHERE clause of acceptServerState.
const canAcceptServerState = (op: OperationView) => dispatchedMove(op) && op.state === 'needs_attention';

export {
  OPERATION_STATES,
  WAITING,
  UNRESOLVED,
  UNPROVEN,
  ACTIVE,
  SETTLED,
  DONE,
  CONFLICT,
  CANCELLABLE,
  MOVE_RECHECK,
  DUE_SQL,
  sqlStates,
  statusFor,
  dispatchedMove,
  canRetry,
  canCancel,
  canAcceptServerState,
};
export type { OperationState, OperationView };
