// The full-width button that goes across to the other mode (ROUND-2-phone.md "Exact: few or no
// results"): oak "See related passages (beta)" from Exact, plain "See exact matches" from Related.
import { BetaTag } from "./BetaTag";

export function AcrossButton({ to, onClick }: { to: "related" | "exact"; onClick: () => void }) {
  if (to === "related") {
    return (
      <button type="button" class="across across--related" aria-label="See related passages (beta)" onClick={onClick}>
        <span aria-hidden="true">≈</span> See related passages <BetaTag />
      </button>
    );
  }
  return (
    <button type="button" class="across across--exact" onClick={onClick}>
      See exact matches
    </button>
  );
}
