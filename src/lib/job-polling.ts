const ACTIVE_JOB_STATUSES = new Set(['queued', 'running', 'validating', 'cancelling']);

export function jobPollInterval(jobs: ReadonlyArray<{ status: string }> | undefined, active: boolean, interval: number): number | false {
  return active && jobs?.some((job) => ACTIVE_JOB_STATUSES.has(job.status)) ? interval : false;
}
