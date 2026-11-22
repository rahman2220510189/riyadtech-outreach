"use client";

import { useEffect, useState } from "react";

/** True once `active` has been true for `afterMs` (e.g. to explain a slow backend wake-up). */
export function useSlowHint(active: boolean, afterMs = 5_000): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setSlow(true), afterMs);
    return () => {
      clearTimeout(t);
      setSlow(false);
    };
  }, [active, afterMs]);
  return active && slow;
}

export const WAKE_UP_HINT =
  "The server is waking up. On the free plan this can take up to a minute the first time each day.";
