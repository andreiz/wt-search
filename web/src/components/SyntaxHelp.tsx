// The `?` button and the syntax table it opens (SearchHeader.dc.html; spec §5.2; brief §5). Each
// example is a button that puts the example in the search box; nothing is searched until Enter.
import { useId, useLayoutEffect, useRef } from "preact/hooks";
import { usePopover } from "../lib/use-popover";

const ROWS: { examples: string[]; finds: string }[] = [
  { examples: ["hide glue"], finds: "both words" },
  { examples: ['"hide glue"'], finds: "the exact phrase" },
  { examples: ["titebond -hide"], finds: "without a word" },
  { examples: ["glue OR epoxy"], finds: "either" },
  { examples: ["dovetail*"], finds: "words starting with it" },
  { examples: ["year:2015", "after:2019", "before:2012"], finds: "by year (after and before leave out the year itself)" },
  { examples: ["year:2015-2020"], finds: "years 2015 to 2020, both included" },
  { examples: ["ep:613"], finds: "one episode" },
];

export function SyntaxHelp({ onPick }: { onPick: (example: string) => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const dialogId = useId();
  const { open, setOpen, root, onKeyDown } = usePopover(button);

  // Opening moves focus into the dialog, so Esc and Tab are heard there. A layout effect: it runs
  // as the dialog appears, so a quick Esc cannot land before it and then lose focus to it.
  useLayoutEffect(() => {
    if (open) dialog.current?.focus();
  }, [open]);

  return (
    <div class="syntax-help" ref={root} onKeyDown={onKeyDown}>
      <button
        type="button"
        class={`syntax-help__button${open ? " syntax-help__button--open" : ""}`}
        ref={button}
        aria-label="Search syntax help"
        aria-haspopup="dialog"
        aria-controls={dialogId}
        aria-expanded={open ? "true" : "false"}
        onClick={() => setOpen(!open)}
      >
        ?
      </button>
      {open && (
        <div class="popover syntax-help__dialog" id={dialogId} role="dialog" aria-label="Search syntax" tabIndex={-1} ref={dialog}>
          <div class="syntax-help__head">
            <strong class="popover__title">Search syntax</strong>
            <span class="syntax-help__esc">Esc to close</span>
          </div>
          <table class="syntax-help__table">
            <thead class="visually-hidden">
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Finds</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.finds}>
                  <td class="syntax-help__examples">
                    {row.examples.map((example) => (
                      <button
                        key={example}
                        type="button"
                        class="syntax-help__example"
                        onClick={() => {
                          setOpen(false);
                          onPick(example);
                        }}
                      >
                        {example}
                      </button>
                    ))}
                  </td>
                  <td class="syntax-help__finds">{row.finds}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
