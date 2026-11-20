# Getting started with Ole

About 10 minutes from download to your first prepared call.

You'll need:

- a Mac with Apple Silicon and macOS 14.4 or later;
- at least one **MCP server** with your data on it (its address, ending in `/mcp`, and a key). Ask whoever runs it;
- for the briefing and live context: an **OpenAI API key** (from [platform.openai.com](https://platform.openai.com)) or an **OpenAI-compatible server** you run.

## 1. Install

1. Download `Ole-mac-arm64.dmg` from the latest release on the [Releases page](https://github.com/coryjett/ole/releases).
2. Open it and drag **Ole** into **Applications**.
3. Open Ole. The first time, macOS blocks it because this alpha isn't notarized by Apple: open **System Settings › Privacy & Security**, scroll down and click **Open Anyway**.
4. If macOS asks for your login password to let Ole use **"Ole Safe Storage"**, choose **Always Allow**. That's where Ole keeps your keys. (It asks again after each update until Ole is signed by Apple.)

## 2. First run

Ole walks you through a few screens:

- **Connect OpenAI:** paste your key; Ole checks it. Leave **Also use OpenAI for transcription and summaries** ticked unless you want those on your Mac. No key yet? Click **Not now**.
- **Microphone and call audio:** allow both, so Ole hears you and the other side.
- **Accessibility:** allow it, so Ole can read who's speaking in Zoom, Teams and Meet.
- **Calendar** (optional): lets Ole name meetings after your calendar events.

## 3. Set up Ole

Open **Settings** (⌘,) and scroll to **Ole**.

**Assistant:** who writes the briefing, the live context and the summaries.

| Choice | Use it when |
|---|---|
| **OpenAI** | You have an OpenAI key. |
| **Custom server** | You run an OpenAI-compatible model server. Enter its address (ending at `/v1`), its key if it needs one, and press **Test**. |
| **Local** | You only want transcripts and summaries on your Mac. There's no briefing or live context, and Ole doesn't contact your MCP servers. |

**Models** (with OpenAI): each dropdown lists the models your key can use and marks the recommended ones.

- **Transcription model:** a speech-to-text model.
- **Prepare model:** a larger model for the briefing.
- **Live bullets and summaries model:** a small, fast model.

Press **Test** next to the OpenAI key to check the key and the model names.

**MCP servers:** click **Add server**, give it a name and its address, paste its key and click **Save**, then **Test**. A green badge shows how many read-only tools Ole can use; **Show tools** lists them. A red badge says what's wrong: no key, a rejected key, or the server can't be reached (VPN off?). Ole only ever calls tools that read.

**Warm-up instructions** (optional): tell Ole how you like to prepare, for example *"Look up the account, its open deals and their stage, open support issues and the last two calls. Lead with risks."* If your MCP server publishes its own preparation instructions, Ole follows those first and yours on top.

## 4. Your first call

**Before:** on Home, type a company, person or topic into **Focus** (optional) and press **Prepare for next call**. Ole works out your next meeting, looks things up on your MCP servers and writes a short briefing in which every fact names its source. It takes 20 to 60 seconds.

**During:** start recording when the call starts (Ole offers to when it sees one). Tell the other people you're recording: no bot joins, so nobody is told automatically. While you talk, context appears every 20 seconds or so on the note and in the floating window (hover over it): what's open, who hit the same problem, what to watch for, each with its source.

**After:** stop the recording. Ole writes the summary (decisions, next steps, open questions) from the transcript and your typed notes. The meeting stays in your library with its transcript, your notes and **Context from the call**.

## Updates

Ole checks for new versions when it starts and every 4 hours, and downloads them in the background. When one is ready, macOS tells you; restart from **Settings › Updates**. Updates never install mid-recording.

## If something's off

| You see | Try |
|---|---|
| "Add an OpenAI key in Settings" | Paste a key under **OpenAI key**, or set **Assistant** to a Custom server. |
| "Set Assistant to OpenAI or Custom server" | Prepare and live context don't run with **Local**. |
| A server's Test says it can't be reached | Connect to the VPN that server needs, then **Test** again. |
| "The MCP server rejected the key" | Paste a fresh key for that server and click **Save**. |
| The keychain prompt after an update | Choose **Always Allow**. |
| No speaker names | Allow **Accessibility** for Ole in **System Settings › Privacy & Security**. |

Found a bug or want something? [Open an issue](https://github.com/coryjett/ole/issues).
