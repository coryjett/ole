import { describe, expect, it, vi } from 'vitest'
import { createMcpClient, McpError, parseSse, PROTOCOL_VERSION } from '../../src/main/ole/core/mcp'

const url = 'https://mcp.test/mcp'
const key = 'super-secret-key'
const fail = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure') }, (e: unknown) => e as McpError)

type Req = { method: string; id?: number; params?: Record<string, unknown>; headers: Record<string, string> }
type Handler = (req: Req) => unknown

/** a fake MCP server: answers initialize itself, routes other methods to handlers, records every request */
function server(handlers: Record<string, Handler>, o: { session?: string | null; sse?: boolean; status?: (req: Req) => number | undefined; capabilities?: unknown } = {}) {
  const requests: Req[] = []
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id?: number; params?: Record<string, unknown> }
    const req: Req = { ...body, headers: { ...(init?.headers as Record<string, string>) } }
    requests.push(req)
    const status = o.status?.(req)
    if (status) return new Response('', { status })
    const headers: Record<string, string> = { 'content-type': o.sse ? 'text/event-stream' : 'application/json' }
    if (body.method === 'initialize') {
      if (o.session) headers['mcp-session-id'] = o.session
      return reply(body.id, { protocolVersion: PROTOCOL_VERSION, capabilities: o.capabilities ?? { tools: {}, prompts: {} }, serverInfo: { name: 's', version: '1' } }, headers, o.sse)
    }
    if (body.id === undefined) return new Response(null, { status: 202 })
    const handler = handlers[body.method]
    if (!handler) return reply(body.id, undefined, headers, o.sse, { code: -32601, message: 'method not found' })
    return reply(body.id, handler(req), headers, o.sse)
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests, mock: fetch }
}

function reply(id: number | undefined, result: unknown, headers: Record<string, string>, sse?: boolean, error?: unknown): Response {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) })
  return new Response(sse ? `event: message\ndata: ${msg}\n\n` : msg, { headers })
}

const text = (t: string) => ({ content: [{ type: 'text', text: t }] })

describe('parseSse', () => {
  it('parses data lines joined by newline', () => {
    expect(parseSse('event: message\ndata: {"a":\ndata: 1}\n\nevent: ping\n')).toEqual([{ a: 1 }])
  })
  it('normalizes crlf and ignores non-data events', () => {
    expect(parseSse('event: message\r\ndata: {"b":2}\r\n\r\nkeepalive\n\n')).toEqual([{ b: 2 }])
  })
})

describe('createMcpClient handshake', () => {
  it('initializes, keeps the session id and sends it on later requests', async () => {
    const s = server({ 'tools/call': () => text('ok') }, { session: 'sess-1', sse: true })
    const client = createMcpClient({ key, url, version: '1.2.3', fetch: s.fetch })

    expect(await client.callTool('get_thing', { id: 'A1' })).toBe('ok')
    expect(await client.callTool('get_thing', { id: 'A2' })).toBe('ok')

    expect(s.requests.map(r => r.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call', 'tools/call'])
    const [init, note, call] = s.requests
    expect(init.params).toEqual({ protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Ole', version: '1.2.3' } })
    expect(init.headers['Mcp-Session-Id']).toBeUndefined()
    expect(note.id).toBeUndefined()
    expect(note.headers['Mcp-Session-Id']).toBe('sess-1')
    expect(call.headers['Mcp-Session-Id']).toBe('sess-1')
    expect(call.headers['MCP-Protocol-Version']).toBe('2025-06-18')
    expect(call.headers.Authorization).toBe(`Bearer ${key}`)
    expect(call.headers.Accept).toContain('application/json')
    expect(call.headers.Accept).toContain('text/event-stream')
    expect(call.params).toEqual({ name: 'get_thing', arguments: { id: 'A1' } })
  })

  it('works with a stateless server that sends no session id, JSON replies', async () => {
    const s = server({ 'tools/call': () => text('json-path') })
    const client = createMcpClient({ key, url, fetch: s.fetch })
    expect(await client.callTool('ping')).toBe('json-path')
    expect(s.requests.every(r => r.headers['Mcp-Session-Id'] === undefined)).toBe(true)
  })

  it('sends no Authorization header without a key', async () => {
    const s = server({ 'tools/call': () => text('ok') })
    const client = createMcpClient({ url, fetch: s.fetch })
    await client.callTool('ping')
    expect(s.requests.every(r => !('Authorization' in r.headers))).toBe(true)
  })

  it('handshakes once for concurrent requests', async () => {
    const s = server({ 'tools/call': () => text('ok') }, { session: 'x' })
    const client = createMcpClient({ key, url, fetch: s.fetch })
    await Promise.all([client.callTool('a'), client.callTool('b'), client.callTool('c')])
    expect(s.requests.filter(r => r.method === 'initialize')).toHaveLength(1)
  })

  it('re-initializes once on a 404 for a stale session', async () => {
    let sessions = 0
    let expired = true
    const requests: Req[] = []
    const fetch = vi.fn(async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const headers = init?.headers as Record<string, string>
      requests.push({ ...body, headers })
      if (body.method === 'initialize') {
        sessions++
        return reply(body.id, {}, { 'content-type': 'application/json', 'mcp-session-id': `s${sessions}` })
      }
      if (body.id === undefined) return new Response(null, { status: 202 })
      if (headers['Mcp-Session-Id'] === 's1' && body.method === 'tools/call' && expired) { expired = false; return new Response('', { status: 404 }) }
      return reply(body.id, text(`via ${headers['Mcp-Session-Id']}`), { 'content-type': 'application/json' })
    })
    const client = createMcpClient({ key, url, fetch: fetch as unknown as typeof globalThis.fetch })
    expect(await client.listTools()).toEqual([])
    expect(await client.callTool('x')).toBe('via s2')
    expect(sessions).toBe(2)
  })

  it('gives up after one re-initialize when the session keeps going stale', async () => {
    const s = server({}, { session: 's', status: r => r.method === 'tools/call' ? 404 : undefined })
    const client = createMcpClient({ key, url, fetch: s.fetch })
    const err = await fail(client.callTool('x'))
    expect(err.kind).toBe('http')
    expect(s.requests.filter(r => r.method === 'initialize')).toHaveLength(2)
  })

  it('retries the handshake on the next request after it failed', async () => {
    let down = true
    const s = server({ 'tools/call': () => text('ok') }, { status: r => r.method === 'initialize' && down ? 500 : undefined })
    const client = createMcpClient({ key, url, fetch: s.fetch })
    expect((await fail(client.callTool('x'))).kind).toBe('http')
    down = false
    expect(await client.callTool('x')).toBe('ok')
  })
})

describe('listTools', () => {
  it('follows nextCursor pages and returns annotations', async () => {
    const s = server({
      'tools/list': r => r.params?.cursor === 'p2'
        ? { tools: [{ name: 'c', annotations: { readOnlyHint: true } }] }
        : { tools: [{ name: 'a', description: 'A', inputSchema: { type: 'object' } }, { description: 'no name' }], nextCursor: 'p2' },
    }, { sse: true })
    const client = createMcpClient({ key, url, fetch: s.fetch })
    expect(await client.listTools()).toEqual([
      { name: 'a', description: 'A', inputSchema: { type: 'object' } },
      { name: 'c', annotations: { readOnlyHint: true } },
    ])
    const lists = s.requests.filter(r => r.method === 'tools/list')
    expect(lists.map(r => r.params)).toEqual([{}, { cursor: 'p2' }])
  })

  it('caps at 200 tools even when the server keeps paging', async () => {
    let page = 0
    const s = server({ 'tools/list': () => ({ tools: Array.from({ length: 30 }, (_, i) => ({ name: `t${page}_${i}` })), nextCursor: `p${++page}` }) })
    const client = createMcpClient({ key, url, fetch: s.fetch })
    const tools = await client.listTools()
    expect(tools).toHaveLength(200)
    expect(s.requests.filter(r => r.method === 'tools/list')).toHaveLength(7)
  })
})

describe('errors', () => {
  it('401 gives auth error without leaking the key', async () => {
    const s = server({}, { status: () => 401 })
    const err = await fail(createMcpClient({ key, url, fetch: s.fetch }).callTool('x'))
    expect(err).toBeInstanceOf(McpError)
    expect(err.kind).toBe('auth')
    expect(err.message).toBe('The MCP server rejected the key')
    expect(err.message).not.toContain(key)
  })

  it('fetch TypeError gives unreachable', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('network down') })
    const err = await fail(createMcpClient({ key, url, fetch: fetch as unknown as typeof globalThis.fetch }).callTool('x'))
    expect(err.kind).toBe('unreachable')
    expect(err.message).toBe('MCP server unreachable')
  })

  it('isError result throws tool error with text', async () => {
    const s = server({ 'tools/call': () => ({ ...text('bad input'), isError: true }) }, { sse: true })
    const err = await fail(createMcpClient({ key, url, fetch: s.fetch }).callTool('x'))
    expect(err.kind).toBe('tool')
    expect(err.message).toBe('bad input')
  })

  it('JSON-RPC error gives rpc kind', async () => {
    const s = server({}, { sse: true })
    const err = await fail(createMcpClient({ key, url, fetch: s.fetch }).callTool('x'))
    expect(err.kind).toBe('rpc')
    expect(err.message).toContain('method not found')
  })

  it('timeout gives timeout kind', async () => {
    const fetch = vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_r, reject) => {
      const signal = init?.signal as AbortSignal
      signal.addEventListener('abort', () => reject(signal.reason))
    }))
    const err = await fail(createMcpClient({ key, url, fetch: fetch as unknown as typeof globalThis.fetch }).callTool('x', {}, { timeoutMs: 20 }))
    expect(err.kind).toBe('timeout')
    expect(err.message).toBe('The MCP server timed out')
  })
})

describe('prompts', () => {
  it('listPrompts follows pages and keeps arguments', async () => {
    const s = server({
      'prompts/list': r => r.params?.cursor
        ? { prompts: [{ name: 'b' }] }
        : { prompts: [{ name: 'prepare_for_meeting', description: 'd', arguments: [{ name: 'focus', required: false }, { bad: 1 }] }, { nope: 1 }], nextCursor: 'n' },
    })
    const client = createMcpClient({ key, url, fetch: s.fetch })
    expect(await client.listPrompts()).toEqual([
      { name: 'prepare_for_meeting', description: 'd', arguments: [{ name: 'focus', required: false }] },
      { name: 'b' },
    ])
  })

  it('listPrompts is empty for a server without the prompts capability, without asking', async () => {
    const s = server({}, { capabilities: { tools: {} } })
    const client = createMcpClient({ key, url, fetch: s.fetch })
    expect(await client.listPrompts()).toEqual([])
    expect(s.requests.some(r => r.method === 'prompts/list')).toBe(false)
  })

  it('listPrompts is empty when the server answers method-not-found', async () => {
    const s = server({})
    const client = createMcpClient({ key, url, fetch: s.fetch })
    expect(await client.listPrompts()).toEqual([])
    expect(s.requests.some(r => r.method === 'prompts/list')).toBe(true)
  })

  it('listPrompts caps at 100', async () => {
    let page = 0
    const s = server({ 'prompts/list': () => ({ prompts: Array.from({ length: 40 }, (_, i) => ({ name: `p${page}_${i}` })), nextCursor: `c${++page}` }) })
    expect(await createMcpClient({ key, url, fetch: s.fetch }).listPrompts()).toHaveLength(100)
  })

  it('getPrompt sends the arguments and joins message texts with blank lines, capped', async () => {
    const s = server({
      'prompts/get': r => r.params?.name === 'long'
        ? { messages: [{ role: 'user', content: { type: 'text', text: 'z'.repeat(9000) } }] }
        : { messages: [
          { role: 'user', content: { type: 'text', text: 'First.' } },
          { role: 'assistant', content: { type: 'image', data: 'x' } },
          { role: 'user', content: { type: 'text', text: 'Second.' } },
        ] },
    })
    const client = createMcpClient({ key, url, fetch: s.fetch })
    expect(await client.getPrompt('prepare_for_meeting', { focus: 'pricing' })).toBe('First.\n\nSecond.')
    expect(s.requests.find(r => r.method === 'prompts/get')?.params).toEqual({ name: 'prepare_for_meeting', arguments: { focus: 'pricing' } })
    expect(await client.getPrompt('long')).toHaveLength(8000)
  })
})
