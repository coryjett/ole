// Ole on Yogurt: the live call companion (core/session.ts) wired to Yogurt. Builds the OleHost from Yogurt's settings
// file, keychain, notifications and meeting store (passed in by index.ts), and maps the session's handlers to IPC.
import { ipcMain } from 'electron'
import type { OleAnswer, OleBullet, OleCallMemory, OleLiveState } from '../core/types'
import type { OleHost } from '../core/host'
import type { Upcoming } from '../core/calendarMatch'
import type { RecordedCall } from '../core/turnRecorder'
import type { ExportSegment } from '../core/replayExport'
import { createOleSession, type OleSession } from '../core/session'
import { genericTitle } from '../../titles'
import { fileSecrets, fileSettings } from './settingsFile'

export { testServer, TEST_TIMEOUT_MS } from '../core/serverTest'

type Deps = {
  file: string; send: (s: OleLiveState) => void; save?: (meetingId: string, bullets: OleBullet[]) => void
  /** a finished meeting's bullets from disk (Ole was restarted since) */
  load?: (meetingId: string) => OleBullet[]
  /** the briefing a meeting had when it ended, saved with it and read back (#35) */
  saveBriefing?: (meetingId: string, text: string) => void
  loadBriefing?: (meetingId: string) => string
  /** the call's summary, open questions and commitments (#82), saved with the meeting and read back */
  saveCall?: (meetingId: string, memory: OleCallMemory) => void
  loadCall?: (meetingId: string) => OleCallMemory | null
  /** a macOS notification, for a server that just stopped working (#33) */
  notify?: (title: string, body: string) => void
  /** how often the servers are checked in the background; 0 turns the background check off (tests) */
  checkEveryMs?: number
  /** adds markdown to the end of a meeting's own notes, so pinned bullets (#54) and Ole's record of the call (#83) reach the summary */
  appendNotes?: (meetingId: string, md: string) => void
  /** a meeting's questions and answers (#53), saved with it and read back */
  saveAnswers?: (meetingId: string, answers: OleAnswer[]) => void
  loadAnswers?: (meetingId: string) => OleAnswer[]
  /** calendar events between two times (#52, #56); without it Ole never reads the calendar */
  upcoming?: (fromMs: number, toMs: number) => Promise<Upcoming[]>
  /** the user's own notes for a meeting, read at each bullets turn and Ask (#77) */
  notes?: (meetingId: string) => string
  /** how much new conversation updates the running summary; default 3 minutes, 0 updates on every line (tests) */
  summaryEveryMs?: number
  /** how often auto-prepare looks at the calendar; 0 turns the timer off (tests) */
  autoEveryMs?: number
  /** the call's bullets turns (#70), saved with it on this Mac and read back for Export for replay */
  saveTurns?: (meetingId: string, call: RecordedCall) => void
  loadTurns?: (meetingId: string) => RecordedCall | null
  /** a saved meeting's title, start, attendees and transcript, for Export for replay (#70); null when it is gone */
  meetingForExport?: (meetingId: string) => { title: string; startedAt: number; attendees: Array<{ name: string; email?: string | null }>; segments: ExportSegment[] } | null
  /** shows the save panel with this file name and writes the content where the person picks */
  saveExport?: (defaultName: string, content: string) => Promise<'saved' | 'cancelled' | 'failed'>
}

export function hookOle(d: Deps): Omit<OleSession, 'handlers'> {
  const host: OleHost = {
    settings: fileSettings(d.file),
    secrets: fileSecrets(d.file),
    send: d.send,
    notify: d.notify,
    notes: { read: d.notes, append: d.appendNotes },
    calendar: d.upcoming ? { upcoming: d.upcoming } : undefined,
    files: {
      saveBullets: d.save, loadBullets: d.load, saveBriefing: d.saveBriefing, loadBriefing: d.loadBriefing,
      saveAnswers: d.saveAnswers, loadAnswers: d.loadAnswers, saveCall: d.saveCall, loadCall: d.loadCall,
      saveTurns: d.saveTurns, loadTurns: d.loadTurns,
    },
    meetingForExport: d.meetingForExport,
    saveExport: d.saveExport,
    // the interface language's default titles (titles.ts, set by index.ts once the language is known)
    genericTitle,
    // background timers never keep the app running
    clock: {
      now: () => Date.now(),
      after: (ms, fn) => { setTimeout(fn, ms).unref?.() },
      every: (ms, fn) => { setInterval(fn, ms).unref?.() },
    },
    log: { warn: (message, error) => { if (error === undefined) console.warn(message); else console.warn(message, error) } },
  }
  const { handlers: h, ...session } = createOleSession(host, { checkEveryMs: d.checkEveryMs, summaryEveryMs: d.summaryEveryMs, autoEveryMs: d.autoEveryMs })

  ipcMain.handle('ole:state', () => h.state())
  ipcMain.handle('ole:briefing', (_e, id: unknown) => h.briefing(id))
  ipcMain.handle('ole:retry-servers', () => h.retryServers())
  ipcMain.handle('ole:bullets', (_e, id: unknown) => h.bullets(id))
  ipcMain.handle('ole:bullet:pin', (_e, id: unknown, on: unknown) => h.pin(id, on))
  ipcMain.handle('ole:bullet:rate', (_e, id: unknown, rating: unknown) => h.rate(id, rating))
  ipcMain.handle('ole:ask', (_e, q: unknown, requestId: unknown, meetingId: unknown) => h.ask(q, requestId, meetingId))
  ipcMain.handle('ole:ask:cancel', (_e, requestId: unknown) => h.cancelAsk(requestId))
  ipcMain.handle('ole:call', (_e, id: unknown) => h.call(id))
  ipcMain.handle('ole:answers', (_e, id: unknown) => h.answers(id))
  ipcMain.handle('ole:export-replay', (_e, id: unknown, o: unknown) => h.exportReplay(id, o))
  ipcMain.handle('ole:prepare', (_e, o: unknown) => h.prepare(o))
  return session
}
