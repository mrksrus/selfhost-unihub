// Keeps the instance backup's schedule out of the drill's way
// (scripts/instance-backup-drill.mts). The source runs with the backup on, so
// its scheduler (background-work.ts, every minute) starts a run whenever no
// scheduled run has started since the latest daily slot, also as a catch-up
// after the server was down (instance-backup.ts runDueInstanceBackup). A new
// installation has no scheduled history, so that catch-up comes at any hour.
// The drill sets the daily time 12 hours before it starts, waits until the
// catch-up run for that slot has finished, and only then takes its views,
// presses Back up now and takes its snapshot: the slot is covered and the
// next one is half a day away. It follows its own run by id, so another run
// listed after it does not hide it.

type Row = Record<string, unknown>;
export interface StatusSession { json<T = Record<string, unknown>>(method: string, path: string): Promise<T> }
export interface BackupStatus { running: boolean; runs: Row[]; key_fingerprint: string | null }
interface Poll { timeoutMs: number; pollMs?: number; sleep?: (ms: number) => Promise<void> }

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const HOUR = 3600 * 1000;

/** INSTANCE_BACKUP_TIME for a drill starting at now, the slot it makes current, and the next one. */
export function drillSchedule(now: Date) {
  const at = new Date(now.getTime() - 12 * HOUR);
  const time = `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
  // As instance-backup.ts latestSlot: the latest daily moment at or before now.
  const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), at.getUTCHours(), at.getUTCMinutes()));
  if (slot > now) slot.setUTCDate(slot.getUTCDate() - 1);
  const next = new Date(slot.getTime() + 24 * HOUR);
  return { time, slot, next };
}

/** Why the schedule could still start a run; null once the slot's run has succeeded and nothing runs. A failed one throws. */
export function scheduleProblem(status: BackupStatus, slot: Date) {
  const covering = status.runs.filter(run => run.trigger === 'schedule' && Date.parse(String(run.started_at)) >= slot.getTime());
  if (!covering.length) return `no scheduled run since the slot of ${slot.toISOString()} yet`;
  if (status.running) return 'a run is still running';
  if (!covering.some(run => run.status === 'succeeded')) throw new Error(`The scheduled instance backup of this slot failed: ${JSON.stringify(covering)}`);
  return null;
}

async function poll<T>(session: StatusSession, { timeoutMs, pollMs = 1000, sleep = pause }: Poll, step: (status: BackupStatus) => T | null, what: () => string) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await session.json<BackupStatus>('GET', '/api/admin/instance-backup');
    const result = step(status);
    if (result !== null) return result;
    if (Date.now() > deadline) throw new Error(`${what()}: ${JSON.stringify({ running: status.running, runs: status.runs.slice(0, 5) })}`);
    await sleep(pollMs);
  }
}

/** Waits until the slot's scheduled run has finished, so no run starts before the next slot. */
export async function waitForQuietSchedule(session: StatusSession, slot: Date, options: Poll) {
  let problem: string | null = null;
  await poll(session, options, status => (problem = scheduleProblem(status, slot)) === null ? true : null,
    () => `The instance backup schedule did not settle (${problem})`);
}

/** Waits for the run with this id to succeed with nothing else running; a failed run throws. */
export async function waitForRun(session: StatusSession, id: string, options: Poll) {
  return poll(session, options, status => {
    const run = status.runs.find(entry => entry.id === id);
    if (run?.status === 'failed') throw new Error(`The instance backup failed: ${run.error}`);
    return run?.status === 'succeeded' && !status.running ? { run, fingerprint: status.key_fingerprint } : null;
  }, () => `The instance backup ${id} did not finish`);
}
