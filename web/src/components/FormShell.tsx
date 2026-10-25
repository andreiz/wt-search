// What the report and feedback forms have in common (spec §5.5; design README "Report transcript
// error" and "Send feedback"): the labelled form with its title and ×, the fields' counters, the
// Turnstile slot, the states (open, sending at 70% opacity with "Sending…", sent, error) and
// Send / Cancel. The two forms differ only in their fields and in what they send.
//
// With no Turnstile site key (/api/info failed or has none) the form says reporting is
// unavailable and has nothing to send. Esc does not close a form that has fields, so a stray press
// cannot throw away what was typed; Cancel and × do that. Once there is nothing to lose (sent, or
// unavailable) Esc closes it. Submitting (Enter in a single-line field) goes through `onSend`,
// which the forms guard with the same `canSend` that disables Send.
import type { ComponentChildren, RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { codePoints } from "../lib/length";
import type { FormSite, useSend } from "../use-forms";
import { Notice } from "./Notice";
import { TurnstileSlot } from "./TurnstileSlot";

type Sender = ReturnType<typeof useSend>;

export function Field({
  id,
  label,
  optional = false,
  value,
  limit,
  hint,
  placeholder,
  rows,
  multiline = true,
  readOnly,
  serif = false,
  inputRef,
  onInput,
}: {
  id: string;
  label: string;
  optional?: boolean;
  value: string;
  limit: number;
  hint?: string;
  /** An example of what goes in an optional field, shown while it is empty. */
  placeholder?: string;
  rows?: number;
  multiline?: boolean;
  readOnly: boolean;
  serif?: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  onInput: (value: string) => void;
}) {
  const used = codePoints(value);
  const over = used > limit;
  const describedBy = `${id}-count${hint ? ` ${id}-hint` : ""}`;
  const common = {
    id,
    class: `field__input${serif ? " field__input--serif" : ""}`,
    value,
    placeholder,
    readOnly,
    "aria-describedby": describedBy,
    "aria-invalid": over ? ("true" as const) : undefined,
    onInput: (event: Event) => onInput((event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value),
  };
  return (
    <div class="field">
      <div class="field__top">
        <label class="field__label" for={id}>
          {label}
          {optional && <span class="field__optional"> (optional)</span>}
        </label>
        <span id={`${id}-count`} class={`field__count${over ? " field__count--over" : ""}`}>
          {`${used} / ${limit}`}
          {over && <span class="visually-hidden"> — too long</span>}
        </span>
      </div>
      {multiline ? (
        <textarea {...common} rows={rows ?? 2} ref={inputRef as RefObject<HTMLTextAreaElement>} />
      ) : (
        <input {...common} type="text" ref={inputRef as RefObject<HTMLInputElement>} />
      )}
      {hint && (
        <span id={`${id}-hint`} class="field__hint">
          {hint}
        </span>
      )}
    </div>
  );
}

export function FormShell({
  label,
  title,
  closeLabel,
  sentText,
  site,
  sender,
  canSend,
  onSend,
  onClose,
  focusRef,
  children,
}: {
  /** The form's accessible name, also what the title says in short. */
  label: string;
  title: string;
  closeLabel: string;
  sentText: string;
  site: FormSite;
  sender: Sender;
  /** Everything but the token and the status is fine: the fields are valid. */
  canSend: boolean;
  onSend: () => void;
  onClose: () => void;
  /** The field that takes focus when the form opens. */
  focusRef: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  children: ComponentChildren;
}) {
  const form = useRef<HTMLFormElement>(null);
  const sentBox = useRef<HTMLDivElement>(null);
  const { status, token, error } = sender;
  const unavailable = site.status === "unavailable";
  const sending = status === "sending";
  const ready = canSend && token !== null && status === "open";

  // Opening moves focus into the form: its first field, or the form itself when there is nothing to fill in.
  // Focus alone brings at most the field onto the screen (and on a phone not even that), so the
  // whole form is scrolled into view: all of it when it fits, from its top when it does not.
  useEffect(() => {
    (unavailable ? form.current : focusRef.current)?.focus({ preventScroll: true });
    const el = form.current;
    if (!el) return;
    el.scrollIntoView({ block: el.getBoundingClientRect().height > window.innerHeight ? "start" : "nearest" });
  }, [unavailable]);

  // The fields are gone once sent: focus goes to the thanks.
  useEffect(() => {
    if (status === "sent") sentBox.current?.focus();
  }, [status]);

  return (
    <form
      class="form"
      ref={form}
      tabIndex={-1}
      aria-label={label}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onSend();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        if (!unavailable && status !== "sent") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <div class="form__head">
        <h4 class="form__title">{title}</h4>
        <button type="button" class="form__close" aria-label={closeLabel} onClick={onClose}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      {unavailable ? (
        <>
          <Notice tone="warning">Reporting is unavailable right now. Please try again later.</Notice>
          <div class="form__actions">
            <button type="button" class="form__cancel" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : status === "sent" ? (
        <>
          <div class="form__sent" role="status" tabIndex={-1} ref={sentBox}>
            <span class="form__sent-icon" aria-hidden="true">
              ✓
            </span>
            <span>{sentText}</span>
          </div>
          <div class="form__actions">
            <button type="button" class="form__cancel" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <div class={`form__body${sending ? " form__body--sending" : ""}`} aria-busy={sending ? "true" : undefined}>
          {children}
          {site.siteKey !== null ? (
            <TurnstileSlot siteKey={site.siteKey} onToken={sender.setToken} checkRef={sender.check} />
          ) : (
            <p class="form__wait">Getting the security check ready…</p>
          )}
          {error !== null && (
            <Notice tone="danger" role="alert">
              {error}
            </Notice>
          )}
          <div class="form__actions">
            <button type="submit" class="form__send" disabled={!ready}>
              {sending ? "Sending…" : "Send"}
            </button>
            <button type="button" class="form__cancel" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
