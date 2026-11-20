import { ipcMain } from 'electron'
import type { OleBullet, PreparedContext } from './types'
import type { OleLiveState } from '../../shared/types'
import { loadSettings } from '../settings'
import { readSecret } from './secrets'
import { providersOf } from './providers'
import { openaiChat } from './openaiModel'
import { createSiestaClient, type SiestaClient } from './siesta'
import { prepareContext, searchAccounts } from './prepare'
import { createBulletsEngine, type BulletsEngine, type ChatFn } from './bullets'

// Ole: the live call companion. Siesta warm-up before the call, context bullets during it (bullets.ts).

let prepared: PreparedContext | null = null
let preparing = false
let error: string | null = null
let meetingId: string | null = null
let engine: BulletsEngine | null = null
let bullets: OleBullet[] = []
const finished = new Map<string, OleBullet[]>()
let prepareSeq = 0

function state(): OleLiveState {
  return {
    meetingId,
    preparing,
    prepared: prepared ? {
      meetingTitle: prepared.meetingTitle,
      accountId: prepared.accountId,
      accountName: prepared.accountName,
      preparedAt: prepared.preparedAt
    } : null,
    error,
    bullets
  }
}

function send(): void {
  d.send(state())
}

let d!: { file: string; send: (s: OleLiveState) => void; save?: (meetingId: string, bullets: OleBullet[]) => void }

function siesta(dFile: string): SiestaClient | null {
  const key = readSecret(dFile, 'siesta')
  if (!key) return null
  const url = providersOf(loadSettings(dFile)).siestaUrl
  if (!url) return null
  return createSiestaClient({ key, url })
}

async function prepare(
  o: { accountId?: string | null; meetingTitle?: string | null; forMeeting?: string }
): Promise<OleLiveState> {
  const client = siesta(d.file)
  if (!client) {
    error = 'Add the Siesta URL and key in Settings'
    preparing = false
    send()
    return state()
  }

  const seq = ++prepareSeq
  preparing = true
  error = null
  send()

  try {
    const result = await prepareContext(client, {
      accountId: o.accountId ?? undefined,
      meetingTitle: o.meetingTitle ?? undefined
    })
    if (seq !== prepareSeq) return state()
    // the meeting ended while this was loading: the next call prepares fresh
    if (o.forMeeting !== undefined && o.forMeeting !== meetingId) { preparing = false; send(); return state() }
    prepared = result
    error = null
  } catch (err) {
    if (seq !== prepareSeq) return state()
    error = err instanceof Error ? err.message : String(err)
  }

  preparing = false
  send()
  return state()
}

export function hookOle(
  d0: { file: string; send: (s: OleLiveState) => void; save?: (meetingId: string, bullets: OleBullet[]) => void }
): {
  meetingStarted(m: { id: string; title: string }): void
  meetingStopped(id: string): void
  segment(seg: { meetingId: string; track: 'me' | 'them'; speaker?: string | null; text: string; startMs: number }): void
  bulletsOf(id: string): OleBullet[]
} {
  d = d0

  ipcMain.handle('ole:state', () => state())

  ipcMain.handle('ole:prepare', (_e, o: unknown) => {
    const input = (o ?? {}) as Record<string, unknown>
    const accountId = typeof input.accountId === 'string' ? input.accountId : null
    const meetingTitle = typeof input.meetingTitle === 'string' ? input.meetingTitle : null
    return prepare({ accountId, meetingTitle })
  })

  ipcMain.handle('ole:search-accounts', async (_e, q: unknown) => {
    if (typeof q !== 'string' || q.length < 2 || q.length > 100) return []
    const client = siesta(d.file)
    if (!client) return []
    return searchAccounts(client, q)
  })

  function meetingStarted(m: { id: string; title: string }): void {
    meetingId = m.id
    bullets = []

    const stale = !prepared || Date.now() - prepared.preparedAt > 2 * 60 * 60 * 1000
    if (stale) void prepare({ meetingTitle: m.title, forMeeting: m.id })

    const openaiKey = readSecret(d.file, 'openai')
    if (!openaiKey) {
      engine = null
      send()
      return
    }

    const model = providersOf(loadSettings(d.file)).openaiChatModel

    const chat: ChatFn = req => openaiChat({
      key: readSecret(d.file, 'openai'),
      model,
      ...req
    })

    const searchCalls = async (q: string): Promise<string> => {
      const c = siesta(d.file)
      if (!c) return 'Siesta is not connected'
      return c.callTool('search_calls', { query: q }, { timeoutMs: 15000 })
    }

    engine = createBulletsEngine({
      chat,
      searchCalls,
      context: () => prepared,
      onBullets: all => {
        bullets = all
        send()
      }
    })

    send()
  }

  function segment(
    seg: { meetingId: string; track: 'me' | 'them'; speaker?: string | null; text: string; startMs: number }
  ): void {
    if (seg.meetingId !== meetingId || !engine) return
    if (!seg.text.trim()) return
    const speaker = seg.speaker || (seg.track === 'me' ? 'Me' : 'Them')
    engine.push({ speaker, text: seg.text, startMs: seg.startMs })
  }

  function meetingStopped(id: string): void {
    if (id !== meetingId) return
    engine?.stop()
    finished.set(id, bullets)
    try { d.save?.(id, bullets) } catch (e) { console.warn('saving the context bullets failed', e) }
    engine = null
    meetingId = null
    prepared = null
    send()
  }

  function bulletsOf(id: string): OleBullet[] {
    return finished.get(id) ?? (id === meetingId ? bullets : [])
  }

  return { meetingStarted, meetingStopped, segment, bulletsOf }
}