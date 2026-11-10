import { useEffect, useState } from 'react';

/** Whole seconds until `until` (ms since the epoch), updated every second; null once it has passed or without a time. */
export function useCountdown(until: number | null) {
  const left = () => (until && until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : null);
  const [seconds, setSeconds] = useState<number | null>(left);
  useEffect(() => {
    setSeconds(left());
    if (!until || until <= Date.now()) return;
    const timer = window.setInterval(() => setSeconds(left()), 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [until]);
  return seconds;
}
