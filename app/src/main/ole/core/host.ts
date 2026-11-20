// Ole: what the core needs from the app it runs in. A host (Yogurt today: ../yogurt/) implements OleHost and maps the
// session's handlers (session.ts) and the settings handlers (settingsHandlers.ts) to its own IPC. Nothing in core/
// imports the host; everything it needs comes through here. See OLE.md "Layout and porting".
import type { OleAnswer, OleBullet, OleCallMemory, OleLiveState, SecretName, McpServerConfig, TranscribeModelSwitch } from './types'
import type { LocalRun } from './localChat'
import type { Upcoming } from './calendarMatch'
import type { RecordedCall } from './turnRecorder'
import type { ExportSegment } from './replayExport'
import type { GenericTitle } from './titles'

/** Ole's fields in the host's settings. The host stores them as it likes (Yogurt: settings.json) */
export type OleSettings = {
  oleTranscription?: 'local' | 'openai'
  oleAssistant?: 'local' | 'openai' | 'custom'
  oleTranscribeModel?: string
  /** a retiring model the saved one was moved off (#89), kept until the person dismisses the notice */
  oleTranscribeModelSwitched?: TranscribeModelSwitch
  oleTranscribeStreaming?: boolean
  oleChatModel?: string
  olePrepareModel?: string
  oleCustomBaseUrl?: string
  oleCustomModel?: string
  olePrepareOn?: 'assistant' | 'local'
  oleTranscriptionChosen?: boolean
  oleAssistantChosen?: boolean
  oleAutoSwitched?: Array<'transcription' | 'assistant'>
  oleWarmupInstructions?: string
  oleMcpServers?: McpServerConfig[]
  oleHideWhileSharing?: boolean
  oleAutoPrepare?: boolean
  oleAutoPrepareLead?: number
  oleFeedback?: { useful: string[]; notUseful: string[] }
}

/** the host's settings, read fresh on each call so a change applies at once */
export type SettingsStore = {
  get(): OleSettings
  /** merges the patch (undefined removes a field) and returns the settings after it */
  patch(patch: Partial<OleSettings>): OleSettings
}

/** API keys, sealed at rest by the host (Yogurt: the system keychain via safeStorage); the core only sees plain text */
export type SecretStore = {
  /** the key, or null when unset or it can't be unsealed */
  read(name: SecretName): string | null
  /** seals and saves; '' removes. Throws when the host can't seal (nothing is written then) */
  write(name: SecretName, value: string): void
  /** drops a key; works even where sealing is refused */
  remove(name: SecretName): void
}

/** a saved meeting, for Export for replay (#70) */
export type ExportMeeting = { title: string; startedAt: number; attendees: Array<{ name: string; email?: string | null }>; segments: ExportSegment[] }

/** per-meeting files Ole keeps with a meeting, on this computer only. Each load is null/empty when there is none */
export type MeetingFiles = {
  saveBullets?(meetingId: string, bullets: OleBullet[]): void
  loadBullets?(meetingId: string): OleBullet[]
  saveBriefing?(meetingId: string, text: string): void
  loadBriefing?(meetingId: string): string
  saveAnswers?(meetingId: string, answers: OleAnswer[]): void
  loadAnswers?(meetingId: string): OleAnswer[]
  saveCall?(meetingId: string, memory: OleCallMemory): void
  loadCall?(meetingId: string): OleCallMemory | null
  saveTurns?(meetingId: string, call: RecordedCall): void
  loadTurns?(meetingId: string): RecordedCall | null
  /** the organization the call's briefing matched (#154), saved when the call ends; null when none was saved */
  saveOrg?(meetingId: string, org: string): void
  loadOrg?(meetingId: string): string | null
}

export type OleHost = {
  settings: SettingsStore
  secrets: SecretStore
  /** live state out to the host's UI, on every change */
  send(state: OleLiveState): void
  /** a system notification (a server stopped working, a briefing is ready) */
  notify?(title: string, body: string): void
  /** the meeting's own notes: read at each bullets turn and Ask (#77); appended to when the call ends (#54, #83) */
  notes?: { read?(meetingId: string): string; append?(meetingId: string, md: string): void }
  /** calendar events between two times (#52, #56); without it Ole never reads the calendar */
  calendar?: { upcoming(fromMs: number, toMs: number): Promise<Upcoming[]> }
  files: MeetingFiles
  /** a saved meeting's title, start, attendees and transcript; null when it is gone (#70) */
  meetingForExport?(meetingId: string): ExportMeeting | null
  /** shows a save panel with this file name and writes the content where the person picks */
  saveExport?(defaultName: string, content: string): Promise<'saved' | 'cancelled' | 'failed'>
  /** a title that says nothing ("Zoom call", "Meeting"), in the host's interface language */
  genericTitle: GenericTitle
  /** the clock and the session's background timers (server checks, auto-prepare); timers must not keep the process alive */
  clock: { now(): number; after(ms: number, fn: () => void): void; every(ms: number, fn: () => void): void }
  log: { warn(message: string, error?: unknown): void }
}

/** the host's own model, handed over once it exists (Prepare on this computer, #5) */
export type { LocalRun }
