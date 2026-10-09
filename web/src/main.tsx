// Entry point: styles, then mount <App/>. Spec §5.1.
import { render } from "preact";
import { App } from "./app";
import "./styles/tokens.css";
import "./styles/fonts.css";
import "./styles/base.css";

const root = document.getElementById("app");
if (root) render(<App />, root);
