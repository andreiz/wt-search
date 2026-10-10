// The small triangle in front of a timestamp that plays (the card's chip, the transcript's labels).
export function PlayIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3 1.5v11l9.5-5.5z" fill="currentColor" />
    </svg>
  );
}
