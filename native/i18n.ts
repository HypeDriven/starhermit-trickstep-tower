// The game's strings (src/strings.js, the nine StarHermit locales) in the
// interface language the runtime reports (preferences().language: Options ›
// Language, else the account's or the device's). This replaces sh-language.js
// and the DOM relabelling: screens are drawn through t() every frame, so a
// change shows on the next frame without restarting the level.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { L } from "./game.ts";

let locale = "";
function apply(tag: string): void {
  const next = L.setLang(String(tag || "en-US"));
  if (next === locale) return;
  locale = next;
  ui.setLanguage(locale);
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));

export type Vars = Record<string, string | number>;
export const t = (key: string, vars?: Vars): string => L.t(key, vars);
export const pt = (key: string, vars?: Vars): string => L.pt(key, vars);
