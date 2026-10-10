// The rate-limit countdown (spec §5.6): whole seconds left of `from`, counted from when `key`
// last changed (a new rate-limited answer is a new key). Read from the clock, not by counting
// ticks, so a throttled background tab still ends on time. `from` null means no countdown (0).
// The timer stops at zero and when the page goes away.
import { useEffect, useState } from "preact/hooks";

export function useCountdown(from: number | null, key: unknown): number {
  const [tick, setTick] = useState<{ key: unknown; left: number } | null>(null);

  useEffect(() => {
    if (from === null) return;
    const end = Date.now() + from * 1000;
    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setTick({ key, left });
      if (left === 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [from, key]);

  if (from === null) return 0;
  return tick !== null && tick.key === key ? tick.left : from;
}
