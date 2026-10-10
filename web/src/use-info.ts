// GET /api/info for the empty state (spec §4.4, §5.6): the episode count and newest date for the
// line under the examples. Asked once, the first time the empty state is shown (so a page that
// opens on a search never asks), and aborted if the page goes away. A failed answer is silent:
// the line is simply left out. A `maintenance` answer is passed on, for the banner.
import { useEffect, useRef, useState } from "preact/hooks";
import { info, type InfoResponse } from "./lib/api";

export function useInfo(wanted: boolean, onMaintenance: (message: string) => void): InfoResponse | null {
  const [data, setData] = useState<InfoResponse | null>(null);
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
        if (answer.kind === "ok") setData(answer.data);
        else if (answer.kind === "maintenance") report.current(answer.message);
      },
      // Only an abort throws.
      () => {},
    );
  }, [wanted]);

  useEffect(() => () => controller.current?.abort(), []);

  return data;
}
