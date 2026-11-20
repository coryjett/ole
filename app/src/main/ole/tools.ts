// Ole: the tools the model may call. Every enabled MCP server's read-only tools, named `<serverId>__<tool>` for
// OpenAI function calling, and a runner that maps a model's call back to the right server.
import type { McpServerConfig, OleTool } from './types'
import { McpError, type McpCallOptions, type McpClient, type McpTool } from './mcp'

export type ToolServer = { config: McpServerConfig; client: McpClient }
export type ToolRunner = { call(name: string, argsJson: string, opts?: McpCallOptions): Promise<string> }

export const MAX_TOOLS = 128
export const DESCRIPTION_CAP = 300
export const RESULT_CAP = 6000
const NAME_CAP = 64
const LIST_TIMEOUT_MS = 15_000
const CALL_TIMEOUT_MS = 20_000

const READ_PREFIXES = ['get_', 'list_', 'search_', 'find_', 'read_', 'query_', 'fetch_', 'lookup_', 'describe_']
const READ_WORDS = new Set(['get', 'list', 'search'])
/** a name with any of these words is never read-only by its name alone (get_and_delete_x, list_then_send) */
const WRITE_WORDS = /(^|[_-])(create|update|delete|remove|add|set|send|share|write|reset|post|put|patch|close|reopen|complete|link|unlink|resolve|upload|move|archive|approve|assign|cancel|invite|merge|publish|submit|sync|run|execute|trigger)([_-]|$)/
/** a tool's input schema larger than this (as JSON) or nested deeper is dropped with its tool */
export const SCHEMA_MAX_CHARS = 8000
export const SCHEMA_MAX_DEPTH = 8

/** FNV-1a, 32 bit, as 8 hex chars: a short stable suffix */
function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')

/** `<serverId>__<tool>` with only [A-Za-z0-9_-], at most 64 chars; a truncated name ends in a hash of the full one */
export function toolName(serverId: string, tool: string): string {
  const raw = `${serverId}__${tool}`
  const clean = sanitize(raw)
  if (clean.length <= NAME_CAP) return clean
  return `${clean.slice(0, NAME_CAP - 9)}_${hash(raw)}`
}

/** a tool the model may call without asking: the server says read-only, or it is named like a read and not marked destructive */
const depthOf = (v: unknown, d = 0): number =>
  d > SCHEMA_MAX_DEPTH ? d : v && typeof v === 'object' ? Math.max(d, ...Object.values(v as object).map(x => depthOf(x, d + 1))) : d

/** a schema small and shallow enough to hand the model; anything else drops the tool */
export function boundedSchema(schema: unknown): Record<string, unknown> | null {
  if (!isObject(schema)) return { type: 'object', properties: {} }
  let json: string
  try { json = JSON.stringify(schema) } catch { return null }
  if (json.length > SCHEMA_MAX_CHARS || depthOf(schema) > SCHEMA_MAX_DEPTH) return null
  return schema
}

export function isReadOnly(tool: Pick<McpTool, 'name' | 'annotations'>): boolean {
  if (tool.annotations?.readOnlyHint === true) return true
  if (tool.annotations?.destructiveHint === true) return false
  const name = tool.name.toLowerCase()
  if (WRITE_WORDS.test(name)) return false
  return READ_WORDS.has(name) || READ_PREFIXES.some(p => name.startsWith(p))
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** the read-only tools of every enabled server; a server that fails to list is skipped */
/** an enabled server Ole couldn't use, and why in a few words (#33) */
export type Unavailable = { name: string; reason: string }

export const unavailableReason = (e: unknown): string => {
  const kind = e instanceof McpError ? e.kind : null
  if (kind === 'auth') return 'key rejected'
  if (kind === 'timeout') return 'timed out'
  if (kind === 'unreachable') return "couldn't be reached"
  return (e instanceof Error ? e.message : String(e)).slice(0, 120)
}

export async function collectTools(servers: ToolServer[], onUnavailable?: (u: Unavailable) => void): Promise<OleTool[]> {
  const enabled = servers.filter(s => s.config.enabled)
  // a server that fails is skipped, but never silently: the caller hears which and why (#33)
  const listed = await Promise.all(enabled.map(s => s.client.listTools({ timeoutMs: LIST_TIMEOUT_MS }).catch((e: unknown) => { onUnavailable?.({ name: s.config.name, reason: unavailableReason(e) }); return [] as McpTool[] })))
  const out: OleTool[] = []
  const taken = new Set<string>()
  enabled.forEach((s, i) => {
    for (const t of listed[i]) {
      if (out.length >= MAX_TOOLS) return
      if (!isReadOnly(t)) continue
      let name = toolName(s.config.id, t.name)
      // two tools that sanitize to the same name: the later one gets a hash suffix
      if (taken.has(name)) name = `${name.slice(0, NAME_CAP - 9)}_${hash(`${s.config.id}\0${t.name}`)}`
      if (taken.has(name)) continue
      taken.add(name)
      const parameters = boundedSchema(t.inputSchema)
      if (!parameters) continue
      const description = `[${s.config.name}] ${t.description?.trim() ?? ''}`.trim().slice(0, DESCRIPTION_CAP)
      out.push({
        name,
        serverId: s.config.id,
        serverName: s.config.name,
        tool: t.name,
        description,
        parameters,
      })
    }
  })
  return out
}

/** the tools in OpenAI's function-calling shape */
export function toOpenAiTools(tools: OleTool[]): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
}

const trimResult = (s: string) => s.length > RESULT_CAP ? `${s.slice(0, RESULT_CAP)}\n[truncated]` : s

/** runs a model's tool call against its server; every failure comes back as text the model can read */
export function createToolRunner(servers: ToolServer[], tools: OleTool[]): ToolRunner {
  const byName = new Map(tools.map(t => [t.name, t]))
  const clients = new Map(servers.map(s => [s.config.id, s.client]))
  return {
    async call(name, argsJson, opts) {
      const tool = byName.get(name)
      if (!tool) return `error: unknown tool ${name}`
      const client = clients.get(tool.serverId)
      if (!client) return `error: the server for ${name} is not connected`
      let args: unknown
      try { args = argsJson?.trim() ? JSON.parse(argsJson) : {} } catch { return 'error: the arguments are not valid JSON' }
      if (!isObject(args)) return 'error: the arguments must be a JSON object'
      try {
        const text = await client.callTool(tool.tool, args, { timeoutMs: CALL_TIMEOUT_MS, ...opts })
        return trimResult(text || '(empty result)')
      } catch (err) {
        return `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500)
      }
    },
  }
}

/** the MCP prompt a server can offer to steer the warm-up */
export const WARMUP_PROMPT = 'prepare_for_meeting'
export type WarmupPrompt = { serverId?: string; serverName: string; text: string }

/** each enabled server's WARMUP_PROMPT, filled with the arguments it declares; a server without one or that fails is skipped */
export async function collectWarmupPrompts(servers: ToolServer[], o: { meetingTitle: string | null; focus: string | null }): Promise<WarmupPrompt[]> {
  const known: Record<string, string | null> = { meeting_title: o.meetingTitle, focus: o.focus }
  const found = await Promise.all(servers.filter(s => s.config.enabled).map(async (s): Promise<WarmupPrompt | null> => {
    try {
      const prompt = (await s.client.listPrompts({ timeoutMs: LIST_TIMEOUT_MS })).find(p => p.name === WARMUP_PROMPT)
      if (!prompt) return null
      const args: Record<string, string> = {}
      for (const a of prompt.arguments ?? []) {
        const value = known[a.name]
        if (value) args[a.name] = value
        else if (a.required) args[a.name] = ''
      }
      const text = (await s.client.getPrompt(WARMUP_PROMPT, args, { timeoutMs: LIST_TIMEOUT_MS })).trim()
      return text ? { serverId: s.config.id, serverName: s.config.name, text } : null
    } catch {
      return null
    }
  }))
  return found.filter((p): p is WarmupPrompt => !!p)
}

/** the meta-tool Prepare offers when it starts with a server's short list: the rest of the read-only tools (#15) */
export const MORE_TOOLS = 'more_tools'
export const MORE_TOOLS_DEF = {
  type: 'function' as const,
  function: {
    name: MORE_TOOLS,
    description: "Add the MCP servers' other read-only tools when the ones offered are not enough for the briefing. Takes no arguments.",
    parameters: { type: 'object', properties: {} },
  },
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Prepare's first tools (#15): a server whose prepare_for_meeting prompt names some of its tools offers only those;
 * a server without a prompt, or whose prompt names none, offers all of its read-only tools. `rest` is what more_tools adds.
 */
export function narrowForPrepare(tools: OleTool[], prompts: WarmupPrompt[] = []): { first: OleTool[]; rest: OleTool[] } {
  const first: OleTool[] = [], rest: OleTool[] = []
  const byServer = new Map<string, OleTool[]>()
  for (const t of tools) byServer.set(t.serverId, [...(byServer.get(t.serverId) ?? []), t])
  for (const [serverId, list] of byServer) {
    const text = prompts.filter(p => p.serverId === serverId || (!p.serverId && p.serverName === list[0].serverName)).map(p => p.text).join('\n')
    const named = text ? list.filter(t => new RegExp(`(^|[^A-Za-z0-9_])${escape(t.tool)}([^A-Za-z0-9_]|$)`).test(text)) : []
    if (named.length) { first.push(...named); rest.push(...list.filter(t => !named.includes(t))) }
    else first.push(...list)
  }
  return { first, rest }
}

/** the lookup-style tools live bullets may call (#15): a name rule, so a new search or get tool is included by itself */
export const isLiveTool = (t: Pick<OleTool, 'tool'>) => /^(search|get|find|lookup|list)(_|$)/i.test(t.tool)
