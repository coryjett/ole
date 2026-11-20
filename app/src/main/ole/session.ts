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
import { boundedSchema, collectTools, collectWarmupPrompts, createToolRunner, isReadOnly } from './tools'
import { prepareContext } from './prepare'
import { createBulletsEngine, type BulletsEngine, type ChatFn } from './bullets'

/** a prepared briefing older than this is gathered again when a meeting starts */
const STALE_MS = 2 * 60 * 60_000

type Deps = {
  file: string; send: (s: OleLiveState) => void; save?: (meetingId: string, bullets: OleBullet[]) => void
  /** a finished meeting's bullets from disk (Ole was restarted since) */
  load?: (meetingId: string) => OleBullet[]
}

export function hookOle(d: Deps): {
  meetingStarted(m: { id: string; title: string }): void
  meetingStopped(id: string): void
  segment(seg: { meetingId: string; track: 'me' | 'them'; speaker?: string | null; text: string; startMs: number }): void
  bulletsOf(id: string): OleBullet[]
} {
  let prepared: PreparedContext | null = null
  let preparing = false
  let error: string | null = null
  let meetingId: string | null = null
  let engine: BulletsEngine | null = null
  let bullets: OleBullet[] = []
  let tools: OleTool[] = []
  let call: (name: string, argsJson: string) => Promise<string> = async () => 'No MCP tools are available'
  let prepareSeq = 0
  const finished = new Map<string, OleBullet[]>()

  const state = (): OleLiveState => ({
    meetingId, preparing, error, bullets,
    prepared: prepared ? { meetingTitle: prepared.meetingTitle, focus: prepared.focus, preparedAt: prepared.preparedAt } : null,
  })
  const send = () => d.send(state())

  const openaiKey = () => readSecret(d.file, 'openai')
  const chat: ChatFn = (req) => openaiChat({ key: openaiKey(), model: providersOf(loadSettings(d.file)).openaiChatModel, ...req })
  // the briefing picks tools and writes, so it gets its own (larger) model
  const prepareChat: ChatFn = (req) => openaiChat({ key: openaiKey(), model: providersOf(loadSettings(d.file)).openaiPrepareModel, ...req })
  const clientOf = (s: McpServerConfig) => createMcpClient({ key: readSecret(d.file, `mcp:${s.id}`) ?? undefined, url: s.url })

  /** the enabled servers' read-only tools, gathered again on each prepare and meeting start */
  const enabledServers = () => serversOf(loadSettings(d.file)).filter(s => s.enabled).map(config => ({ config, client: clientOf(config) }))
  async function loadTools(): Promise<void> {
    const servers = enabledServers()
    tools = servers.length ? await collectTools(servers) : []
    const runner = createToolRunner(servers, tools)
    call = (name, argsJson) => runner.call(name, argsJson)
  }

  async function prepare(o: { focus?: string | null; meetingTitle?: string | null; forMeeting?: string }): Promise<OleLiveState> {
    if (!openaiKey()) { error = 'Add an OpenAI key in Settings'; send(); return state() }
    if (!serversOf(loadSettings(d.file)).some(s => s.enabled)) { error = 'Add an MCP server in Settings'; send(); return state() }
    const seq = ++prepareSeq
    preparing = true; error = null; send()
    try {
      await loadTools()
      const instructions = providersOf(loadSettings(d.file)).warmupInstructions
      const meetingTitle = o.meetingTitle ?? null, focus = o.focus ?? null
      // each server's own warm-up prompt (MCP prompts, prepare_for_meeting) comes first; the person's instructions refine it
      const serverPrompts = await collectWarmupPrompts(enabledServers(), { meetingTitle, focus })
      const result = await prepareContext({ chat: prepareChat, tools, call, meetingTitle, focus, instructions, serverPrompts })
      if (seq !== prepareSeq) return state()
      // the meeting ended while this was loading: the next call prepares fresh
      if (o.forMeeting !== undefined && o.forMeeting !== meetingId) { preparing = false; send(); return state() }
      prepared = result
    } catch (e) {
      if (seq !== prepareSeq) return state()
      error = e instanceof Error ? e.message : String(e)
    }
    preparing = false
    send()
    return state()
  }

  const text = (v: unknown, max: number) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
  ipcMain.handle('ole:state', () => state())
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
      if (!prepared || Date.now() - prepared.preparedAt > STALE_MS) void prepare({ meetingTitle: m.title, forMeeting: m.id })
      else void loadTools().catch(e => console.warn('loading the MCP tools failed', e))
      // bullets need the OpenAI key; without it the meeting records as Yogurt does
      engine = openaiKey() ? createBulletsEngine({
        chat,
        tools: () => tools,
        callTool: (name, argsJson) => call(name, argsJson),
        context: () => prepared,
        onBullets: all => { bullets = all; send() },
      }) : null
      send()
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
      engine = null
      meetingId = null
      prepared = null
      // the call's bullets now live with the meeting (its note page); Home starts clean for the next call
      bullets = []
      send()
    },
    bulletsOf: (id) => finished.get(id) ?? (id === meetingId ? bullets : []),
  }
}

/** Settings' Test button waits at most this long: a server behind a VPN that is off never answers */
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
    if (kind === 'timeout' || kind === 'unreachable') return { ok: false, tools: 0, error: `Couldn't reach the server in ${TEST_TIMEOUT_MS / 1000} s. VPN on?` }
    return { ok: false, tools: 0, error: e instanceof Error ? e.message : String(e) }
  }
}
