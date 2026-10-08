import type { ApiError } from '../types';

interface ConversionJob {
  userId: string;
  run: () => unknown;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer?: NodeJS.Timeout;
}

function createAudioConversionQueue({ maxWaiting = 4, maxPerUser = 2, maxWaitMs = 60000 } = {}) {
  const pending: ConversionJob[] = [];
  const perUser = new Map<string, number>();
  let active = false;

  function drain() {
    if (active || pending.length === 0) return;
    active = true;
    const job = pending.shift()!;
    clearTimeout(job.timer);
    Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
      const count = perUser.get(job.userId)! - 1;
      if (count) perUser.set(job.userId, count);
      else perUser.delete(job.userId);
      active = false;
      drain();
    });
  }

  return {
    enqueue<T>(userId: string, run: () => T | PromiseLike<T>): Promise<T> {
      const count = perUser.get(userId) || 0;
      if ((active && pending.length >= maxWaiting) || count >= maxPerUser) {
        const error: ApiError = new Error('Audio conversion is busy. Please try the MP3 export again shortly.');
        error.status = 429;
        return Promise.reject(error);
      }
      perUser.set(userId, count + 1);
      return new Promise<T>((resolve, reject) => {
        const job: ConversionJob = { userId, run, resolve: resolve as (value: unknown) => void, reject };
        job.timer = setTimeout(() => {
          const index = pending.indexOf(job);
          if (index === -1) return;
          pending.splice(index, 1);
          const remaining = perUser.get(userId)! - 1;
          if (remaining) perUser.set(userId, remaining);
          else perUser.delete(userId);
          const error: ApiError = new Error('Audio conversion is busy. Please try the MP3 export again shortly.');
          error.status = 429;
          reject(error);
        }, maxWaitMs);
        job.timer.unref?.();
        pending.push(job);
        drain();
      });
    },
  };
}

export { createAudioConversionQueue };
