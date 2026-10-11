// "Report transcript error" (spec §5.5; design: ResultCard.dc.html states 2f, 3q–3s): the inline
// form under a hit row. Quoted text (the person's selection from this card, else the excerpt;
// 1–500), Suggested correction (optional, 500), Note (optional, 1000), a Turnstile widget and Send.
// Lengths are counted in code points like the Worker does (lib/length.ts). The hit row owns
// opening and closing and returns focus to its ⋯ button.
import { useRef, useState } from "preact/hooks";
import { clip, codePoints } from "../lib/length";
import { useFormSite, useSend } from "../use-forms";
import { Field, FormShell } from "./FormShell";

export const QUOTED_MAX = 500;
export const SUGGESTED_MAX = 500;
export const NOTE_MAX = 1000;

export function ReportForm({
  chunkId,
  initialQuote,
  onClose,
}: {
  chunkId: number;
  /** The selection or the excerpt's text, to start the quoted field with. */
  initialQuote: string;
  onClose: () => void;
}) {
  const site = useFormSite();
  const sender = useSend();
  const [quoted, setQuoted] = useState(() => clip(initialQuote.replace(/\s+/g, " ").trim(), QUOTED_MAX));
  const [suggested, setSuggested] = useState("");
  const [note, setNote] = useState("");
  const quotedField = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
  const id = `report-${chunkId}`;
  const sending = sender.status === "sending";

  const canSend =
    codePoints(quoted) > 0 &&
    codePoints(quoted) <= QUOTED_MAX &&
    codePoints(suggested) <= SUGGESTED_MAX &&
    codePoints(note) <= NOTE_MAX;

  function onSend() {
    if (!canSend) return;
    const fix = suggested.trim();
    const extra = note.trim();
    void sender.send({
      chunk_id: chunkId,
      quoted_text: quoted.trim(),
      ...(fix !== "" ? { suggested_text: fix } : {}),
      ...(extra !== "" ? { note: extra } : {}),
    });
  }

  return (
    <FormShell
      label="Report a transcript error"
      title="Report a transcript error"
      closeLabel="Close report form"
      sentText="Thanks — we'll review it."
      site={site}
      sender={sender}
      canSend={canSend}
      onSend={onSend}
      onClose={onClose}
      focusRef={quotedField}
    >
      <Field
        id={`${id}-quoted`}
        label="Quoted text"
        value={quoted}
        limit={QUOTED_MAX}
        rows={3}
        serif
        readOnly={sending}
        inputRef={quotedField}
        onInput={setQuoted}
      />
      <Field
        id={`${id}-fix`}
        label="Suggested correction"
        optional
        value={suggested}
        limit={SUGGESTED_MAX}
        multiline={false}
        serif
        readOnly={sending}
        onInput={setSuggested}
      />
      <Field
        id={`${id}-note`}
        label="Note"
        optional
        value={note}
        limit={NOTE_MAX}
        multiline={false}
        readOnly={sending}
        onInput={setNote}
      />
    </FormShell>
  );
}
