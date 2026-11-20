// Ole: the MCP client. The server's /mcp is a stateless Streamable HTTP server (MCP SDK transport with
// no session id), so every POST stands alone: no initialize, no Mcp-Session-Id. Replies are SSE by default.


export type McpErrorKind = 'auth' | 'unreachable' | 'http' | 'rpc' | 'tool' | 'timeout'

export class McpError extends Error {
  constructor(message: string, readonly kind: McpErrorKind) {
    super(message)
    this.name = 'McpError'
  }
}

export type McpTool = { name: string; description?: string; inputSchema?: unknown }
export type McpCallOptions = { signal?: AbortSignal; timeoutMs?: number }

export type McpClient = {
  listTools(opts?: McpCallOptions): Promise<McpTool[]>
  callTool(name: string, args?: Record<string, unknown>, opts?: McpCallOptions): Promise<string>
}

type RpcMessage = { id?: unknown; result?: unknown; error?: { message?: unknown } }

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

export function createMcpClient({ key, url, fetch = globalThis.fetch }: {
  key: string; url: string; fetch?: typeof globalThis.fetch
}): McpClient {
  let nextId = 0

  async function rpc(method: string, params: unknown, opts: McpCallOptions = {}): Promise<unknown> {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
    const aborted = () => opts.signal?.aborted
      ? new McpError('MCP request cancelled', 'timeout')
      : timeout.aborted ? new McpError('The MCP server timed out', 'timeout') : null
    const id = ++nextId
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal,
      })
    } catch {
      throw aborted() ?? new McpError('MCP server unreachable (VPN?)', 'unreachable')
    }
    if (res.status === 401 || res.status === 403) throw new McpError('The MCP server rejected the key', 'auth')
    if (!res.ok) throw new McpError(`MCP server HTTP ${res.status}`, 'http')

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
    const reply = messages.find((m): m is RpcMessage => !!m && typeof m === 'object' && (m as RpcMessage).id === id)
    if (!reply) throw new McpError('The MCP server returned no response', 'rpc')
    if (reply.error) throw new McpError(`MCP server error: ${String(reply.error.message ?? 'unknown')}`, 'rpc')
    return reply.result
  }

  return {
    async listTools(opts) {
      const result = await rpc('tools/list', {}, opts) as { tools?: unknown } | undefined
      if (!Array.isArray(result?.tools)) return []
      return result.tools.filter((t): t is McpTool => !!t && typeof (t as McpTool).name === 'string')
    },
    async callTool(name, args, opts) {
      const result = await rpc('tools/call', { name, arguments: args ?? {} }, opts) as { content?: unknown; isError?: boolean } | undefined
      const content = Array.isArray(result?.content) ? result.content as Array<{ type?: unknown; text?: unknown }> : []
      const text = content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text as string).join('\n')
      if (result?.isError) throw new McpError(text || 'MCP tool failed', 'tool')
      return text
    },
  }
}
