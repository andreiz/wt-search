// `role="text"` on a span: a WebKit role, not in the ARIA spec (so not in Preact's types), that
// makes VoiceOver read the span as one piece of text. Without it VoiceOver stops at every inline
// element inside, and a passage with highlighted words is read a few words at a time, each
// needing a keystroke (the maintainer, 2026-10-11). Other screen readers ignore the role.
// Only for text with nothing to operate inside it: a link or a button in there would be hidden.
import type { HTMLAttributes } from "preact";

export const ONE_TEXT = { role: "text" } as unknown as HTMLAttributes<HTMLSpanElement>;
