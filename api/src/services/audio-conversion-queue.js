function createAudioConversionQueue({ maxWaiting = 4, maxPerUser = 2, maxWaitMs = 60000 } = {}) {
  const pending = [];
  const perUser = new Map();
  let active = false;

  function drain() {
    if (active || pending.length === 0) return;
    active = true;
    const job = pending.shift();
    clearTimeout(job.timer);
    Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
      const count = perUser.get(job.userId) - 1;
      if (count) perUser.set(job.userId, count);
      else perUser.delete(job.userId);
      active = false;
      drain();
    });
  }

  return {
    enqueue(userId, run) {
      const count = perUser.get(userId) || 0;
      if ((active && pending.length >= maxWaiting) || count >= maxPerUser) {
        const error = new Error('Audio conversion is busy. Please try the MP3 export again shortly.');
        error.status = 429;
        return Promise.reject(error);
      }
      perUser.set(userId, count + 1);
      return new Promise((resolve, reject) => {
        const job = { userId, run, resolve, reject };
        job.timer = setTimeout(() => {
          const index = pending.indexOf(job);
          if (index === -1) return;
          pending.splice(index, 1);
          const remaining = perUser.get(userId) - 1;
          if (remaining) perUser.set(userId, remaining);
          else perUser.delete(userId);
          const error = new Error('Audio conversion is busy. Please try the MP3 export again shortly.');
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

module.exports = { createAudioConversionQueue };
