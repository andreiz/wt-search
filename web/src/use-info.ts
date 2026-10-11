// GET /api/info (spec §4.4, §5.6, §5.5). It serves the empty state (the episode count and newest
// date for the line under the examples) and the forms (the Turnstile site key). Asked once, the
// first time either is wanted (so a page that opens on a search and never opens a form never
// asks), and aborted if the page goes away. A failed answer is silent here: `failed` says so, the
// empty state leaves its line out and the forms say reporting is unavailable. A `maintenance`
// answer is passed on, for the banner.
import { useEffect, useRef, useState } from "preact/hooks";
import { info, type InfoResponse } from "./lib/api";

export interface InfoState {
  data: InfoResponse | null;
  /** The request ended without a usable answer. */
  failed: boolean;
}

export function useInfo(wanted: boolean, onMaintenance: (message: string) => void): InfoState {
  const [state, setState] = useState<InfoState>({ data: null, failed: false });
  const asked = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const report = useRef(onMaintenance);
  report.current = onMaintenance;

  useEffect(() => {
    if (!wanted || asked.current) return;
    asked.current = true;
    const ac = new AbortController();
    controller.current = ac;
    info(ac.signal).then(
      (answer) => {
        if (answer.kind === "ok") setState({ data: answer.data, failed: false });
        else {
          if (answer.kind === "maintenance") report.current(answer.message);
          setState({ data: null, failed: true });
        }
      },
      // Only an abort throws.
      () => {},
    );
  }, [wanted]);

  useEffect(() => () => controller.current?.abort(), []);

  return state;
}
