# Ole

**A live call companion for Solo SEs.** Ole listens to both sides of a customer call, transcribes it as you talk, and shows short context bullets from [Siesta](https://siesta.fe.solo.io) about what is being said right now: the account's opportunities and POC, linked GitHub issues, what other customers ran into, competitive notes. Every bullet names its source. When the call ends you get a summary, and the meeting stays in your library with its transcript, bullets and notes.

Ole is a fork of [Yogurt](https://github.com/FrigadeHQ/yogurt) by Frigade (MIT). Yogurt does the recording, live transcription, speaker names, notes and library; Ole adds Siesta and OpenAI.

> **Alpha.** Mac only (Apple Silicon). Expect rough edges.

## What it does

- **Prepares before the call.** Click *Prepare for next call* on Home: Ole finds your next meeting in Siesta, matches it to an account, and loads its context (account, opportunities, POC tracker, open issues and feature requests, recent call briefs, action items, competitors). You can switch the account or continue without one; not every call has an account yet.
- **Context bullets during the call.** Every ~20 seconds of new conversation, Ole checks the transcript against that context and adds up to three bullets, newest first, each with its source. When it needs more (how another customer handled the same problem), it searches Siesta's calls, a few times a minute at most. Other customers' names are anonymised.
- **Who said what.** Speaker names from Zoom, Teams and Meet (Yogurt's feature).
- **Summary at the end.** Discussion, decisions, next steps and open questions, written from the transcript and your typed notes.
- **Library.** Folders, search, copy and Markdown export (Yogurt's).
- **Your choice of models.** Transcription and the notes model can each run locally (Yogurt's whisper.cpp and llama.cpp models) or on OpenAI with your own key.

## Install

1. Download `Ole-mac-arm64.dmg` from the latest pre-release on the [Releases page](https://github.com/coryjett/ole/releases).
2. Drag Ole to Applications.
3. The alpha is not notarized by Apple, so the first open is blocked: open **System Settings > Privacy & Security** and click **Open Anyway** next to Ole (or right-click Ole > Open).
4. Grant the microphone, call audio and Accessibility permissions when asked (Accessibility is how Ole reads speaker names from Zoom and Teams).

## Set up

In **Settings > Ole**:

- **Siesta key:** create one in Siesta (Settings > API Keys). Siesta is reached over the Solo VPN, so warm-up and lookups need the VPN on.
- **OpenAI key:** a platform API key from platform.openai.com. Needed for bullets, and for OpenAI transcription or summaries.
- **Transcription** and **Assistant:** *Local* or *OpenAI*. Pick OpenAI for both if you don't want to download local models. The model names can be changed there too.

Keys are encrypted with the macOS Keychain and never shown again in full.

## Updates

Ole checks this repo's releases every few hours and downloads new versions in the background. macOS tells you when one is ready, and **Settings > Updates** has the button to restart into it. Updates never install while you are recording.

## Privacy

- Meetings, transcripts, notes and bullets are stored on your Mac in `~/Library/Application Support/Ole`.
- With **OpenAI** picked, call audio and transcript text are sent to OpenAI on your key. With **Local**, they stay on your Mac.
- Ole sends Siesta the meeting and account it prepares for, and short search phrases taken from the conversation when it looks for other customers' experience. It only reads from Siesta; it never writes.
- Ole does not join the call, so nobody is told automatically that you are recording. Tell them.

## Build from source

Needs Xcode Command Line Tools, cmake, Node and pnpm 10.7.

```bash
npx -y pnpm@10.7.0 install
cd app
npx -y pnpm@10.7.0 typecheck && npx -y pnpm@10.7.0 exec vitest run
npx -y pnpm@10.7.0 dev        # run from source
```

Releasing, the fork rules and how upstream Yogurt changes are merged in: [OLE.md](OLE.md). Yogurt's own build notes: [docs/building.md](docs/building.md).

## License

[MIT](LICENSE). Copyright 2026 Frigade (Yogurt); Ole changes copyright 2026 Cory Jett.
