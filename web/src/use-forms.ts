// What the report and feedback forms share (spec §5.5): the page-level state they need and the
// sending logic.
//
// - `FormSite`: the Turnstile site key, from /api/info, which the page asks the first time a form
//   opens (App provides it). Without a key the forms say reporting is unavailable.
// - `OpenReport`: which hit's report form is open; only one is, on a page (like `OpenView`).
// - `useSend`: token, status and error of one form. After any failed send the widget is reset and
//   the token cleared, so Send stays disabled until a new token arrives; what was typed is kept.
import { createContext } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { report, type ReportBody } from "./lib/api";
import { ReportMaintenance } from "./use-transcript";

export interface FormSite {
  /** `loading` while /api/info is on its way; `unavailable` when it failed or has no key. */
  status: "loading" | "ready" | "unavailable";
  siteKey: string | null;
  /** The first form to open calls this; the page then asks /api/info (once). */
  ask: () => void;
}

export const FormSiteContext = createContext<FormSite>({ status: "unavailable", siteKey: null, ask: () => {} });

/** The site key state for a form that has just opened (asks for it on mount). */
export function useFormSite(): FormSite {
  const site = useContext(FormSiteContext);
  useEffect(() => site.ask(), []);
  return site;
}

export type OpenReportState = [number | null, (chunkId: number | null) => void];

/** The chunk id of the hit whose report form is open. */
export const OpenReport = createContext<OpenReportState | null>(null);

/** Lets the form reset its Turnstile widget. */
export interface Check {
  reset(): void;
}

export type SendStatus = "open" | "sending" | "sent";

const TOO_MANY = "Too many reports from here — please wait a minute, then send again. What you typed is kept.";

export function useSend() {
  const reportMaintenance = useContext(ReportMaintenance);
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<SendStatus>("open");
  const [error, setError] = useState<string | null>(null);
  const check = useRef<Check | null>(null);
  const busy = useRef(false);
  const gone = useRef(false);
  useEffect(
    () => () => {
      gone.current = true;
    },
    [],
  );

  async function send(body: Omit<ReportBody, "turnstile_token">) {
    if (token === null || busy.current) return;
    busy.current = true;
    setStatus("sending");
    setError(null);
    const answer = await report({ ...body, turnstile_token: token }).catch(() => ({ kind: "network" }) as const);
    busy.current = false;
    if (gone.current) return;
    if (answer.kind === "ok") {
      setStatus("sent");
      return;
    }
    let message: string;
    switch (answer.kind) {
      case "refused":
        message = answer.message;
        break;
      case "maintenance":
        reportMaintenance(answer.message);
        message = answer.message;
        break;
      case "rate_limited":
        message = TOO_MANY;
        break;
      case "network":
        message = "Couldn't reach the server. Check your connection, then send again. What you typed is kept.";
        break;
      default:
        message = "Couldn't send that right now. Please try again in a moment. What you typed is kept.";
    }
    setStatus("open");
    setError(message);
    // A token works once, sent or refused: ask for a new one.
    setToken(null);
    check.current?.reset();
  }

  return { token, setToken, status, error, setError, check, send };
}
