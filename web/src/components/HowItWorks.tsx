// "How this works", beside the Related summary (spec §5.2, "Related search explains itself"): a
// button and the small popover it opens, built like the `?` syntax help (lib/use-popover.ts).
// It says why Related has no total and what "Related" means, and "Switch to Exact" changes the mode.
// The copy is the maintainer's, word for word.
import { useId, useLayoutEffect, useRef } from "preact/hooks";
import { usePopover } from "../lib/use-popover";

export function HowItWorks({ onSwitchToExact }: { onSwitchToExact: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const dialogId = useId();
  const { open, setOpen, root, onKeyDown } = usePopover(button);

  // Opening moves focus into the dialog, so Esc and Tab are heard there (as in SyntaxHelp).
  useLayoutEffect(() => {
    if (open) dialog.current?.focus();
  }, [open]);

  return (
    <div class="how-works" ref={root} onKeyDown={onKeyDown}>
      <button
        type="button"
        class="how-works__button"
        ref={button}
        aria-haspopup="dialog"
        aria-controls={dialogId}
        aria-expanded={open ? "true" : "false"}
        onClick={() => setOpen(!open)}
      >
        How this works
      </button>
      {open && (
        <div class="popover how-works__dialog" id={dialogId} role="dialog" aria-label="How Related search works" tabIndex={-1} ref={dialog}>
          <p>
            <strong>Related search</strong> finds passages two ways: ones that contain your words, and ones that talk about the same
            thing in different words. Those are marked <strong>Related</strong>.
          </p>
          <p>
            It shows the best matches first, up to 100. There is no total, because "about the same thing" has no cut-off: every
            passage is a little bit related, so a count would mean nothing.
          </p>
          <p>It is a beta: the results are uneven.</p>
          <p>
            Want every match and a count?{" "}
            <button
              type="button"
              class="text-button"
              onClick={() => {
                setOpen(false);
                onSwitchToExact();
              }}
            >
              Switch to Exact
            </button>
            .
          </p>
        </div>
      )}
    </div>
  );
}
