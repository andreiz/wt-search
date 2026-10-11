// An inline notice (design README "Notices"): a tone-tinted box with a round icon, a message and,
// optionally, one action (Retry) or a countdown. It is a status, so a screen reader hears it when
// it appears; the maintenance banner is the one alert (Banner.tsx).
import type { ComponentChildren } from "preact";

export type Tone = "info" | "warning" | "danger";

const ICON: Record<Tone, string> = { info: "i", warning: "!", danger: "!" };

export function Notice({
  tone,
  children,
  action,
  role = "status",
}: {
  tone: Tone;
  children: ComponentChildren;
  action?: ComponentChildren;
  /** `alert` for an error the person has to act on (a form that failed to send). */
  role?: "status" | "alert";
}) {
  return (
    <div class={`notice notice--${tone}`} role={role}>
      <span class="notice__icon" aria-hidden="true">
        {ICON[tone]}
      </span>
      <span class="notice__text">{children}</span>
      {action}
    </div>
  );
}
