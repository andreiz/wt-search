// Whether the window is phone width (below 600 px; design README "Layout"). Used only where the
// DOM itself must differ on a phone (the result card's actions and menu); everything that is only
// size is a media query in the stylesheet, with the same breakpoint.
import { useEffect, useState } from "preact/hooks";

const QUERY = "(max-width: 599.98px)";

function matches(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(QUERY).matches;
}

export function usePhone(): boolean {
  const [phone, setPhone] = useState(matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(QUERY);
    const onChange = () => setPhone(matches());
    query.addEventListener("change", onChange);
    onChange();
    return () => query.removeEventListener("change", onChange);
  }, []);
  return phone;
}
