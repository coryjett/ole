# Getting started with Ole

You need a Mac (Apple Silicon), an **MCP server** address and key, and an **OpenAI key** (or your own model server).

1. **Install.** Download the `.dmg` from [Releases](https://github.com/coryjett/ole/releases), drag Ole to Applications, open it. If macOS blocks it: **System Settings › Privacy & Security › Open Anyway**.
2. **First run.** Paste your OpenAI key, then allow the microphone, call audio and Accessibility. If asked about **"Ole Safe Storage"**, choose **Always Allow**.
3. **Add your MCP servers.** **Settings › Ole › MCP servers › Add server**: name, address, key, **Save**, **Test**. Green means ready. Put the server that knows your meetings first.
4. **Before a call: nothing.** Ole prepares the briefing about 10 minutes before each meeting and tells you when it's ready. To prepare for something else, use **Prepare for…** on Home.
5. **During the call.** Start recording and tell people you're recording.
   - **Live** shows bullets as you talk; **Briefing** has the full briefing.
   - Not matched yet? Click a name Ole heard (**Heard: …**), or let it pick one after a minute.
   - **⌘J** asks Ole about the call. **Add a note…** at the bottom works on any tab.
6. **After.** Stop recording. The summary, transcript and Ole's context are saved with the meeting.

Updates download by themselves: click the purple **Update ready** pill to restart into one (during a call it waits until after). Stuck? Press **Test** next to the server in Settings. Still stuck? [Open an issue](https://github.com/coryjett/ole/issues).
