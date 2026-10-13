type Timers = Pick<typeof globalThis, 'setInterval'>;

/**
 * Runs `task` every `intervalMs`, skipping a tick while the previous run is
 * still in progress. Without this, a timer keeps starting runs while the
 * database is slow; each waits for a pool connection, the pool fills, every
 * request queues behind them, and the slowdown feeds itself. A failure is
 * logged under `label` and the next tick runs again.
 *
 * Returns the guarded task, so a caller can also run it right away.
 */
function everyInterval(label: string, intervalMs: number, task: () => unknown, timers: Timers = globalThis) {
  let running = false;
  const tick = async () => {
    if (running) return false;
    running = true;
    try {
      await task();
    } catch (error) {
      console.error(`[${label}] Failed:`, (error as Error).message);
    } finally {
      running = false;
    }
    return true;
  };
  timers.setInterval(() => { void tick(); }, intervalMs);
  return tick;
}

export { everyInterval };
