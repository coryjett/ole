// Ole: the tools the model may call. Every enabled MCP server's read-only tools, named `<serverId>__<tool>` for
// OpenAI function calling, and a runner that maps a model's call back to the right server.
import type { McpServerConfig, OleTool } from './types'
import type { McpCallOptions, McpClient, McpTool } from './mcp'

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
export function isReadOnly(tool: Pick<McpTool, 'name' | 'annotations'>): boolean {
  if (tool.annotations?.readOnlyHint === true) return true
  if (tool.annotations?.destructiveHint === true) return false
  const name = tool.name.toLowerCase()
  return READ_WORDS.has(name) || READ_PREFIXES.some(p => name.startsWith(p))
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** the read-only tools of every enabled server; a server that fails to list is skipped */
export async function collectTools(servers: ToolServer[]): Promise<OleTool[]> {
  const enabled = servers.filter(s => s.config.enabled)
  const listed = await Promise.all(enabled.map(s => s.client.listTools({ timeoutMs: LIST_TIMEOUT_MS }).catch(() => [] as McpTool[])))
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
      const description = `[${s.config.name}] ${t.description?.trim() ?? ''}`.trim().slice(0, DESCRIPTION_CAP)
      out.push({
        name,
        serverId: s.config.id,
        serverName: s.config.name,
        tool: t.name,
        description,
        parameters: isObject(t.inputSchema) ? t.inputSchema : { type: 'object', properties: {} },
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
export type WarmupPrompt = { serverName: string; text: string }

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
      return text ? { serverName: s.config.name, text } : null
    } catch {
      return null
    }
  }))
  return found.filter((p): p is WarmupPrompt => !!p)
}
