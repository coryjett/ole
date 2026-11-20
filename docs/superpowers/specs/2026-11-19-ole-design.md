# Ole: live call companion for Siesta

## Intent and why

Ole helps an SE during a customer call. It listens to both sides of the call (Zoom, Teams, Meet, anything playing on the Mac), transcribes it live, and shows short, scannable bullets of context relevant to what is being said right now. The context comes from Siesta, so a bullet can reach beyond this call: the matching GitHub issue and its status, other accounts that hit the same problem, competitive notes, this account's opportunities and POC. Every bullet names its source (account, issue number, call title) so it can be trusted or looked up. It is context, not speaking-style coaching.

Ole is a maintained fork of Yogurt (github.com/FrigadeHQ/yogurt, MIT). Yogurt already does the hard parts: capturing the microphone and the call audio as separate tracks, live transcription, speaker names from Zoom, Teams and Meet, post-call summaries, typed notes, and a meeting library. Ole adds what only Siesta can provide, plus OpenAI as a model option.

## Users

Cory first, on his MacBook. Built so other SEs could install it later.

## Goals

- Before a customer call, prepare that account's context from Siesta so the call starts with everything loaded.
- During the call, surface scannable context bullets with sources, without the user asking.
- Ask Siesta for more only when the prepared context cannot answer.
- After the call, show a summary immediately and keep the summary, transcript, bullets and typed notes in a library like Zoom My Notes.
- Name who is speaking on the other side for Zoom and Teams calls (Yogurt's existing feature).

## Non-goals (v1)

- Providers other than OpenAI and Yogurt's own local models.
- Windows and Linux. Yogurt builds for them, but v1 is tested on macOS only.
- Writing anything into Siesta (notes, action items). v1 only reads.
- Team sharing, sync, or automatic upload anywhere.

## Anti-goals

- Recording without the user's click. Yogurt offers to record when a call starts; the user confirms.
- Keys in plain files.
- A wall of text in the panel. Bullets only, newest on top.
- Slowing the call: the panel stays responsive when Siesta or OpenAI is slow.
- Invented facts: every bullet cites a source from the transcript or Siesta; with no source, Ole says nothing.

## Experience

### Before the call (warm-up)

When the user clicks Prepare, or about 5 minutes before the next matched meeting (Claude's call), Ole calls the Siesta MCP server once and keeps the results: account details, opportunities and their health, POC tracker, open GitHub issues and feature requests for the account, recent call briefs, open action items, competitors. Ole picks the account from Siesta's `get_upcoming_meetings`, which already matches calendar meetings to accounts, and shows "Prepared for: <meeting>, <account>" with a switcher to change it (Claude's call).

### Calls with no account

Not every call has a Siesta account: a first discovery call, a prospect not yet in Salesforce, a partner or internal call.

- Warm-up with no match shows "No account for: <meeting title>" with two choices: pick an account (if Siesta's match is wrong or the company is in Salesforce under another name), or continue without one. It never blocks recording.
- Without an account, bullets still come from Siesta knowledge that is not tied to one account: other accounts that raised the same problem (`search_calls`), competitive notes when a competitor is named, and product, feature and issue context.
- If the conversation names a company that is in Siesta, Ole offers it ("Sounds like this is <account>. Link it?"); one click loads that account's context. Ole never switches on its own.
- The meeting is saved as "No account" and can be linked to an account later.

### During the call

Yogurt's floating window holds two sections: Ole's context bullets on top (newest first, each with its source), and the user's typed notes below. The model checks the recent transcript against the prepared context first. It calls Siesta live only for gaps, such as another account's experience (`search_calls`) or a competitor it has no notes on, throttled to a few calls a minute and never the same question twice in one call. A visible recording indicator and a reminder to tell participants they are being recorded stay as Yogurt has them (no bot joins, so nobody is notified automatically).

### After the call

The summary is generated when recording stops and shown straight away: what was discussed, decisions, next steps, open questions. The user's typed notes feed it.

### Library

Yogurt's library, extended. Each meeting keeps the summary, the transcript with speaker names, the bullets surfaced during the call, the typed notes, and the account it was prepared for. Search, folders and export to Markdown are Yogurt's. Meetings stay until the user deletes them; no automatic deletion in v1 (Claude's call).

### Settings

- Siesta key, and OpenAI API key, stored with Electron `safeStorage` (backed by the macOS Keychain).
- Two selectors: Transcription (Yogurt's local models, OpenAI) and Assistant model (Yogurt's local models, OpenAI). Anthropic and Vertex are designed in behind a provider interface and come later; they are separate selectors because Anthropic has no speech-to-text.
- Auto-prepare toggle.

## How it works

### Where Ole plugs into Yogurt

Yogurt is Electron 44 and TypeScript, with Swift and Rust native helpers. The builder confirms each seam before changing it:

- `asr/`: transcription (whisper.cpp and Apple SpeechAnalyzer today). Ole adds OpenAI streaming transcription.
- `engine.ts`, `notes/`, `prompts.ts`: the local model (node-llama-cpp), summaries and prompts. Ole adds an OpenAI assistant behind a provider interface.
- `chat.ts`: Ask. Ole lets it call Siesta tools too.
- `float.ts`: the floating window. Ole adds the bullets section.
- `people.ts`: speaker names, used as is.
- `calendar.ts`: Yogurt's ICS calendar. Ole's warm-up uses Siesta's meeting match instead.
- `updates.ts`: auto-update (electron-updater). Must be repointed or turned off first (see Fork rules).

### Siesta via MCP

Endpoint `https://siesta.fe.solo.io/mcp` (Streamable HTTP), `Authorization: Bearer <Siesta key>`. Siesta's internal routes sit behind a VPN gate, so Ole reaches Siesta only on the VPN. v1 only reads.

### Transcription and assistant (v1: OpenAI)

OpenAI streaming transcription for both tracks, and a fast OpenAI chat model with tool calling for bullets, Ask and summaries, on the user's own API key. Exact model names and prices are confirmed at build time.

### Audio

Capture only the call app's audio, not everything the Mac plays (Claude's call). Yogurt's capture helper is the starting point; the builder confirms what it captures today.

### Storage

Yogurt's local data folder, renamed for Ole. Yogurt does not encrypt its store today; v1 keeps it as is, and encryption at rest is an open item unless the builder finds it cheap.

## Fork rules

Ole is a tracking fork (decided by Cory): it keeps pulling Yogurt's updates rather than making a clean break, because the fragile parts (Zoom and Teams speaker detection, macOS permissions, transcription) are Yogurt's and keep being fixed upstream. Branding goes through build config and one constants file where possible, Ole's code lives in its own folders, and Yogurt's files change only at a few small seams, so most merges are clean.

- Keep Yogurt's LICENSE and copyright notice; credit Yogurt in the README and About screen.
- Rename everything user-visible: app name, bundle ID, icon and logo, data folder, tray text. MIT covers the code, not the Yogurt name or logo.
- Repoint or disable auto-update before anything else, so Ole can never update itself into Yogurt.
- Keep Ole's additions in their own modules and keep edits to Yogurt's files small, so upstream merges stay easy.
- Keep Yogurt as an `upstream` remote and merge it every week or two.

## Constraints

- Personal project: repo at `~/Documents/Workspace/Other/ole`, local only for now. It reads company data through Siesta, so no customer names in the repo.
- VPN required to reach Siesta.
- Customer audio goes to OpenAI on the user's key.
- v1 runs unsigned on Cory's Mac; signing for anyone else is decided before the first build that goes to someone else.

## Decided by Cory

- Live, scannable context bullets with sources, including other accounts and GitHub issues.
- Prepare account context before the call; call Siesta during the call only when more information is needed.
- Siesta key entered in Settings.
- OpenAI first; a provider selector designed in (Transcription and Assistant model).
- Summary shown at call end; keep summary, transcript, bullets and typed notes in a library like Zoom My Notes.
- Speaker names for Zoom and Teams.
- Fork Yogurt and maintain it as Ole.
- Name Ole; a personal repo in `~/Documents/Workspace/Other/ole`.
- Calls may have no account yet; handle them as in "Calls with no account" (Claude's proposal, accepted).
- Other customers' names are anonymised in bullets ("a large financial services customer"), and the bullets hide while the user is screen sharing if the build can detect it.
- Mid-call Siesta lookups may send search text derived from what the customer said to Siesta (an internal system), throttled.
- GitHub issues in v1 are only those linked to the account's opportunities (`get_open_issues`, `get_opportunity_feature_requests`); a Siesta issue-search tool comes later.
- Customer audio may go to OpenAI on Cory's personal key in v1, for Cory only; anyone else waits on the company's data rules.

## Open for the builder

- Exact OpenAI models, chunk sizes and latency targets; how often bullets refresh.
- The bullets and summary prompts.
- How the bullets and their sources are stored on the meeting record in Yogurt's store.
- Whether encryption at rest is cheap enough for v1.
- How far Yogurt's per-app capture already goes, and the macOS version floor that follows.
