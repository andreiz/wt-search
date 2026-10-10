// The platform pills of a hit row (DenseResult.dc.html; spec §5.3): a desktop shows every
// platform, the first filled; a phone shows the first only, with the hit's time. Each is a link
// from the API, opened in a new tab, named for its own cue time ("Play on YouTube at 1:09:44").
import type { Platform } from "../lib/platforms";
import { playName } from "../lib/platforms";

export function PlayIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3 1.5v11l9.5-5.5z" fill="currentColor" />
    </svg>
  );
}

export function PlayButtons({
  platforms,
  phone,
  related,
  time,
}: {
  /** The platforms to show as pills. */
  platforms: Platform[];
  phone: boolean;
  /** A related card has outlined pills only. */
  related: boolean;
  /** The hit's time, "1:09:51", shown in the phone pill. */
  time: string;
}) {
  return (
    <>
      {platforms.map((platform, index) => (
        <a
          key={platform.key}
          class={`play${index === 0 && !related ? " play--primary" : ""}`}
          href={platform.href}
          target="_blank"
          rel="noopener"
          aria-label={playName(platform, time, phone ? "time" : "name")}
          title={playName(platform, time, phone ? "time" : "name")}
        >
          <PlayIcon />
          {platform.name}
          {phone && <span class="play__time">{time}</span>}
        </a>
      ))}
    </>
  );
}
