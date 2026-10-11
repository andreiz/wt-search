// "Send feedback" (spec §5.5; design: Screen.dc.html 2j, 3w, 3x): the footer's inline form, a
// Message (1–1000) and Turnstile. It posts `{note, turnstile_token}` and nothing else: no
// `chunk_id` key at all, which is what makes the Worker store it as feedback. The footer owns
// opening and closing and returns focus to its "Send feedback" button.
import { useRef, useState } from "preact/hooks";
import { codePoints } from "../lib/length";
import { useFormSite, useSend } from "../use-forms";
import { Field, FormShell } from "./FormShell";

export const MESSAGE_MAX = 1000;

export function FeedbackForm({ onClose }: { onClose: () => void }) {
  const site = useFormSite();
  const sender = useSend();
  const [message, setMessage] = useState("");
  const field = useRef<HTMLTextAreaElement | HTMLInputElement>(null);

  const length = codePoints(message);
  const canSend = length >= 1 && length <= MESSAGE_MAX;

  return (
    <FormShell
      label="Send feedback"
      title="Send feedback"
      closeLabel="Close feedback form"
      sentText="Thanks — we read every message."
      site={site}
      sender={sender}
      canSend={canSend}
      onSend={() => {
        if (canSend) void sender.send({ note: message.trim() });
      }}
      onClose={onClose}
      focusRef={field}
    >
      <Field
        id="feedback-message"
        label="Message"
        value={message}
        limit={MESSAGE_MAX}
        rows={4}
        hint="Search didn't find something? Have an idea? Tell us."
        readOnly={sender.status === "sending"}
        inputRef={field}
        onInput={setMessage}
      />
    </FormShell>
  );
}
