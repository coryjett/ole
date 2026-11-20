# Ole

Ole is a fork of [Yogurt](https://github.com/FrigadeHQ/yogurt) (MIT, by Frigade) that adds a live call companion: a pre-call warm-up from an MCP server, context bullets during the call, and OpenAI as an optional provider for transcription and notes. Yogurt does the hard parts (two-track capture, live transcription, speaker names, notes, library); Ole adds the context from your MCP server and OpenAI.

Design: `docs/superpowers/specs/2026-11-19-ole-design.md`. Plan: `docs/superpowers/plans/2026-11-19-ole-fork-foundation.md`.

## Install (alpha)

Download the `.dmg` from the pre-releases at https://github.com/coryjett/ole/releases, drag Ole to Applications, open it. Then Settings > Ole: add your OpenAI key and the MCP server URL and key, set Transcription and Assistant to OpenAI if you have no local models.

New versions download in the background and macOS shows "Ole x is ready"; Settings > Updates has the restart button.

## Lower-latency OpenAI transcription

With Transcription on OpenAI, a live call streams each track over the Realtime API (`gpt-live-transcribe`, `app/src/main/ole/openaiStream.ts`, #85), so a line lands once the pause that ends it is heard (no upload and full re-read after it) and quick readings show while people talk; any chunk the stream can't give, and the rest of the recording after an auth, model or repeated connection error, goes through the chunked `/audio/transcriptions` path instead. Settings > Ole > Live streaming turns it off.

## Fork rules

- Tracking fork: Yogurt is the `upstream` remote. Never rewrite its history.
- Ole code lives in `app/src/main/ole/`, `app/src/renderer/src/ole/`, `app/test/ole/`.
- Yogurt files change only at small seams (listed below). Internal names stay Yogurt's (`window.yogurt`, `YOGURT_*`, `yogurt.db`, `native/yogurt-*`) so merges stay cheap.
- User-visible text goes through `shared/brand.ts`: `t()` shows "Yogurt" as "Ole" in messages, never in values filled into them.

## Merging upstream

```bash
git fetch upstream && git merge upstream/main
npx -y pnpm@10.7.0 install
cd app && npx -y pnpm@10.7.0 typecheck && npx -y pnpm@10.7.0 exec vitest run
```

Expect conflicts only at the seams. `app/package.json` `version` is Ole's own (keep ours).

## Releasing

1. Bump `version` in `app/package.json` (a pre-release like `0.1.0-alpha.2` publishes as a GitHub pre-release).
2. `sh app/scripts/ole-release.sh` builds, signs with the "Ole Local" certificate, and publishes to `coryjett/ole`.

Updates install only when the new build is signed by the same certificate as the installed one, so keep the "Ole Local" identity (login keychain) safe. Losing it means everyone reinstalls by hand.

## Releases and updates

`sh app/scripts/ole-release.sh` is the only way to publish. It refuses a version that isn't above the newest release, creates the release as a **draft**, downloads it again and verifies it (checksums against `latest-mac.yml`, signed by the "Ole Local" certificate, update feed `coryjett/ole`, version), and only then publishes. A draft that fails is deleted, so a half-made release is never public.

`sh app/scripts/ole-update-check.sh` checks what installed copies see right now (add `--full` to download and verify the newest release too). Run it after any change on the Releases page.

**A bad release:** never delete or edit the newest release; installed copies would have nothing valid to update to. Fix forward: bump the version and release again. Copies that took the bad one update to the fix on their next check.

### The signing certificate

Installed copies only accept an update signed by the same certificate as the one they run. It lives in the login keychain as **"Ole Local"** (SHA-1 `67687C2215D46786F3C86CB788FAFE925F1480B2`). **If it's lost, no installed copy can update again: everyone reinstalls by hand.** Back it up, with its private key, somewhere safe and offline: in **Keychain Access › login › My Certificates**, right-click **Ole Local › Export "Ole Local"…**, save as `.p12` with a passphrase. Keep the file and the passphrase apart, and never commit them.

Restore on another Mac with `security import ole-local-signing.p12 -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign`, then trust it for code signing (Keychain Access › the certificate › Trust › Code Signing: Always Trust).

## Measuring live bullets (replay)

Change a bullets prompt or filter, then replay saved calls to see whether the bullets got better or worse (#66). Dev only: `app/src/main/ole/replay.ts` and `app/scripts/ole-replay.mjs` are never imported by the app (a test pins that).

```bash
cd app
node scripts/ole-replay.mjs test/ole/fixtures/replay/*.json          # a short summary per call
node scripts/ole-replay.mjs --json test/ole/fixtures/replay/steady-call.json   # the full report
OLE_REPLAY_API_KEY=... node scripts/ole-replay.mjs --live my-call.json  # a real model instead of the recorded replies
```

A fixture holds the transcript lines (`speaker`, `text`, `startMs`), the briefing, the tools offered, and per turn the model's recorded replies (`bullets` or raw `content`, `toolCalls` with their `result`, `error`, `latencyMs`). The engine runs on a virtual clock at the call's own pace, so a replay is instant and deterministic and needs no network or keys. `--live` sends the fixture's transcript and briefing to the model (it says where on stderr) and reads only `OLE_REPLAY_API_KEY` (required), `OLE_REPLAY_BASE_URL` (https only) and `OLE_REPLAY_MODEL`; lookups still answer from the fixture. As in the app, only lookup-style tools are offered, and none that fetch a single record on a call with no matching record (#57). A fixture's `settings` may set only `minIntervalMs`, `fastMinMs` (0 turns fast turns off), `windowMs` and `maxLookupsPerMinute` (clamped), a failed turn is reported only as its kind (`http 429`, `timeout`, `network`, `parse` or `error`), never its text, and the live key is scrubbed from anything printed.

The report counts turns (failed, unrecorded ones that answered empty, and fast ones: a question or a new term from the other side brought them forward to 10 s after the last turn, as in the app, #79), bullets back, shown, without a source and repeated, excerpts given against verified (heard, quote) and links kept, headline word and length stats, the longest stretch with nothing new shown, and lookups asked, made and refused, plus a per-turn timeline and every bullet shown. Recorded replies are matched to turns by order, so a change to the throttle shifts them: compare such a change with `--live`. Bullets stream in the app (#84); a recorded reply is a whole message, so it is handed to the engine as one streamed piece, and a streamed reply gives the same report as a whole one (a test pins that). `--live` streams too. Fixtures are synthetic: no real call content, no real company names, `example.com` links only.

### Replaying a real call

During a call Ole keeps each bullets turn with the meeting, on this Mac only: `meetings/<id>/ole-turns.json` beside the bullets and the briefing (the model's replies, the lookups it asked for and their results, how long each reply took; at most 300 turns, results cut like a live lookup). It is never logged and never sent anywhere (#70).

To replay one: open the saved meeting, and in its Ole section click **Export for replay**. Ole writes a fixture in the format above (transcript, briefing, tools offered, recorded turns) to a file you pick, `ole-replay-<date>.json` by default. Then:

```bash
cd app
node scripts/ole-replay.mjs ~/Documents/ole-replay-2026-11-20.json
```

**Anonymise** (on by default) makes the file safe to share:

- Speakers and calendar attendees become `Speaker 1`, `Speaker 2`… in order of first appearance. Their full names are replaced anywhere in the file (any case), and each part of a name of 3+ letters too (with its capital, as a whole word), so "Thanks, Sam" loses the first name. `Me` and `Them` stay.
- The meeting title, and the account in it (the part before `:`, `|`, `<>`, ` - `, ` x ` or `//`, as in "Acme: security review"), become `Account`. A default title ("Meeting", "Zoom call") is left alone. An account named only in the briefing, never in the title, is not found.
- Every link becomes `https://example.com/link-N` (the same link, the same N) and every email address `[email]`.
- The same replacements run over the transcript, the briefing, the model's replies and the lookups' arguments and results, so the replay still verifies the same excerpts and links.

Anonymising is a best effort from the names Ole has: read the file before you share it. A call recorded before turns were kept exports the transcript and briefing with no turns (and the tools the servers offer now), so replay it with `--live`. The transcript is the saved one, which can differ from what the engine heard live if the call was transcribed again.

Exported files hold real call content: keep them out of the repo. `ole-replay-*.json` is in `.gitignore`; never add one under `test/ole/fixtures/`.

## Seams (Yogurt files Ole edits)

- `app/electron-builder.yml`: app id, names, usage strings, publish to `coryjett/ole`
- `app/package.json`: productName, version
- `app/src/shared/i18n.ts`: `t()` brands the message
- `app/src/main/paths.ts`: data folder `Ole`
- `app/src/main/index.ts`: app name and id; Ole keys, providers and session hooks; OpenAI notes model wrapper; transcription options
- `app/src/main/asr/index.ts`: OpenAI transcriber branch in `open()`, model gate in `recorded()`; the live recording's audio also goes to the OpenAI stream (`stream.push` before the pipeline's, `flush`/`close` in `finishSession`)
- `app/src/main/settings.ts`: Ole settings fields
- `app/src/main/trayMenu.ts`: tooltip name
- `app/src/preload/index.ts`, `app/src/shared/types.ts`: `window.yogurt.ole`
- `app/src/renderer/src/screens/Settings.tsx`, `Home.tsx`, `Note.tsx`, `windows/Widget.tsx`: Ole settings, panel and bullets
- `app/src/shared/exportNotes.ts`, `app/resources/about/Credits.html`: credit Yogurt
- `app/native/*/Info.plist`, `app/native/yogurt-mcp/main.swift`: helper ids and paths
- `app/scripts/release-mac.sh`: "Ole Local" signing, Ole.app paths
- Tests updated for the Ole name: tray, widget, update, setup, paths and others under `app/test/`
