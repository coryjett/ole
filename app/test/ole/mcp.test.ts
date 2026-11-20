import { describe, expect, it, vi } from 'vitest'
import { createMcpClient, McpError, parseSse } from '../../src/main/ole/mcp'

const url = 'https://mcp.test/mcp'
const fail = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure') }, (e: unknown) => e as McpError)
const key = 'super-secret-key'

function sseResponse(result: unknown): Response {
  const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}\n\n`
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

function jsonResponse(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'content-type': 'application/json' } })
}

describe('parseSse', () => {
  it('parses data lines joined by newline', () => {
    const raw = 'event: message\ndata: {"a":\ndata: 1}\n\nevent: ping\n'
    expect(parseSse(raw)).toEqual([{ a: 1 }])
  })

  it('normalizes crlf and ignores non-data events', () => {
    const raw = 'event: message\r\ndata: {"b":2}\r\n\r\nkeepalive\n\n'
    expect(parseSse(raw)).toEqual([{ b: 2 }])
  })
})

describe('createMcpClient', () => {
  it('POSTs tools/call with auth headers and reads id from request body over SSE', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body)) as { jsonrpc: string; id: number }
      return new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { content: [{ type: 'text', text: 'ok' }] } })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const client = createMcpClient({ key, url, fetch: fetchMock as unknown as typeof globalThis.fetch })

    expect(await client.callTool('get_account_details', { account_id: 'A1' })).toBe('ok')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0]
    expect(call[0]).toBe(url)
    const init = call[1] as RequestInit
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${key}`)
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers.Accept).toContain('application/json')
    expect(headers.Accept).toContain('text/event-stream')
    const body = JSON.parse(String(init.body)) as { jsonrpc: string; method: string; params: unknown }
    expect(body.jsonrpc).toBe('2.0')
    expect(body.method).toBe('tools/call')
    expect(body.params).toEqual({ name: 'get_account_details', arguments: { account_id: 'A1' } })
  })

  it('handles JSON response path', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ content: [{ type: 'text', text: 'json-path' }] }))
    const client = createMcpClient({ key, url, fetch: fetchMock as unknown as typeof globalThis.fetch })
    expect(await client.callTool('ping')).toBe('json-path')
  })

  it('listTools returns tools with names', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body)) as { id: number }
      return new Response(
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { tools: [{ name: 'a' }, { description: 'no name' }] } })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const client = createMcpClient({ key, url, fetch: fetchMock as unknown as typeof globalThis.fetch })
    const tools = await client.listTools()
    expect(tools).toEqual([{ name: 'a' }])
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toContain('tools/list')
  })

  it('401 gives auth error without leaking the key', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('', { status: 401 }))
    const client = createMcpClient({ key, url, fetch: fetchMock as unknown as typeof globalThis.fetch })
    const err = await fail(client.callTool('x'))
    expect(err).toBeInstanceOf(McpError)
    expect(err.kind).toBe('auth')
    expect(err.message).toBe('The MCP server rejected the key')
    expect(err.message).not.toContain(key)
  })

  it('fetch TypeError gives unreachable', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('network down') })
    const client = createMcpClient({ key, url, fetch: fetchMock as unknown as typeof globalThis.fetch })
    const err = await fail(client.callTool('x'))
    expect(err).toBeInstanceOf(McpError)
    expect(err.kind).toBe('unreachable')
    expect(err.message).toBe('MCP server unreachable (VPN?)')
  })

  it('isError result throws tool error with text', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => sseResponse({ content: [{ type: 'text', text: 'bad input' }], isError: true }))
    const client = createMcpClient({ key, url, fetch: fetchMock as unknown as typeof globalThis.fetch })
    const err = await fail(client.callTool('x'))
    expect(err).toBeInstanceOf(McpError)
    expect(err.kind).toBe('tool')
    expect(err.message).toBe('bad input')
  })

  it('JSON-RPC error gives rpc kind', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body)) as { id: number }
      return new Response(
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { message: 'nope' } })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const client = createMcpClient({ key, url, fetch: fetchMock as unknown as typeof globalThis.fetch })
    const err = await fail(client.callTool('x'))
    expect(err).toBeInstanceOf(McpError)
    expect(err.kind).toBe('rpc')
    expect(err.message).toContain('nope')
  })

  it('timeout gives timeout kind', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const signal = (init as RequestInit)?.signal as AbortSignal | undefined
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) return reject(new Error('no signal'))
        signal.addEventListener('abort', () => reject(signal.reason))
      })
    })
    const client = createMcpClient({ key, url, fetch: fetchMock as unknown as typeof globalThis.fetch })
    const err = await fail(client.callTool('x', {}, { timeoutMs: 20 }))
    expect(err).toBeInstanceOf(McpError)
    expect(err.kind).toBe('timeout')
  })
})
