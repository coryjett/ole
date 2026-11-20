# Changes to Yogurt's own code

A running ledger of every change Ole makes to Yogurt-owned files: anything outside `app/src/main/ole/`, `app/src/renderer/src/ole/` and `app/test/ole/`. It has two purposes:

- **Upstream candidates**: general fixes or features Yogurt would likely want. Each can become a PR to [FrigadeHQ/yogurt](https://github.com/FrigadeHQ/yogurt), which also removes a conflict point from future upstream merges.
- **Ole-only changes**: hooks and branding that exist only because Ole is built on Yogurt. They stay in the fork and are where upstream merges can conflict.

**Rule:** a PR that touches a Yogurt-owned file adds or updates its entry here in the same PR. The baseline is the last upstream merge (Yogurt `b9a03dd`, Ole #69); `git diff b9a03dd origin/main -- app/src ':!app/src/main/ole' ':!app/src/renderer/src/ole'` lists the current changes.

## Upstream candidates

| Change | Ole issue / PR | Yogurt files | Pitch for upstream | State |
|---|---|---|---|---|
| Name the speaker when the call has exactly one other attendee and the call app doesn't say who is talking; stay "Them" with two or more | #129 | `main/callNames/attribute.ts`, `main/callNames/index.ts` | Better names in 1:1 calls where the call app hides the active speaker | Not submitted. Tidy first: the new `onlyOther` function sits between `nameFor`'s doc comment and `nameFor`, so the comment now labels the wrong function; add a test for the one-attendee case if it isn't already covered upstream |
| People seen in the call join the meeting's attendees while it runs (every `LIVE_ATTENDEES_MS`, 10 s), not only after it stops; the after-the-call pass shares the same `addSeen` | #164 | `main/callNames/index.ts` | The note's attendees fill in during the call | Not submitted |
| Read the AM/PM marker the way it appears in a written time (6:00 and 18:00 with minutes) instead of midnight and noon with hour12 forced | #129 | `shared/audioUpload.ts` | Fixes time parsing in uploads for locales whose marker differs in a full time (e.g. Thai "น.") | Not submitted. Needs a test showing the locale it fixes |
| Keep checking for updates after one is ready, so a newer release replaces the waiting one; check on wake from sleep; never hide the ready state on a later check, "no update" or an error | #101 | `main/updates.ts` | A downloaded update that's been superseded is installed today; a Mac that slept misses releases | Not submitted. Leave out the Ole-only part (15-minute checks for pre-release builds) or offer it as an option |
| During a recording, the update popover's second button reads "After the call" and keeps the pill instead of hiding the version for the session | #105 | `renderer/src/components/UpdateReady.tsx`, `shared/locales/*.json` (32 translations) | "Later" during a call currently hides the update until Settings | Not submitted |
| Make the "Update ready" pill stand out (filled accent pill with a dot, reduced-motion safe) | #101 | `renderer/src/components/UpdateReady.tsx`, `renderer/src/styles.css` | The grey label is easy to miss | Not submitted; a design call for upstream |
| Spelling to American English in comments and messages | #129 | `main/store.ts`, `main/permissions.ts`, `main/tray.ts`, `main/trayMenu.ts`, `main/windowChrome.ts`, `renderer/src/App.tsx`, `shared/onboarding.ts`, `shared/transcriptFind.ts`, `main/callNames/parse.ts` | Consistency only | Probably not worth submitting: it touches many files for no behavior change. Consider reverting these comment-only edits to cut merge conflicts |

## Ole-only changes

| Change | Ole issue / PR | Yogurt files |
|---|---|---|
| CI split into a required `unit` job (install, typecheck, unit tests on macOS, Linux and Windows) and informational end-to-end jobs (`e2e-mac`, `e2e-other`, `continue-on-error`) until the end-to-end specs are brought up to date for Ole; `main` requires the three `unit` checks | #180 | `.github/workflows/ci.yml` |
| Ole's IPC, settings fields and live-state types | many (#33, #52, #89, #101, #118/#122, #126, #128, …) | `preload/index.ts`, `shared/types.ts`, `main/settings.ts` |
| Wiring Ole into the app: session, providers, servers, keys, per-meeting files, notes, calendar, capture protection | many | `main/index.ts` |
| The Agenda and Yogurt's other calendar reads fall back to the meetings server's list when the Mac calendar has no access or no calendars (`readCalendar` through `ole/yogurt/serverCalendar.ts`; `calendar:day`/`calendar:coming-up` report `granted` then; `calendar:list` names the server); Settings > Calendars notes it | #149 | `main/index.ts`, `shared/types.ts`, `renderer/src/components/CalendarSettings.tsx` |
| A title written from the notes goes through an optional `generatedTitle` hook before it is saved, so Ole puts the call's matched organization in front (`hookNotes`'s queued title job, the only place a generated title is written); `index.ts` passes the Ole session's `generatedTitle` | #154 | `main/notes/index.ts`, `main/index.ts` |
| The notes writer takes an optional `extraNotes` hook: text given to the writer after the person's own notes and never saved into them; `index.ts` passes the Ole session's `notesInput` (pinned bullets and Ole's record of the call), which used to be appended to My notes | #168 | `main/notes/index.ts`, `main/index.ts` |
| OpenAI transcription (chunked and streaming) behind the Transcribe seam | #85, #89 | `main/asr/index.ts` |
| Ole tabs, quick-note bar and docked Ask on the note page; after a call no Ole tabs, and Ole's sources under the Summary (#170); the Ask column beside the tab panels on a wide note, and the width measurement it needs | #108, #122, #148, #170 | `renderer/src/screens/Note.tsx` |
| Ask button hands over to Ole's docked Ask during a call (one line) | #122 | `renderer/src/components/Chat.tsx` |
| Ole panel on Home | #35 | `renderer/src/screens/Home.tsx` |
| Ole settings section | #10 and later | `renderer/src/screens/Settings.tsx` |
| Onboarding steps for the OpenAI key and MCP servers | #18 | `renderer/src/screens/Onboarding.tsx` |
| Live bullets in the floating widget (only the act ones since #172); widget links open in the browser | #42, #172 | `renderer/src/windows/Widget.tsx`, `main/widget.ts` |
| Branding: product name (shown as ¡ole! since #162; the internal app name stays Ole so saved keys and logs don't move, and the menu bar uses the shown name), logo, app id, data folder, export credit, permission prompts | brand, #162 | `main/appMenu.ts`, `main/index.ts`, `electron-builder.yml`, `build/wordmark.svg`, `shared/brand.ts`, `shared/i18n.ts`, `shared/logo.ts`, `renderer/src/components/Logo.tsx`, `renderer/index.html`, `renderer/src/assets/ole-mark.png`, `main/paths.ts`, `shared/exportNotes.ts`, `resources/tray*.png` |
| Releases from Ole's own feed with the "Ole Local" certificate | release | `scripts/release-mac.sh` (plus Ole's own `ole-release.sh`, `release-check.mjs`, `ole-update-check.sh`) |
| 15-minute update checks for pre-release builds | #101 | `main/updates.ts` |
