// Three skeleton cards while a search is loading (Screen.dc.html "loading"; spec §5.6).
// Decoration only: hidden from screen readers (the status region says "Searching…"), and static,
// so there is nothing for `prefers-reduced-motion` to switch off.
const WIDTHS = ["skeleton__title--a", "skeleton__title--b", "skeleton__title--c"];

export function Skeleton() {
  return (
    <ol class="skeleton" aria-hidden="true" aria-busy="true">
      {WIDTHS.map((width) => (
        <li key={width} class="skeleton__card">
          <div class={`skeleton__bar skeleton__title ${width}`} />
          <div class="skeleton__bar skeleton__meta" />
          <div class="skeleton__lines">
            <div class="skeleton__bar skeleton__line" />
            <div class="skeleton__bar skeleton__line" />
            <div class="skeleton__bar skeleton__line skeleton__line--short" />
          </div>
        </li>
      ))}
    </ol>
  );
}
