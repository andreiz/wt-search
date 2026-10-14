// The small BETA tag beside "Related" (ROUND-2-phone.md "BETA treatment"). Visual only: the
// accessible names say "beta" themselves, so a screen reader doesn't hear it twice.
export function BetaTag() {
  return (
    <span class="beta-tag" aria-hidden="true">
      BETA
    </span>
  );
}
