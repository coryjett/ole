// Ole: the live call companion. Before the call, the model gathers a briefing from the MCP servers' read-only tools
// (prepare.ts); during it, context bullets from the transcript, the briefing and throttled tool lookups (bullets.ts).
import { ipcMain } from 'electron'
import type { McpServerConfig, OleBullet, OleTool, PreparedContext } from './types'
import type { OleLiveState } from '../../shared/types'
import { loadSettings } from '../settings'
import { readSecret } from './secrets'
import { providersOf } from './providers'
import { serversOf } from './servers'
import { openaiChat } from './openaiModel'
import { createMcpClient, McpError } from './mcp'
import { boundedSchema, collectTools, collectWarmupPrompts, createToolRunner, isLiveTool, isReadOnly, type Unavailable } from './tools'
import { prepareContext } from './prepare'
import { genericTitle } from '../titles'
import { createLocalChat, type LocalRun } from './localChat'
import { createBulletsEngine, type BulletsEngine, type ChatFn } from './bullets'

/** a prepared briefing older than this is gathered again when a meeting starts */
const STALE_MS = 2 * 60 * 60_000

type Deps = {
  file: string; send: (s: OleLiveState) => void; save?: (meetingId: string, bullets: OleBullet[]) => void
  /** a finished meeting's bullets from disk (Ole was restarted since) */
  load?: (meetingId: string) => OleBullet[]
  /** the briefing a meeting had when it ended, saved with it and read back (#35) */
  saveBriefing?: (meetingId: string, text: string) => void
  loadBriefing?: (meetingId: string) => string
  /** a macOS notification, for a server that just stopped working (#33) */
  notify?: (title: string, body: string) => void
  /** how often the servers are checked in the background; 0 turns the background check off (tests) */
  checkEveryMs?: number
}

export function hookOle(d: Deps): {
  meetingStarted(m: { id: string; title: string }): void
  /** the recording was renamed (calendar match or the person): a briefing from a default title is prepared again once (#44) */
  meetingRenamed(m: { id: string; title: string }): void
  meetingStopped(id: string): void
  segment(seg: { meetingId: string; track: 'me' | 'them'; speaker?: string | null; text: string; startMs: number }): void
  bulletsOf(id: string): OleBullet[]
  /** hands over the Mac's own model for Prepare once Yogurt's notes queue exists (#5) */
  setLocal(run: LocalRun): void
  /** check the MCP servers now (at startup, on a timer, on wake), so a broken one is found before the call (#33) */
  checkServers(): Promise<void>
} {
  let prepared: PreparedContext | null = null
  let preparing = false
  let error: string | null = null
  let meetingId: string | null = null
  let engine: BulletsEngine | null = null
  let bullets: OleBullet[] = []
  let tools: OleTool[] = []
  /** enabled servers that failed the last time tools were loaded (#33) */
  let unavailable: Unavailable[] = []
  let call: (name: string, argsJson: string) => Promise<string> = async () => 'No MCP tools are available'
  let prepareSeq = 0
  /** the call's briefing came from a default title, so a real title prepares it once more (#44) */
  let preparedFromDefault = false
  const finished = new Map<string, OleBullet[]>()
  const finishedBriefings = new Map<string, string>()

  /** the Mac's own model for Prepare (#5), handed over once Yogurt's notes queue exists */
  let local: LocalRun | null = null
  /** why live context is off, or null when it can run: it needs the Assistant on OpenAI with a key, or a Custom server (#11, #17) */
  const liveBlocked = (): string | null => {
    const p = providersOf(loadSettings(d.file))
    if (p.assistant === 'local') return 'Prepare and live context use OpenAI or your own server, with your MCP servers. Set Assistant to OpenAI or Custom server in Settings > Ole.'
    if (p.assistant === 'openai' && !openaiKey()) return 'Add an OpenAI key in Settings > Ole to prepare for calls.'
    if (p.assistant === 'custom' && !p.customBaseUrl) return 'Add the Custom server address in Settings > Ole to prepare for calls.'
    return null
  }
  /** why Prepare is off: on the local model only before a call and once it is ready (#5), otherwise as live context */
  const blocked = (): string | null => {
    if (providersOf(loadSettings(d.file)).prepareOn !== 'local') return liveBlocked()
    if (!local) return 'The local model is still starting.'
    if (meetingId) return 'Prepare on this Mac runs before a call, not during one.'
    return null
  }
  const state = (): OleLiveState => ({
    meetingId, preparing, error, bullets, blocked: blocked(), unavailable,
    prepared: prepared ? { meetingTitle: prepared.meetingTitle, focus: prepared.focus, preparedAt: prepared.preparedAt, text: prepared.text } : null,
  })
  const send = () => d.send(state())

  const openaiKey = () => readSecret(d.file, 'openai')
  /** where chat goes: OpenAI, or the person's OpenAI-compatible server (#17); read per request so Settings apply at once */
  const endpoint = (role: 'live' | 'prepare') => {
    const p = providersOf(loadSettings(d.file))
    if (p.assistant === 'custom') return { key: readSecret(d.file, 'custom') ?? '', baseUrl: p.customBaseUrl, model: p.customModel || 'default' }
    return { key: openaiKey(), model: role === 'prepare' ? p.openaiPrepareModel : p.openaiChatModel }
  }
  const chat: ChatFn = (req) => openaiChat({ ...endpoint('live'), ...req })
  // the briefing picks tools and writes, so on OpenAI it gets its own (larger) model
  const prepareChat: ChatFn = (req) => openaiChat({ ...endpoint('prepare'), ...req })
  const clientOf = (s: McpServerConfig) => createMcpClient({ key: readSecret(d.file, `mcp:${s.id}`) ?? undefined, url: s.url })

  /** the enabled servers' read-only tools, gathered again on each prepare and meeting start */
  const enabledServers = () => serversOf(loadSettings(d.file)).filter(s => s.enabled).map(config => ({ config, client: clientOf(config) }))
  async function loadTools(): Promise<void> {
    const servers = enabledServers()
    const failed: Unavailable[] = []
    tools = servers.length ? await collectTools(servers, u => failed.push(u)) : []
    unavailable = failed
    const runner = createToolRunner(servers, tools)
    call = (name, argsJson) => runner.call(name, argsJson)
  }

  async function prepare(o: { focus?: string | null; meetingTitle?: string | null; forMeeting?: string }): Promise<OleLiveState> {
    // enforced here, not only in the panel: Assistant = Local (without local Prepare) never reaches OpenAI or an MCP server
    if (blocked()) { error = null; send(); return state() }
    if (!serversOf(loadSettings(d.file)).some(s => s.enabled)) { error = 'Add an MCP server in Settings'; send(); return state() }
    const seq = ++prepareSeq
    preparing = true; error = null; send()
    try {
      await loadTools()
      const instructions = providersOf(loadSettings(d.file)).warmupInstructions
      // every enabled server failed: say so rather than write a briefing from nothing (#33)
      if (!tools.length && unavailable.length) throw new Error(`Couldn't use any MCP server: ${unavailable.map(u => `${u.name} (${u.reason})`).join(', ')}.`)
      const meetingTitle = o.meetingTitle ?? null, focus = o.focus ?? null
      // each server's own warm-up prompt (MCP prompts, prepare_for_meeting) comes first; the person's instructions refine it
      const serverPrompts = await collectWarmupPrompts(enabledServers(), { meetingTitle, focus })
      // on this Mac (#5) the notes queue runs it, so it never overlaps a summary
      const onMac = providersOf(loadSettings(d.file)).prepareOn === 'local' && local
      const result = await prepareContext({ chat: onMac ? createLocalChat(onMac) : prepareChat, tools, call, meetingTitle, focus, instructions, serverPrompts })
      if (seq !== prepareSeq) return state()
      // the meeting ended while this was loading: the next call prepares fresh
      if (o.forMeeting !== undefined && o.forMeeting !== meetingId) { preparing = false; send(); return state() }
      // the saved briefing records which servers it lacks
      prepared = unavailable.length ? { ...result, text: `${result.text}\n\n_Not included: ${unavailable.map(u => `${u.name} (${u.reason})`).join(', ')}._` } : result
    } catch (e) {
      if (seq !== prepareSeq) return state()
      error = e instanceof Error ? e.message : String(e)
    }
    preparing = false
    send()
    return state()
  }

  const text = (v: unknown, max: number) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
  /** servers already reported as failing: one notification when one stops working, none again until it recovers (#33) */
  const reported = new Set<string>()
  async function checkServers(): Promise<void> {
    // with Assistant on Local and Prepare not on this Mac, Ole never contacts the servers (#11)
    if (liveBlocked() && providersOf(loadSettings(d.file)).prepareOn !== 'local') return
    if (!serversOf(loadSettings(d.file)).some(s => s.enabled) || preparing) return
    try { await loadTools() } catch (e) { console.warn('checking the MCP servers failed', e); return }
    const failing = new Set(unavailable.map(u => u.name))
    for (const u of unavailable) if (!reported.has(u.name)) d.notify?.(`Ole can't use ${u.name}`, `The MCP server ${u.reason === "couldn't be reached" ? "couldn't be reached" : `failed: ${u.reason}`}. Fix it in Settings › Ole before your next call.`)
    reported.clear(); for (const n of failing) reported.add(n)
    send()
  }
  const every = d.checkEveryMs ?? 10 * 60_000
  if (every > 0) { setTimeout(() => void checkServers(), 5_000).unref?.(); setInterval(() => void checkServers(), every).unref?.() }

  ipcMain.handle('ole:state', () => state())
  ipcMain.handle('ole:briefing', (_e, id: unknown) => {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return ''
    if (id === meetingId) return prepared?.text ?? ''
    const found = finishedBriefings.get(id)
    if (found !== undefined) return found
    try { return d.loadBriefing?.(id) ?? '' } catch { return '' }
  })
  ipcMain.handle('ole:retry-servers', async () => { try { await loadTools() } catch (e) { console.warn('loading the MCP tools failed', e) } send(); return state() })
  // a saved meeting's context bullets, newest first; ids are Yogurt's meeting UUIDs
  ipcMain.handle('ole:bullets', (_e, id: unknown) => {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return []
    const found = finished.get(id) ?? (id === meetingId ? bullets : null)
    if (found) return found
    try { return d.load?.(id) ?? [] } catch { return [] }
  })
  ipcMain.handle('ole:prepare', (_e, o: unknown) => {
    const input = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>
    return prepare({ focus: text(input.focus, 200), meetingTitle: text(input.meetingTitle, 300) })
  })

  return {
    meetingStarted(m) {
      meetingId = m.id
      bullets = []
      // a local Prepare never runs during a call (#5): the bullets just get the tools
      const prepareNow = (!prepared || Date.now() - prepared.preparedAt > STALE_MS) && providersOf(loadSettings(d.file)).prepareOn !== 'local'
      // "Meeting", "Zoom call", "Untitled": a default title says nothing, so look for the meeting happening now instead (#44)
      const named = genericTitle(m.title) ? null : m.title
      preparedFromDefault = prepareNow && !named
      if (prepareNow) void prepare({ meetingTitle: named, forMeeting: m.id })
      else void loadTools().then(send, e => console.warn('loading the MCP tools failed', e))
      // bullets need the OpenAI key; without it the meeting records as Yogurt does
      engine = !liveBlocked() ? createBulletsEngine({
        chat,
        // live bullets get the lookup-style tools only (#15)
        tools: () => tools.filter(isLiveTool),
        callTool: (name, argsJson) => call(name, argsJson),
        context: () => prepared,
        onBullets: all => { bullets = all; send() },
      }) : null
      send()
    },
    meetingRenamed(m) {
      if (m.id !== meetingId || !preparedFromDefault || genericTitle(m.title)) return
      preparedFromDefault = false
      if (providersOf(loadSettings(d.file)).prepareOn !== 'local') void prepare({ meetingTitle: m.title, forMeeting: m.id })
    },
    segment(seg) {
      if (seg.meetingId !== meetingId || !engine || !seg.text.trim()) return
      engine.push({ speaker: seg.speaker || (seg.track === 'me' ? 'Me' : 'Them'), text: seg.text, startMs: seg.startMs })
    },
    meetingStopped(id) {
      if (id !== meetingId) return
      engine?.stop()
      finished.set(id, bullets)
      try { d.save?.(id, bullets) } catch (e) { console.warn('saving the context bullets failed', e) }
      if (prepared?.text) { finishedBriefings.set(id, prepared.text); try { d.saveBriefing?.(id, prepared.text) } catch (e) { console.warn('saving the briefing failed', e) } }
      engine = null
      meetingId = null
      prepared = null
      // the call's bullets now live with the meeting (its note page); Home starts clean for the next call
      bullets = []
      send()
    },
    setLocal(run) { local = run; send() },
    checkServers,
    bulletsOf: (id) => finished.get(id) ?? (id === meetingId ? bullets : []),
  }
}

/** Settings' Test button waits at most this long: a server that can't be reached never answers */
export const TEST_TIMEOUT_MS = 10_000

/** Settings' Test button: how many read-only tools the server offers Ole, or why it can't be reached. */
export async function testServer(server: McpServerConfig, key: string | null, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<{ ok: boolean; tools: number; error?: string; toolList?: Array<{ name: string; description: string }> }> {
  try {
    const listed = await createMcpClient({ key: key ?? undefined, url: server.url, ...(o.fetch ? { fetch: o.fetch } : {}) }).listTools({ timeoutMs: o.timeoutMs ?? TEST_TIMEOUT_MS })
    // only what Ole will use: read-only and a schema within bounds (#1)
    const usable = listed.filter(t => isReadOnly(t) && boundedSchema(t.inputSchema))
    return { ok: true, tools: usable.length, toolList: usable.map(t => ({ name: t.name, description: (t.description ?? '').trim() })).sort((a, b) => a.name.localeCompare(b.name)) }
  } catch (e) {
    const kind = e instanceof McpError ? e.kind : null
    if (kind === 'auth') return { ok: false, tools: 0, error: key ? 'The server rejected the key' : 'The server needs a key: paste it and Save, then Test' }
    if (kind === 'timeout' || kind === 'unreachable') return { ok: false, tools: 0, error: `Couldn't reach the server in ${TEST_TIMEOUT_MS / 1000} s. Check its address.` }
    return { ok: false, tools: 0, error: e instanceof Error ? e.message : String(e) }
  }
}
