// The look of the HUD, the countdown, captions, toasts and screens: the
// browser build's style.css rewritten class-based in tools/ui-style.css and
// converted with `starhermit css` into assets/ui-style.json (`npm run css`),
// registered at start with the theme the runtime's own widgets take. The
// colour-vision palettes (body[data-palette]) and the runtime's high
// contrast option (body.high-contrast) are token sets.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string>;
const BASE: Tokens = {
  bg: "#10141f", panel: "#1a2233", panel2: "#232e45", ink: "#f2ead8", "ink-dim": "#b8b0a0",
  accent: "#ffc861", accent2: "#9affd0", danger: "#ff5a4e", focus: "#8fb0ff", dark: "#201808",
};
const PALETTES: Record<string, Tokens> = {
  default: {},
  deuteranopia: { accent: "#ffd24a", accent2: "#7ad0ff", danger: "#ff7a3e" },
  protanopia: { accent: "#ffe27a", accent2: "#8ac8ff", danger: "#ff8a5e" },
  tritanopia: { accent: "#ffb85a", accent2: "#7affc8", danger: "#ff5a7a" },
  mono: { accent: "#e8e8e8", accent2: "#b0b0b0", danger: "#ffffff" },
};
const CONTRAST: Tokens = { panel: "#000000", panel2: "#111111", ink: "#ffffff", "ink-dim": "#dddddd", accent: "#ffe600" };

let current: Tokens = { ...BASE };
let css: ui.CssStyles | null = null;
let key = "";
export function initStyles(): void {
  css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setFont({ family: "sans-serif" });
  ui.setTheme({
    fontSize: 16, smallSize: 14, headingSize: 24, padding: 8, spacing: 8, radius: 10,
    text: BASE.ink!, muted: BASE["ink-dim"]!, panel: BASE.panel!, control: BASE.panel2!, hovered: "#2c3a56",
    pressed: "#34446a", field: BASE.panel2!, accent: BASE.accent!, focus: BASE.focus!, outline: "#766445",
  });
  key = "";
}
/** The palette and contrast tokens (cheap when unchanged). */
export function applyTokens(palette: string, highContrast: boolean): void {
  const k = `${palette}:${highContrast}`;
  if (k === key || !css) return;
  key = k;
  current = { ...BASE, ...(PALETTES[palette] ?? {}), ...(highContrast ? CONTRAST : {}) };
  ui.setTokens({ ...css.tokens, ...current });
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$accent" } },
    widget: { focusRing: { color: "$focus", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "#766445", radius: 4 } } },
    dialog: { background: "#00000000", padding: 0, parts: { backdrop: { background: "#080a12b8" } } },
  });
  ui.setTheme({
    text: current.ink!, muted: current["ink-dim"]!, panel: current.panel!, control: current.panel2!,
    field: current.panel2!, accent: current.accent!, focus: current.focus!,
  });
}
/** A token's current colour (draw calls take real colours). */
export function token(name: string): string { return current[name] ?? "#000000"; }
