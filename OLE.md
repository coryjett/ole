# Ole

Ole is a fork of [Yogurt](https://github.com/FrigadeHQ/yogurt) (MIT, by Frigade) that adds a live call companion: a pre-call warm-up from an MCP server, context bullets during the call, and OpenAI as an optional provider for transcription and notes. Yogurt does the hard parts (two-track capture, live transcription, speaker names, notes, library); Ole adds the context from your MCP server and OpenAI.

Design: `docs/superpowers/specs/2026-11-19-ole-design.md`. Plan: `docs/superpowers/plans/2026-11-19-ole-fork-foundation.md`.

## Install (alpha)

Download the `.dmg` from the pre-releases at https://github.com/coryjett/ole/releases, drag Ole to Applications, open it. Then Settings > Ole: add your OpenAI key and the MCP server URL and key, set Transcription and Assistant to OpenAI if you have no local models.

New versions download in the background and macOS shows "Ole x is ready"; Settings > Updates has the restart button.

## Lower-latency OpenAI transcription

With Transcription on OpenAI, a live call streams each track over the Realtime API (`gpt-live-transcribe`, `app/src/main/ole/yogurt/openaiStream.ts`, #85), so a line lands once the pause that ends it is heard (no upload and full re-read after it) and quick readings show while people talk; any chunk the stream can't give, and the rest of the recording after an auth, model or repeated connection error, goes through the chunked `/audio/transcriptions` path instead. Settings > Ole > Live streaming turns it off.

The chunked path defaults to `gpt-transcribe` (#89). OpenAI shuts down `whisper-1` and the `gpt-4o-*-transcribe` models on 2027-02-26 (one `gpt-4o-mini-transcribe` snapshot on 2026-12-01); a saved setting that names one reads as `gpt-transcribe`, is saved that way on the next settings write, and Settings > Ole says so once under Transcription model. The table is `core/transcribeModels.ts`. Safety net: OpenAI's docs don't confirm that `gpt-transcribe` accepts `response_format=json` on `/audio/transcriptions`, so when a `gpt-transcribe` chunk is refused with 400 or 404 and the error body says the model or a parameter isn't supported (`error.code` `model_not_found` or `unsupported_*`, or `error.param` `model` or `response_format`; #111), the chunked transcriber (`yogurt/openaiTranscribe.ts`) sends that chunk once more with `gpt-4o-mini-transcribe` (served until 2027-02-26) and uses it for the rest of that recording, logging one line with the status only. The refused body is read and dropped, and the key is read again for the retry. Any other 400 or 404 is reported as before, and a 401, 429 or 5xx never triggers it.

## Fork rules

- Tracking fork: Yogurt is the `upstream` remote. Never rewrite its history.
- Ole code lives in `app/src/main/ole/` (`core/` and `yogurt/`, see Layout and porting), `app/src/renderer/src/ole/`, `app/test/ole/`.
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

Change a bullets prompt or filter, then replay saved calls to see whether the bullets got better or worse (#66). Dev only: `app/src/main/ole/core/replay.ts` and `app/scripts/ole-replay.mjs` are never imported by the app (a test pins that).

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

**Anonymize** (on by default) makes the file safe to share:

- Speakers and calendar attendees become `Speaker 1`, `Speaker 2`… in order of first appearance. Their full names are replaced anywhere in the file (any case), and each part of a name of 3+ letters too (with its capital, as a whole word), so "Thanks, Sam" loses the first name. `Me` and `Them` stay.
- The meeting title, and the account in it (the part before `:`, `|`, `<>`, ` - `, ` x ` or `//`, as in "Acme: security review"), become `Account`. A default title ("Meeting", "Zoom call") is left alone. An account named only in the briefing, never in the title, is not found.
- Every link becomes `https://example.com/link-N` (the same link, the same N) and every email address `[email]`.
- The same replacements run over the transcript, the briefing, the model's replies and the lookups' arguments and results, so the replay still verifies the same excerpts and links.

Anonymizing is a best effort from the names Ole has: read the file before you share it. A call recorded before turns were kept exports the transcript and briefing with no turns (and the tools the servers offer now), so replay it with `--live`. The transcript is the saved one, which can differ from what the engine heard live if the call was transcribed again.

Exported files hold real call content: keep them out of the repo. `ole-replay-*.json` is in `.gitignore`; never add one under `test/ole/fixtures/`.

## Names looked up mid-call (#86)

A name the other side says that the briefing doesn't cover (capitalized words not at a sentence start, never CamelCase, ALLCAPS or anything with a digit) is looked up in the background by `enrich.ts`: once per name, at most 6 a call, one at a time, at least 30 s apart, never started while a bullets turn or a briefing is running, at most 3 lookups and 3 model calls each, with an allowlist of tools: lookup-style ones the server marked `openWorldHint: false`, or, with no hint, ones named like a record lookup with nothing in the name or description suggesting the web or docs. Open-world and unknown tools never get a name. Facts are kept only with a real source and a quote found in the results; they join the briefing as `## Mentioned during the call: <name>` as plain text (links, images, bare URLs and markdown stripped; a link only through a fact's url that is exactly one of the https addresses in that lookup's results, with no username or password, #107), which the bullets, Ask, the panel and the saved briefing all read. Prepare's output never holds that heading (it is taken out of heading form before it is stored), and the no-record exception for these sections comes from the session's own record of what it added, not from the text. Each lookup logs one line with the name's length only: `ole enrich: name of N chars, L lookups, F facts added` (or `nothing found`, or `failed: <kind>`). These lookups are not bullets turns, so they are not kept for Export for replay; an exported briefing already holds the sections, so a replay sees them from the start of the call.

Anonymized sources (`core/anonymize.ts`, #109, #116): a source names an organization only if it is the meeting's own matched record. The prompts for bullets, Ask and mid-call lookups say so, and Ole enforces it before a source is stored or shown: the organizations it can identify (name fields of JSON results, such as `account_name`, `companyName`, `customer`, or the `name` of an object under an `account`/`company`/`organization` key; and `Kind: Name` text such as `account: Example Corp` or `From call records: Example Corp`, in a result or in the source itself) are replaced in the source by a description: by kind and size when the same record gives an industry, segment or headcount ("a large financial services company"), else "another organization". A name from an explicit organization-name field is taken as given, digits and short names included (`3M`), only placeholders such as `none` or `N/A` left out; free text (`Kind: Name`) still has to read as a name. A result cut short is repaired before anything else: trimmed from the end back to the last point where every value is complete, its open brackets closed; only when that fails do regexes read the quoted name fields, including a bare `"name"` straight under an `account`/`company`/`partner`-style key. Matching is any case, whole words, with or without a legal suffix, and an address-style label too. A link is dropped when its address, decoded, names any identified organization that isn't allowed, whether or not the label named one (bullets, Ask and mid-call sections alike). Allowed are only the matched record (`PreparedContext.records`), only on a call that matched a record, compared exactly once case, spacing and legal suffixes are set aside (`Example Corp Inc.` is `Example Corp`; `Example Corp Asia` is not), and a mid-call section may also name the name it was looked up for; another organization's name inside the record's own (`Globex` in `Globex Bank`) is left alone. The record is the account, company or organization name in the server's own meeting match (the field or object beside its `matchedBy`, else at the top of the result), else the identified organization the briefing names most (twice or more, or the only one); either way only a name the briefing itself names. The meeting title and the focus only corroborate: among the organizations the briefing names equally often, the one the title or focus names wins; they never allow a name themselves. Prepare keeps the organizations its results named (`PreparedContext.orgs`, at most 200, those the briefing names first, in memory only), so a bullet sourced from the briefing is covered too. When it found more than it kept (`PreparedContext.orgsTruncated`), the call fails closed: every `Kind: Name` in a source has its name replaced, capitalized or not (up to 5 words, stopping at `; , ( ) [ ] |`), unless it starts with the record's name or is a date. Bullets, answers and sections saved before this are shown as they were. A name said on the call that reads as a product or feature (a known product; straight before a product word such as "gateway", "API" or "plugin", or after a usage verb such as "running" or "upgraded to"; or written in lower case or CamelCase in most places the briefing and the call's lookups have it) is never looked up as a name (`productTerm` in `enrich.ts`).

Links (`core/links.ts`, #42, #102, #107): a bullet, an Ask answer or a mentioned-name fact carries a link only when that exact address is one of the https addresses Ole received (the briefing and the lookups' results, split on whitespace, quotes, angle brackets and parentheses, trailing `.,;:)]` dropped): not a substring or a prefix of one, at most 500 characters, never with a username or password (`https://good.example@evil.example/x` is refused), and never holding `( ) [ ] < >` or quotes, which could break the markdown it is written into (#111). A kept link is still dropped when its address names an organization a source may not name (#116, see Anonymized sources above). A source that is itself an address is labeled from the link actually used (`site › page`); a text source keeps the model's words. Every label, text or address, drops Unicode control and format characters (bidi overrides and isolates, zero-width characters) and is capped at 80 characters (#111); the renderer shows sources through the same functions (`shownSource`), and puts a link in an href only when `new URL(u).protocol` is `https:` (`httpsHref`), in bullets, Ask answers and saved meetings, so a saved meeting from an older version is checked too.

## Zero-typing prepare (#126, #128)

No always-visible Focus field. Before a call, Home shows the next meeting (`OleLiveState.nextMeeting`: the one on now or the soonest in the next 12 hours, from the meeting source's list, read 5 s after start, then with auto-prepare every 2 minutes and after each call) and its briefing's state: **Briefing ready** (a briefing with a matched record, auto-prepared for that event or prepared with its title), **Preparing…**, or **No match yet**. A **Prepare for…** link reveals a name input (empty: prepare for the next call); the prepared briefing has a **Clear** (`ole:prepared:clear`, `handlers.clearPrepared`), and clearing the input clears a briefing prepared with that name. Clear works only before a call: it drops the briefing (with its organizations, record and note), how it came about, the default-title flag, any Prepare still running and any pending auto-pick.

**Which briefing a call starts with (#128).** A briefing from before the call is reused only when it belongs to it: auto-prepared for the same calendar event (the event on now, from the meeting source, has its id, or its title and start, and a call with a real title has that event's title; with no event on now, a call titled like it before it ends), or prepared by hand at most 15 minutes before the call starts (`MANUAL_REUSE_MS`), unless a calendar event is on now whose title doesn't name the briefing's focus (any case, legal suffixes aside, the same name matching as `anonymize.ts`): then the event is prepared instead. Anything else is dropped and the call prepares from its title or the event on now as before; when that matches nothing, the call is unmatched. This replaced the 2-hour reuse rule.

**Who an unmatched call is with (#126, `core/subject.ts`).** While the briefing has no matched record, the session's subject resolver takes names from the other side's lines only, with enrichment's term detection (`nameTerms`) and product filter (`productTerm`), each name once per call, at most 4 names a call (`SUBJECT_LOOKUPS_MAX`), one at a time, waiting while a Prepare runs. Each name is checked with cheap lookups and no model: `meetingSource.meetingContext({ title: null, focus: name, startsAt })` (the call's event start when known) over the servers' `get_meeting_context` tools, then, with no match, one search with the first account-style search tool (`search_`/`find_`/`lookup_`… naming accounts, companies, organizations, customers or clients; the name goes in the first of `query`, `q`, `name`, … its schema declares, and a tool declaring none of them is never called). Only tools allowed to receive names (`mayGetNames`, #91) are used for either; `meetingContext` takes an `allow` filter for this. A name resolves only on a structured positive result (`resultNames`): JSON holding a record whose name field (`name`, `title`, `account_name`, `company`, …) names it, or a server match (`matchedBy` set) that names it; plain text, an empty list, an echoed query and any "no match", "no results", "not found", "no account" or "0 results" never count. A meeting-context match whose record is another organization (a server matching on the time) does not count either. So each name costs at most one meeting-context call per server offering it and one search. One log line per name, never the name: `ole subject: name of N chars, L lookups, resolved via meeting context|search` (or `not found`, `failed: <kind>`). Resolved names are `OleLiveState.subjectCandidates` (in the order heard), shown while the call is unmatched and after a subject was picked. Once the briefing has a matched record no new name is looked up (the gate is absolute, also after Ole's own pick); switching stays possible among the names already resolved.

Choosing one (`ole:subject:choose`, `handlers.chooseSubject(name)`, also the **Someone else…** input) runs Prepare for the live meeting with the name as focus and the call's own title, replacing the briefing (mid-call sections kept). The call's record (`PreparedContext.records`, the anonymity allowlist, #109, #116) comes only from that Prepare's own match, as for any briefing (`recordNames` over the server's meeting-context match): never from the heard or typed name, so a wrong pick, Ole's own or the user's, lets no source name an organization Prepare didn't match. `OleLiveState.subject` then shows "Briefing updated for <name>". If the user hasn't chosen within 60 s of the first resolved name (`SUBJECT_AUTO_PICK_MS`), Ole prepares for that one itself, once a call, never while a Prepare runs (it tries again 2 s later) and never on a matched call; a later choice among the resolved names switches. Decisions are pure (`subjectTerms`, `autoPickDue`) and tested apart from the session. During a call the header has only **Refresh briefing**; the Live tab shows "Ole hasn't matched this call yet. It will pick up who it's with from the conversation.", the chips ("Heard: A · B") and **Someone else…** (behind a link on a matched call).

## One Ask (#118, #122)

During a call Ole has its own Ask panel, docked at the bottom of that meeting's note page (`OleAskPanel` in the renderer's `ole/OleAsk.tsx`, mounted in the note's footer above the quick-note bar). It is on all four tabs (Live, Briefing, Transcript and My notes), because ⌘J works from any tab and the panel it focuses has to be there. One line says what it answers from ("Answers from this call and your servers"), so the route is visible before asking. Above the box are the call's answers, newest nearest the box: only the latest by default, "Show N earlier" for the rest (scrolling at 30% of the window, so the panel never eats the note). Sources go through `SourceName` (https links only). Answers come from the call Ask (`core/ask.ts`: briefing, running summary, the user's notes, earlier questions, the call's lookups, the link and anonymity rules above), go into `state.answers`, are listed on the Live tab and saved with the meeting.

The host's Ask button and ⌘J reach it through one seam: the button's click handler in Yogurt's `components/Chat.tsx` (⌘J clicks that button on a note page) calls `oleAskTakesOver(meetingId)` (`ole/oleAskDock.ts`) first, which focuses the docked panel and returns true when one is registered for that meeting. A panel registers only while this note's call is live and live context isn't blocked, so with Assistant on Local, no key, on another note, on Home or outside a call the host's Ask opens exactly as before; an already open host Ask still closes on ⌘J. Home's call panel (`LiveView`) shows the same panel undocked (disabled while blocked), so there is one Ask component, not two.

Stop: the panel sends each question with a request id (`ole:ask`, question and id); Stop sends `ole:ask:cancel` with it. The session keeps an `AbortController` per id, passes its signal into `answerQuestion`, which hands it to every chat request and lookup and checks it between rounds, and races the answer against the abort so Stop is immediate even when a request ignores the signal. A stopped question's pending answer is taken out of the list and never saved, including when the call ended while it was answering. A failure is an answer saying `Couldn't answer (<kind>). Try again.` and one log line, `the call Ask failed (<kind>)`, where the kind (`askErrorKind`) is `timeout`, `network`, `http <status>` or `error`: never the message, which can carry a server's reply or the question.

#118 put this inside the host's Ask (an `answerFirst` hook in `library/conversations.ts`, a `conversation_turns.ole_source` column, a source line in `AskConversation.tsx`). #122 took all of that out again; a database that already has the `ole_source` column keeps it, and nothing reads it.

## Meeting-context fast path (#93)

A server can answer the whole "what is this meeting" question in one call. When an enabled server offers a tool whose MCP name is exactly `get_meeting_context` and that passes the read-only filter (`isReadOnly` in `tools.ts`; the `get_` prefix is enough unless the server marks it destructive), `prepareContext` calls it itself before the model's first turn, with no model involved. Arguments, all optional strings: `meeting_title`, `focus`, `starts_at` (ISO 8601). Only values Ole has are sent, and when the tool's input schema declares properties, only those it declares. `starts_at` comes from the meeting list (#98): auto-prepare passes the meeting's start, a default-titled call passes the start of the meeting on now (#56), and a manual Prepare or a named call passes none. Which servers are asked, and in what order, is the meeting source's choice (below): today the servers in Settings order, one at a time, stopping at the first match.

The matched result reaches the model as if it had made the call: one assistant message with a synthetic tool call (id `fast_path_0`) and its tool result, right after the request. A result without a match is not handed over. Each server gets 8 s (passed to the tool runner, whose result cap of 6000 chars applies), plus a 25 s guard over the whole source in `prepareContext`. The call counts toward the 10-call budget, is offered to the model (even past a narrowing server prompt), dedupes a repeat of the same arguments, and adds `, fast path, matched on <server>` to the end of the `ole prepare:` log line. A failure (an `error:` result, a throw or the timeout) logs `ole prepare: get_meeting_context on <server> failed (<reason>), using the tool loop` and the next server is asked; with no match anywhere the loop runs as it would without the tool.

Match signal: a result that is a non-empty JSON object with `matchedBy` set (not null, false or empty) means the server already found the meeting's record. Only such a result is used. Then the request gains the line "The server already matched this meeting (see the first tool result); do not reply that you couldn't match it." and the #62 search-first nudge is skipped, since the search was done server-side. Any other result keeps the nudge. Prepare is not part of replay, so Export for replay is unchanged.

## Meetings from your MCP servers (#98)

`app/src/main/ole/core/meetingSource.ts` is the one place that decides where meetings come from. Prepare, auto-prepare (#52) and the meeting-on-now match (#56) call its interface and never pick a server themselves:

```ts
type MeetingSource = {
  upcomingMeetings(fromMs: number, toMs: number): Promise<Meeting[]>  // [] when nothing can be read
  meetingNow(atMs: number): Promise<Meeting | null>  // the meeting on now, for a default-titled call (#56)
  meetingContext(q: { title: string | null; focus: string | null; startsAt: number | null }): Promise<MeetingContext | null>
}
type Meeting = { id; title; start; end; attendees?; link?; recordId?; note?; source? }   // source: the server's name
type MeetingContext = { tool: OleTool; serverName: string; argsJson: string; result: string }
```

Today's design, `createMeetingSource({ tools, call, calendar, now, log, warn })`: **the order of the servers in Settings is the priority** (Settings > Ole > MCP servers has move up / down; the order is the order of `oleMcpServers`).

- `meetingContext`: `get_meeting_context` on each enabled server offering it, in order (8 s each); the first result with `matchedBy` set wins, and an error, timeout or no-match moves on. No match anywhere: `null`, and Prepare runs its normal tool loop.
- `upcomingMeetings`: the first server, in order, whose read-only `get_upcoming_meetings` succeeds supplies the list (a server that answers with no meetings still counts); with none, the host calendar (`OleHost.calendar`). Arguments: only the window names the tool's schema declares (`days`, `from`/`to`, `start`/`end`, `time_min`/`time_max`), none when it declares none. The result is read tolerantly: a JSON array, or an object holding one under `meetings`, `events`, `items`, `upcoming`, `results` or `data`; title from `title`/`subject`/`name`/`summary`; start and end from `start`/`startTime`/`starts_at` and `end`/`endTime`/`ends_at` (ISO, epoch ms or `{ dateTime }`; no end means 30 minutes); attendee count, an https meeting link, the matched record id and a short note (`aiSummary`, `note`, `brief`, or `summary` when something else gave the title). A server's list is cached for 3 minutes and asked for at least 24 hours ahead, so auto-prepare and the meeting on now share one call.
- `meetingNow`: the meeting on now from the same list; when a server's list has none (a server may leave out meetings already started), the host calendar is checked too. Auto-prepare uses `upcomingMeetings` only.
- A meeting's note goes to Prepare and to the live bullets as one line, `Note about this meeting from <server>: …` (`PreparedContext.note`), cleaned first by `cleanNote`: flattened to one line, markdown links and images reduced to their text, bare URLs dropped, leading `#`, `>`, `-`, `*` removed from each line, `**` dropped, capped at 200 chars.
- The session hands the source its tools (gathered again when older than 10 minutes) and never lets it contact a server while the Assistant is on Local and Prepare is not on this Mac (#11); the host calendar is still read then.

**Replacing it.** Another design (a dedicated meetings server, per-server roles, merged sources) is a new implementation of `MeetingSource` in this file: keep the interface and the types, change `createMeetingSource`. Nothing else picks a server, so Prepare, auto-prepare and the session need no change; `test/ole/meetingSource.test.ts` pins today's choices and is the test to rewrite.

## Layout and porting (#97)

Ole is a host-agnostic core behind a host interface, so it can move to another host app (one that runs on Windows, say) by writing a new adapter instead of rewriting Ole.

- **`app/src/main/ole/core/`**: everything that is Ole. The MCP client and tools (`mcp.ts`, `tools.ts`, `serverTest.ts`), Prepare (`prepare.ts`), where meetings come from (`meetingSource.ts`), live bullets (`bullets.ts`, `bulletStream.ts`), Ask (`ask.ts`), call memory and summary (`callSummary.ts`), mid-call enrichment (`enrich.ts`), who an unmatched call is with (`subject.ts`), anonymized sources (`anonymize.ts`), feedback, calendar matching, replay and its export format (`replay*.ts`, `turnRecorder.ts`), the prompts (in those modules), provider, server and key settings logic (`providers.ts`, `transcribeModels.ts`, `servers.ts`, `secrets.ts`, `settingsHandlers.ts`), the OpenAI chat, test and model-list clients (`openai.ts`, `openaiTest.ts`), Prepare on the host's own model (`localChat.ts`), PCM conversion for streaming (`pcm.ts`), and the orchestrator `createOleSession(host)` (`session.ts`). Plain TypeScript: it imports only other core files, Node built-ins (`node:*`) and the app's npm dependencies, and uses only standard runtime globals (`fetch`, `URL`, `console`, timers).
- **`core/host.ts`**: `OleHost`, everything the core needs from the app.
- **`app/src/main/ole/yogurt/`**: the Yogurt adapter, the only Ole code that imports `electron` or Yogurt modules. `session.ts` (`hookOle`, called by `index.ts`) builds the `OleHost` and maps the session's handlers to `ole:*` IPC; `providers.ts`, `servers.ts`, `secrets.ts` map the Settings handlers to IPC and seal keys with `safeStorage`; `settingsFile.ts` is the settings and key store over Yogurt's `settings.json`; `openaiModel.ts` makes OpenAI Yogurt's notes model; `openaiTranscribe.ts` and `openaiStream.ts` are OpenAI transcription behind Yogurt's `Transcribe` seam (they need its chunker, tracks and lines); `capture.ts` keeps Yogurt's windows out of screen sharing. The per-meeting files, the notes, the calendar and the save panel are passed in by `index.ts`.
- **`app/src/renderer/src/ole/`**: the UI is host UI. It talks to the core only through IPC (`window.yogurt.ole`); a new host reimplements it against the same handler contract (below), or reuses it if it is React too.

### The host interface (`OleHost`)

- `settings.get()` / `settings.patch(p)`: Ole's fields in the host's settings (`OleSettings`), read fresh on each call; patch returns the settings after it.
- `secrets.read(name)` / `secrets.write(name, value)` / `secrets.remove(name)`: API keys (`openai`, `custom`, `mcp:<id>`) in plain text to the core, sealed at rest by the host; write `''` removes, write throws when the host can't seal.
- `send(state)`: the live state (`OleLiveState`) out to the host's UI, on every change.
- `notify(title, body)` (optional): a system notification (a server stopped working, a briefing is ready).
- `notes.read(meetingId)` / `notes.append(meetingId, md)` (optional): the meeting's own notes, read at each bullets turn and Ask, appended to when the call ends.
- `calendar.upcoming(fromMs, toMs)` (optional): calendar events (`{ id, title, start, end }`), the fallback when no MCP server supplies meetings (#98); without it, and with no such server, Ole has no meeting list.
- `files.save*/load*` (each optional): per-meeting files kept on this computer: bullets, briefing, answers, call memory, recorded turns.
- `meetingForExport(meetingId)` / `saveExport(name, content)` (optional): a saved meeting's title, start, attendees and transcript, and a save panel, for Export for replay.
- `genericTitle(title)`: whether a title says nothing ("Zoom call", "Meeting") in the host's interface language (`core/titles.ts` has the English one).
- `clock.now()` / `clock.after(ms, fn)` / `clock.every(ms, fn)`: the clock and the session's background timers (server checks, auto-prepare, the next meeting for Home, the subject auto-pick); timers must not keep the process alive.
- `log.warn(message, error)`: where the session's warnings go.

The host also hands over its own model with `session.setLocal(run)` once it has one (Prepare on this computer: `LocalRun`, a job given a `LocalLlm` with `contextSize` and a text-in, text-out `chat`).

### What a new host provides

1. An `OleHost` (above) and a call to `createOleSession(host)`.
2. Meeting events into the session: `meetingStarted({ id, title })`, `meetingRenamed`, `segment({ meetingId, track, speaker, text, startMs })` per transcript line, `meetingStopped(id)`; `checkServers()` on wake.
3. Its UI's requests mapped to the handlers: `session.handlers` (`state`, `briefing`, `retryServers`, `bullets`, `pin`, `rate`, `ask`, `cancelAsk`, `call`, `answers`, `exportReplay`, `prepare`, `chooseSubject`, `clearPrepared`) and the Settings handlers in `core/settingsHandlers.ts` (`providerHandlers`, `serverHandlers`, `secretHandlers`, with `testServer` from `core/serverTest.ts`). Each handler takes the UI's input unchecked and validates it itself, so the host passes it straight through.
4. Transcription, if it wants OpenAI's: its own wiring of `/audio/transcriptions` or the Realtime stream to its audio pipeline (Yogurt's is in `yogurt/openaiTranscribe.ts` and `openaiStream.ts`; `core/pcm.ts` converts the audio).

For scale: the Yogurt adapter is about 340 lines (`yogurt/` without the two transcription files) plus about 90 in `index.ts` (the per-meeting files, notes, calendar, save panel, the OpenAI notes model and the local model handover).

### The isolation test

`app/test/ole/coreIsolation.test.ts` reads every file under `core/` and fails on an import of `electron`, a relative import that leaves `core/`, or anything that is not a Node built-in or a dependency in `app/package.json` (static, type-only, re-exports, `import()` and `require()`). `app/test/ole/coreSession.test.ts` runs a call on an in-memory host with no Electron. A change that needs the host goes through `OleHost`, never an import.

## Seams (Yogurt files Ole edits)

Every change to a Yogurt-owned file is also recorded in [docs/UPSTREAM.md](docs/UPSTREAM.md), split into upstream candidates and Ole-only changes. A PR that touches a Yogurt file updates that ledger in the same PR.


- `app/electron-builder.yml`: app id, names, usage strings, publish to `coryjett/ole`
- `app/package.json`: productName, version
- `app/src/shared/i18n.ts`: `t()` brands the message
- `app/src/main/paths.ts`: data folder `Ole`
- `app/src/main/index.ts`: app name and id; Ole keys, providers and session hooks (from `ole/yogurt/`); OpenAI notes model wrapper; transcription options
- `app/src/main/asr/index.ts`: OpenAI transcriber branch in `open()`, model gate in `recorded()`; the live recording's audio also goes to the OpenAI stream (`stream.push` before the pipeline's, `flush`/`close` in `finishSession`)
- `app/src/main/settings.ts`: Ole settings fields
- `app/src/main/trayMenu.ts`: tooltip name
- `app/src/preload/index.ts`, `app/src/shared/types.ts`: `window.yogurt.ole` (`OleLiveState` and `OleExportResult` are aliases of `ole/core/types.ts`)
- `app/src/renderer/src/screens/Settings.tsx`, `Home.tsx`, `Note.tsx`, `windows/Widget.tsx`: Ole settings, panel and bullets; the note's footer mounts the docked Ask (#122)
- `app/src/renderer/src/components/Chat.tsx`: the Ask button's handler asks `oleAskTakesOver(id)` first, so the button and ⌘J focus Ole's docked Ask during a call on that note (#122); the only Ole line in the host's Ask
- `app/src/shared/exportNotes.ts`, `app/resources/about/Credits.html`: credit Yogurt
- `app/native/*/Info.plist`, `app/native/yogurt-mcp/main.swift`: helper ids and paths
- `app/scripts/release-mac.sh`: "Ole Local" signing, Ole.app paths
- Tests updated for the Ole name: tray, widget, update, setup, paths and others under `app/test/`
