// The game's strings (assets/strings.json, generated from the browser build's
// tables, the nine StarHermit locales) on the engine's strings, which follow the
// interface language the runtime reports (Options › Language, else the account's
// or the device's) and own the locale fallback and the account lines
// (`starhermit.*`). This replaces sh-language.js and the DOM relabelling: screens
// are drawn through t() every frame, so a change shows on the next frame without
// restarting the level.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { createLang } from "../src/lang.js";
import type { Challenge, Level } from "./game.ts";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export type Vars = Record<string, string | number>;
export const t = (key: string, vars?: Vars): string => strings.t(key, vars);
/** The engine's account strings (signIn, invite, inviteCopied, inviteLink, signedOut, leaderboard…). */
export const pt = (key: string, vars?: Vars): string => strings.t(`starhermit.${key}`, vars);

interface LangApi {
  levelName(l: Level | null): string; lessonText(l: Level): { name: string; text: string };
  challengeText(c: Challenge): { name: string; desc: string }; playerName(n: string): string;
}
/** The content's names in the player's language. */
export const L = (createLang as unknown as (tr: typeof t) => LangApi)(t);
