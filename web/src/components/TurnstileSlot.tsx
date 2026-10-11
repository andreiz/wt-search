// The Turnstile widget of a form (spec §5.5). It is rendered when the slot mounts (the form
// opens) and removed when it unmounts (the form closes or is sent). Its token goes up through
// `onToken`; an expired token or a widget error sends `null`. If the script cannot load, the slot
// says so and offers another try.
import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { load, remove, render, reset } from "../lib/turnstile";
import type { Check } from "../use-forms";

export function TurnstileSlot({
  siteKey,
  onToken,
  checkRef,
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
  /** Filled with a handle to reset the widget. */
  checkRef: RefObject<Check | null>;
}) {
  const el = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const latest = useRef(onToken);
  latest.current = onToken;
  const [problem, setProblem] = useState<"load" | "run" | null>(null);
  const [attempt, setAttempt] = useState(0);

  checkRef.current = {
    reset() {
      if (widget.current === null) return;
      try {
        reset(widget.current);
      } catch {
        // The widget is already gone.
      }
    },
  };

  useEffect(() => {
    let cancelled = false;
    load().then(
      () => {
        const target = el.current;
        if (cancelled || !target) return;
        try {
          widget.current = render(
            target,
            siteKey,
            (token) => {
              setProblem(null);
              latest.current(token);
            },
            () => latest.current(null),
            () => {
              latest.current(null);
              setProblem("run");
            },
          );
        } catch {
          setProblem("load");
        }
      },
      () => {
        if (!cancelled) setProblem("load");
      },
    );
    return () => {
      cancelled = true;
      const id = widget.current;
      widget.current = null;
      if (id === null) return;
      try {
        remove(id);
      } catch {
        // Nothing left to remove.
      }
    };
  }, [siteKey, attempt]);

  return (
    <div class="turnstile">
      <div class="turnstile__widget" ref={el} />
      {problem === "load" && (
        <p class="turnstile__problem" role="alert">
          The security check couldn't load.{" "}
          <button
            type="button"
            class="form__link"
            onClick={() => {
              setProblem(null);
              setAttempt(attempt + 1);
            }}
          >
            Try again
          </button>
        </p>
      )}
      {problem === "run" && (
        <p class="turnstile__problem" role="alert">
          The security check hit a problem. Reload the page if it doesn't come back.
        </p>
      )}
    </div>
  );
}
