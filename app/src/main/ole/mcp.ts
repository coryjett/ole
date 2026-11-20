// Ole: the MCP client, standard Streamable HTTP. The first request runs the handshake (initialize, then the
// notifications/initialized notification); a server that hands back an Mcp-Session-Id gets it on every later
// request, a stateless server (no session id) works the same way without one. Replies may be JSON or SSE.

export type McpErrorKind = 'auth' | 'unreachable' | 'http' | 'rpc' | 'tool' | 'timeout'

export class McpError extends Error {
  constructor(message: string, readonly kind: McpErrorKind, readonly code?: number) {
    super(message)
    this.name = 'McpError'
  }
}

export type McpToolAnnotations = {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}
export type McpTool = { name: string; description?: string; inputSchema?: unknown; annotations?: McpToolAnnotations }
export type McpPrompt = { name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }
export type McpCallOptions = { signal?: AbortSignal; timeoutMs?: number }

export type McpClient = {
  listTools(opts?: McpCallOptions): Promise<McpTool[]>
  callTool(name: string, args?: Record<string, unknown>, opts?: McpCallOptions): Promise<string>
  listPrompts(opts?: McpCallOptions): Promise<McpPrompt[]>
  getPrompt(name: string, args?: Record<string, string>, opts?: McpCallOptions): Promise<string>
}

type RpcMessage = { id?: unknown; result?: unknown; error?: { message?: unknown; code?: unknown } }

export const PROTOCOL_VERSION = '2025-06-18'
export const MAX_TOOLS = 200
export const MAX_PROMPTS = 100
export const PROMPT_CAP = 8000
const METHOD_NOT_FOUND = -32601
const MAX_PAGES = 20
const DEFAULT_TIMEOUT_MS = 30_000

// SSE body: events split on blank lines, each event's data lines joined by newlines
export function parseSse(body: string): unknown[] {
  const messages: unknown[] = []
  for (const event of body.replace(/\r\n?/g, '\n').split(/\n\n+/)) {
    const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.replace(/^data: ?/, ''))
    if (!data.length) continue
    try { messages.push(JSON.parse(data.join('\n'))) } catch { /* keep-alive or partial event */ }
  }
  return messages
}

/** a 404 on a request that carried a session id: the server forgot the session */
class StaleSession extends Error {}

export function createMcpClient({ key, url, version = '0.0.0', fetch = globalThis.fetch }: {
  key?: string | null; url: string; version?: string; fetch?: typeof globalThis.fetch
}): McpClient {
  let nextId = 0
  let sessionId: string | null = null
  let ready: Promise<void> | null = null
  /** the server's capabilities from initialize; null when it sent none */
  let capabilities: Record<string, unknown> | null = null

  async function post(payload: Record<string, unknown>, opts: McpCallOptions, expectReply: boolean): Promise<unknown> {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
    const aborted = () => opts.signal?.aborted
      ? new McpError('MCP request cancelled', 'timeout')
      : timeout.aborted ? new McpError('The MCP server timed out', 'timeout') : null
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    if (key) headers.Authorization = `Bearer ${key}`
    const sentSession = sessionId
    if (sentSession) headers['Mcp-Session-Id'] = sentSession
    if (payload.method !== 'initialize') headers['MCP-Protocol-Version'] = PROTOCOL_VERSION
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...payload }), signal })
    } catch {
      throw aborted() ?? new McpError('MCP server unreachable (VPN?)', 'unreachable')
    }
    if (res.status === 401 || res.status === 403) throw new McpError('The MCP server rejected the key', 'auth')
    if (res.status === 404 && sentSession) throw new StaleSession()
    if (!res.ok) throw new McpError(`MCP server HTTP ${res.status}`, 'http')
    if (payload.method === 'initialize') sessionId = res.headers.get('mcp-session-id') || null
    if (!expectReply) {
      try { await res.text() } catch { /* a notification needs no body */ }
      return undefined
    }

    let body: string
    try { body = await res.text() } catch {
      throw aborted() ?? new McpError('MCP server unreachable (VPN?)', 'unreachable')
    }
    let messages: unknown[]
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) messages = parseSse(body)
    else {
      try {
        const parsed = JSON.parse(body) as unknown
        messages = Array.isArray(parsed) ? parsed : [parsed]
      } catch { messages = [] }
    }
    const reply = messages.find((m): m is RpcMessage => !!m && typeof m === 'object' && (m as RpcMessage).id === payload.id)
    if (!reply) throw new McpError('The MCP server returned no response', 'rpc')
    if (reply.error) {
      const code = typeof reply.error.code === 'number' ? reply.error.code : undefined
      throw new McpError(`MCP server error: ${String(reply.error.message ?? 'unknown')}`, 'rpc', code)
    }
    return reply.result
  }

  function handshake(opts: McpCallOptions): Promise<void> {
    if (!ready) {
      ready = (async () => {
        sessionId = null
        const init = await post({
          id: ++nextId,
          method: 'initialize',
          params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'Ole', version } },
        }, opts, true) as { capabilities?: unknown } | undefined
        const caps = init?.capabilities
        capabilities = caps && typeof caps === 'object' ? caps as Record<string, unknown> : null
        await post({ method: 'notifications/initialized' }, opts, false)
      })()
      // a failed handshake is retried by the next request
      ready.catch(() => { ready = null })
    }
    return ready
  }

  async function rpc(method: string, params: unknown, opts: McpCallOptions = {}): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        await handshake(opts)
        return await post({ id: ++nextId, method, params }, opts, true)
      } catch (err) {
        if (!(err instanceof StaleSession)) throw err
        if (attempt > 0) throw new McpError('MCP server HTTP 404', 'http')
        // re-initialize once
        ready = null
        sessionId = null
      }
    }
  }

  return {
    async listTools(opts) {
      const tools: McpTool[] = []
      let cursor: string | undefined
      for (let page = 0; page < MAX_PAGES && tools.length < MAX_TOOLS; page++) {
        const result = await rpc('tools/list', cursor ? { cursor } : {}, opts) as { tools?: unknown; nextCursor?: unknown } | undefined
        if (Array.isArray(result?.tools)) {
          for (const t of result.tools) {
            if (!t || typeof t !== 'object' || typeof (t as McpTool).name !== 'string') continue
            const { name, description, inputSchema, annotations } = t as McpTool
            const tool: McpTool = { name }
            if (typeof description === 'string') tool.description = description
            if (inputSchema !== undefined) tool.inputSchema = inputSchema
            if (annotations && typeof annotations === 'object') tool.annotations = annotations
            tools.push(tool)
          }
        }
        cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined
        if (!cursor) break
      }
      return tools.slice(0, MAX_TOOLS)
    },
    async callTool(name, args, opts) {
      const result = await rpc('tools/call', { name, arguments: args ?? {} }, opts) as { content?: unknown; isError?: boolean } | undefined
      const content = Array.isArray(result?.content) ? result.content as Array<{ type?: unknown; text?: unknown }> : []
      const text = content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text as string).join('\n')
      if (result?.isError) throw new McpError(text || 'MCP tool failed', 'tool')
      return text
    },
    async listPrompts(opts) {
      await handshake(opts ?? {})
      if (capabilities && !capabilities.prompts) return []
      const prompts: McpPrompt[] = []
      let cursor: string | undefined
      for (let page = 0; page < MAX_PAGES && prompts.length < MAX_PROMPTS; page++) {
        let result: { prompts?: unknown; nextCursor?: unknown } | undefined
        try {
          result = await rpc('prompts/list', cursor ? { cursor } : {}, opts) as typeof result
        } catch (err) {
          if (err instanceof McpError && err.kind === 'rpc' && (err.code === METHOD_NOT_FOUND || /not found/i.test(err.message))) return prompts
          throw err
        }
        if (Array.isArray(result?.prompts)) {
          for (const p of result.prompts) {
            if (!p || typeof p !== 'object' || typeof (p as McpPrompt).name !== 'string') continue
            const { name, description, arguments: args } = p as McpPrompt
            const prompt: McpPrompt = { name }
            if (typeof description === 'string') prompt.description = description
            if (Array.isArray(args)) {
              prompt.arguments = args.filter(a => !!a && typeof a.name === 'string').map(a => ({
                name: a.name,
                ...(typeof a.description === 'string' ? { description: a.description } : {}),
                ...(typeof a.required === 'boolean' ? { required: a.required } : {}),
              }))
            }
            prompts.push(prompt)
          }
        }
        cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined
        if (!cursor) break
      }
      return prompts.slice(0, MAX_PROMPTS)
    },
    async getPrompt(name, args, opts) {
      const result = await rpc('prompts/get', { name, arguments: args ?? {} }, opts) as { messages?: unknown } | undefined
      const messages = Array.isArray(result?.messages) ? result.messages as Array<{ content?: unknown }> : []
      const texts: string[] = []
      for (const m of messages) {
        // content is one block in the spec; accept a list too
        const blocks = Array.isArray(m?.content) ? m.content : [m?.content]
        for (const b of blocks as Array<{ type?: unknown; text?: unknown }>) {
          if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) texts.push(b.text.trim())
        }
      }
      const text = texts.join('\n\n')
      return text.length > PROMPT_CAP ? text.slice(0, PROMPT_CAP) : text
    },
  }
}
