# Ole

Ole is a fork of [Yogurt](https://github.com/FrigadeHQ/yogurt) (MIT, by Frigade) that adds a live call companion for Siesta: a pre-call warm-up from Siesta over MCP, context bullets during the call, and OpenAI as an optional provider for transcription and notes. Yogurt does the hard parts (two-track capture, live transcription, speaker names, notes, library); Ole adds what only Siesta can provide.

Design: `docs/superpowers/specs/2026-11-19-ole-design.md`. Plan: `docs/superpowers/plans/2026-11-19-ole-fork-foundation.md`.

## Install (alpha)

Download the `.dmg` from the pre-releases at https://github.com/coryjett/ole/releases, drag Ole to Applications, open it. Then Settings > Ole: add your OpenAI key and Siesta key, set Transcription and Assistant to OpenAI if you have no local models. Siesta needs the VPN.

New versions download in the background and macOS shows "Ole x is ready"; Settings > Updates has the restart button.

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

## Seams (Yogurt files Ole edits)

- `app/electron-builder.yml`: app id, names, usage strings, publish to `coryjett/ole`
- `app/package.json`: productName, version
- `app/src/shared/i18n.ts`: `t()` brands the message
- `app/src/main/paths.ts`: data folder `Ole`
- `app/src/main/index.ts`: app name and id; Ole keys, providers and session hooks; OpenAI notes model wrapper; transcription options
- `app/src/main/asr/index.ts`: OpenAI transcriber branch in `open()`, model gate in `recorded()`
- `app/src/main/settings.ts`: Ole settings fields
- `app/src/main/trayMenu.ts`: tooltip name
- `app/src/preload/index.ts`, `app/src/shared/types.ts`: `window.yogurt.ole`
- `app/src/renderer/src/screens/Settings.tsx`, `Home.tsx`, `Note.tsx`, `windows/Widget.tsx`: Ole settings, panel and bullets
- `app/src/shared/exportNotes.ts`, `app/resources/about/Credits.html`: credit Yogurt
- `app/native/*/Info.plist`, `app/native/yogurt-mcp/main.swift`: helper ids and paths
- `app/scripts/release-mac.sh`: "Ole Local" signing, Ole.app paths
- Tests updated for the Ole name: tray, widget, update, setup, paths and others under `app/test/`
