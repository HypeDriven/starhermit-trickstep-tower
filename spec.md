# Trickstep Tower — specification

A solo precision platformer: guide a wind-up climber up a clockwork tower to each floor's exit door,
learning deterministic traps (trick steps, vanishing platforms, spikes, springs, moving platforms)
through instant retries. It is a StarHermit engine script game (engine 1.23.0, host API 1.23,
`engine.minor=23`), played natively by the StarHermit client and in browsers by the engine's web
runtime from one package.

## Rules
- `src/rules.js` (unchanged from the browser build): a 20 Hz fixed step (`TICK_MS` 50), gravity,
  walking at 6 tiles/s, a jump only from the ground (a mid-air jump is an invalid action, −5),
  deaths on spikes and falls respawn at the last checkpoint (−40 each), gears +150, completion 1000
  plus time and move bonuses. Vanish platforms and movers follow seeded cycles; trick steps (`~`)
  look solid and are never solid, shimmering once touched. Move and time limits end a run.
- The client runs one rules step every third 60 Hz fixed step; jumps are edge-triggered (one press,
  one jump); Practice keeps an undo stack (U steps back two seconds).

## Content and modes (`src/content.js`, unchanged)
- **Learn**: five lessons (walk, jump, gears, vanishing steps, trick steps); Next → plays the next.
- **Journey**: 40 generated stages, mastery every eighth; clearing a stage unlocks the next.
- **Daily**: one stage per UTC day from the platform clock (`serverNow`, the device clock offline).
- **Practice**: any stage, Relaxed / Standard / Strict (a move limit of 1.2 × par); unranked, undo.
- **Challenge**: four constrained stages (move or time limits).
- **Score Chase**: the leaderboards.
Journey, Daily and Challenge are ranked.

## Screens
Title (Play, Daily, Journey n/40, Settings, Help & Rules, Profile, Sign in / Invite, Resume paused
run), Choose a Mode (six cards; compact on phone portrait and short landscape), Learn, Journey grid,
Practice, Challenges, Score Chase (Daily / Journey / Challenge tabs), Settings, Profile (guest name,
sync line, stats, achievements), Help (nine rule cards with the current key bindings), Pause
(Resume, Retry, Settings, Help, Leave level), Results (score breakdown, reason, achievements, the
leaderboard line, Next / Retry, Replay, Scores, Leave). Escape on a screen takes its Back route.
The HUD shows the objective and lesson, score / gears / deaths / time and any limit in reserved
widths, the cloud-sync line, Pause and (Practice) Undo; groups wrap to the window and stack on
phone portrait. A 3-2-1-GO countdown starts each run; captions (♪ …) follow sound events.

## Controls
- Keys: ←/A, →/D walk; Space/↑/W jump; Esc/P pause; R retry; U undo (Practice); C reset camera.
- Gamepad: left stick / D-pad walk, South jump, Start pause, West retry, North undo, right stick
  press camera (the browser build had only walk, jump and pause on the pad).
- Touch: the runtime's on-screen ◀ ▶ and JUMP buttons during play, mirrored by the
  left-handed option. Screens take taps and clicks. All keys and pads are rebindable in Options.

## Settings
The runtime's Options own volumes and mute, graphics level and frame rate, language (nine locales),
larger text, high contrast and reduced motion. The game's own (engine `settings`, synced): the
colour-vision palette (Default, Deuteranopia, Protanopia, Tritanopia, Monochrome — UI accents),
left-handed touch controls and haptics (`vibrate` on deaths and gears).

## Graphics (`native/render.ts`, `native/quality.ts`)
The browser build's three.js r185 scene on `starhermit:scene`: brick tower wall, background gears
and columns, clock face, glowing windows, light shafts, instanced stone/brass blocks (rounded and
textured when detailed), the climber with its marker ring, sparks and dust motes, a damped follow
camera with shake. Low / Balanced / High / Ultra follow the runtime's quality tier with gfx.js's
presets and budgets (Lambert → Standard → clear-coat Physical, texture sizes, segments, particle
budgets; shadows 0/1024/2048/4096; GTAO on High/Ultra; bloom 0.45/0.45/0.9; a display-space grade
and vignette; FXAA / SMAA / MSAA). Minor 23 is r185 parity: the page's own light intensities,
shadow camera, bias and normal bias; RoomEnvironment (r183+ room, y −3.5) at
`environmentIntensity` 0.3 as the page set it.

## Sound (`native/audio.ts`)
Authored one-shots in `sfx/`, the clockwork ambience and the arpeggio rendered once into clips; the
ambience plays on the music bus. A pause silences everything.

## Saves and platform (`src/save.js`, `native/platform.ts`)
The engine save (device + cloud) holds progress (stars, best dailies, achievements, streak, clears),
the paused-run snapshot, the guest name and the local casual boards. Two devices merge on conflict.
The browser build's cloud slot (`game:<slug>`) is merged once as a foreign save; its settings KV
gives the palette, left-handed and haptics options, then its keys are removed.
Won ranked runs go on the local board and, signed in, post their total to the `high-score` board
through `score-script.js` (range-checked client total — the solo-score policy), with the rank shown.
Score Chase shows the StarHermit board when signed in, else the local board for the tab.

## Checks
- `npm run test:unit`: rules, dev server, i18n (every key in nine locales), save model, and
  `plays.test.mjs` (each scripted level is won at every phase of the script's jump rhythm).
- `npm run test:native` (`tests/native.mjs`): web index, tsc, `starhermit check` with no warnings,
  and render-check play scripts: the five lessons by keys (desktop), Journey 1–2 on a DPR-3 phone
  with the Score Chase board, the menus/practice/pause/resume/daily in short landscape.
- `npm run test:browser` (`tools/browser-play.mjs`): the packaged game in GPU Chrome — desktop
  stage 1 by keys, phone stage 1 on the touch controls, landscape menus and a practice run.
- `npm run package` regenerates `index.html` + `starhermit-files.json`; `npm run css` the styles.

## Known limitations
- Guests' old browser localStorage progress does not migrate (cloud saves do).
- The browser build played synthesized stand-ins while a sample loaded; here a loading clip is silent.
  As before, there is no jump sound (the rules emit no jump event).
- The old Graphics panel's per-category overrides and render-scale slider are replaced by Options.
- Help or Settings opened from Pause return to Pause (the old Help returned to the title).
- The Score Chase subtitle texts are the browser build's ("replay-validated…"); scores are
  range-checked only, as before.
