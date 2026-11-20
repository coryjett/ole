// Ole: Siesta MCP client. Siesta's /mcp is a stateless Streamable HTTP server (MCP SDK transport with
// no session id), so every POST stands alone: no initialize, no Mcp-Session-Id. Replies are SSE by default.

export const SIESTA_MCP_URL = 'https://siesta.fe.solo.io/mcp'

export type SiestaErrorKind = 'auth' | 'unreachable' | 'http' | 'rpc' | 'tool' | 'timeout'

export class SiestaError extends Error {
  constructor(message: string, readonly kind: SiestaErrorKind) {
    super(message)
    this.name = 'SiestaError'
  }
}

export type SiestaTool = { name: string; description?: string; inputSchema?: unknown }
export type SiestaCallOptions = { signal?: AbortSignal; timeoutMs?: number }

export type SiestaClient = {
  listTools(opts?: SiestaCallOptions): Promise<SiestaTool[]>
  callTool(name: string, args?: Record<string, unknown>, opts?: SiestaCallOptions): Promise<string>
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

export function createSiestaClient({ key, url = SIESTA_MCP_URL, fetch = globalThis.fetch }: {
  key: string; url?: string; fetch?: typeof globalThis.fetch
}): SiestaClient {
  let nextId = 0

  async function rpc(method: string, params: unknown, opts: SiestaCallOptions = {}): Promise<unknown> {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
    const aborted = () => opts.signal?.aborted
      ? new SiestaError('Siesta request cancelled', 'timeout')
      : timeout.aborted ? new SiestaError('Siesta timed out', 'timeout') : null
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
      throw aborted() ?? new SiestaError('Siesta unreachable (VPN?)', 'unreachable')
    }
    if (res.status === 401 || res.status === 403) throw new SiestaError('Siesta rejected the key', 'auth')
    if (!res.ok) throw new SiestaError(`Siesta HTTP ${res.status}`, 'http')

    let body: string
    try { body = await res.text() } catch {
      throw aborted() ?? new SiestaError('Siesta unreachable (VPN?)', 'unreachable')
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
    if (!reply) throw new SiestaError('Siesta returned no response', 'rpc')
    if (reply.error) throw new SiestaError(`Siesta error: ${String(reply.error.message ?? 'unknown')}`, 'rpc')
    return reply.result
  }

  return {
    async listTools(opts) {
      const result = await rpc('tools/list', {}, opts) as { tools?: unknown } | undefined
      if (!Array.isArray(result?.tools)) return []
      return result.tools.filter((t): t is SiestaTool => !!t && typeof (t as SiestaTool).name === 'string')
    },
    async callTool(name, args, opts) {
      const result = await rpc('tools/call', { name, arguments: args ?? {} }, opts) as { content?: unknown; isError?: boolean } | undefined
      const content = Array.isArray(result?.content) ? result.content as Array<{ type?: unknown; text?: unknown }> : []
      const text = content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text as string).join('\n')
      if (result?.isError) throw new SiestaError(text || 'Siesta tool failed', 'tool')
      return text
    },
  }
}
