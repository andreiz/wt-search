// Entry point: styles, then mount <App/>. Spec §5.1.
import { render } from "preact";
import { App } from "./app";
import { applyTrafficSwitch, setMaintainer } from "./lib/traffic";
import "./styles/tokens.css";
import "./styles/fonts.css";
import "./styles/base.css";
import "./styles/components.css";

// The maintainer's `?me=1` switch (lib/traffic.ts), before the app mounts so that a first search
// from the URL already carries it. localStorage itself can throw (blocked site data).
let storage: Storage | null = null;
try {
  storage = window.localStorage;
} catch {
  storage = null;
}
const { counted, cleanUrl } = applyTrafficSwitch(new URL(window.location.href), storage);
if (cleanUrl !== null) window.history.replaceState(window.history.state, "", cleanUrl);
setMaintainer(!counted);

const root = document.getElementById("app");
if (root) render(<App />, root);
