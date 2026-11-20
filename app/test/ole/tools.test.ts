import { describe, expect, it, vi } from 'vitest'
import { collectTools, collectWarmupPrompts, createToolRunner, WARMUP_PROMPT, isReadOnly, MAX_TOOLS, RESULT_CAP, toolName, toOpenAiTools, type ToolServer } from '../../src/main/ole/tools'
import { McpError, type McpClient, type McpPrompt, type McpTool } from '../../src/main/ole/mcp'
import type { McpServerConfig } from '../../src/main/ole/types'

const cfg = (id: string, name = id, enabled = true): McpServerConfig => ({ id, name, url: `https://${id}.test/mcp`, enabled })

function client(tools: McpTool[] | Error, call: (name: string, args?: Record<string, unknown>) => string | Promise<string> = () => 'ok'): McpClient {
  return {
    listTools: vi.fn(async () => { if (tools instanceof Error) throw tools; return tools }),
    callTool: vi.fn(async (name: string, args?: Record<string, unknown>) => call(name, args)),
    listPrompts: vi.fn(async () => []),
    getPrompt: vi.fn(async () => ''),
  }
}

describe('toolName', () => {
  it('joins server id and tool with a double underscore', () => {
    expect(toolName('crm', 'get_account')).toBe('crm__get_account')
  })
  it('replaces characters outside [A-Za-z0-9_-]', () => {
    expect(toolName('my.server', 'tools/get thing')).toBe('my_server__tools_get_thing')
  })
  it('truncates to 64 with a stable hash suffix, unique per full name', () => {
    const long = 'x'.repeat(80)
    const a = toolName('srv', `${long}_a`)
    const b = toolName('srv', `${long}_b`)
    expect(a).toHaveLength(64)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a).not.toBe(b)
    expect(toolName('srv', `${long}_a`)).toBe(a)
  })
})

describe('isReadOnly', () => {
  it('trusts readOnlyHint', () => {
    expect(isReadOnly({ name: 'create_thing', annotations: { readOnlyHint: true } })).toBe(true)
  })
  it('accepts read-like names', () => {
    for (const name of ['get_x', 'list_x', 'search_x', 'find_x', 'read_x', 'query_x', 'fetch_x', 'lookup_x', 'describe_x', 'get', 'list', 'search', 'Get_Thing'])
      expect(isReadOnly({ name }), name).toBe(true)
  })
  it('rejects write-like names and destructive reads', () => {
    for (const name of ['create_x', 'update_x', 'delete_x', 'add_note', 'getter', 'listen'])
      expect(isReadOnly({ name }), name).toBe(false)
    expect(isReadOnly({ name: 'get_and_purge', annotations: { destructiveHint: true } })).toBe(false)
  })
})

describe('collectTools', () => {
  it('keeps only read-only tools of enabled servers, names, prefixes and defaults parameters', async () => {
    const servers: ToolServer[] = [
      { config: cfg('crm', 'CRM'), client: client([
        { name: 'get_account', description: 'An account', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
        { name: 'delete_account' },
        { name: 'list_x' },
      ]) },
      { config: cfg('off', 'Off', false), client: client([{ name: 'get_y' }]) },
    ]
    const tools = await collectTools(servers)
    expect(tools).toEqual([
      { name: 'crm__get_account', serverId: 'crm', serverName: 'CRM', tool: 'get_account', description: '[CRM] An account', parameters: { type: 'object', properties: { id: { type: 'string' } } } },
      { name: 'crm__list_x', serverId: 'crm', serverName: 'CRM', tool: 'list_x', description: '[CRM]', parameters: { type: 'object', properties: {} } },
    ])
    expect(servers[1].client.listTools).not.toHaveBeenCalled()
  })

  it('skips a failing server and keeps the others', async () => {
    const tools = await collectTools([
      { config: cfg('bad'), client: client(new McpError('MCP server unreachable (VPN?)', 'unreachable')) },
      { config: cfg('good'), client: client([{ name: 'get_z' }]) },
    ])
    expect(tools.map(t => t.name)).toEqual(['good__get_z'])
  })

  it('trims descriptions to 300 and caps the total at 128', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ name: `get_${i}`, description: 'd'.repeat(500) }))
    const tools = await collectTools([{ config: cfg('a'), client: client(many) }, { config: cfg('b'), client: client(many) }])
    expect(tools).toHaveLength(MAX_TOOLS)
    expect(tools[0].description).toHaveLength(300)
    expect(new Set(tools.map(t => t.name)).size).toBe(MAX_TOOLS)
  })

  it('keeps names unique when two tools sanitize to the same name', async () => {
    const tools = await collectTools([{ config: cfg('s'), client: client([{ name: 'get_x.y' }, { name: 'get_x_y' }]) }])
    expect(tools).toHaveLength(2)
    expect(tools[0].name).toBe('s__get_x_y')
    expect(tools[1].name).not.toBe('s__get_x_y')
    expect(tools[1].name).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })

  it('maps to the OpenAI function shape', async () => {
    const tools = await collectTools([{ config: cfg('s'), client: client([{ name: 'get_x', description: 'X' }]) }])
    expect(toOpenAiTools(tools)).toEqual([{ type: 'function', function: { name: 's__get_x', description: '[s] X', parameters: { type: 'object', properties: {} } } }])
  })
})

describe('createToolRunner', () => {
  const setup = async (call?: (name: string, args?: Record<string, unknown>) => string | Promise<string>) => {
    const a = client([{ name: 'get_a' }], call)
    const b = client([{ name: 'get_b' }], call)
    const servers: ToolServer[] = [{ config: cfg('a'), client: a }, { config: cfg('b'), client: b }]
    const tools = await collectTools(servers)
    return { a, b, runner: createToolRunner(servers, tools) }
  }

  it('calls the right server with the original tool name and parsed args', async () => {
    const { a, b, runner } = await setup((name, args) => `${name}:${JSON.stringify(args)}`)
    expect(await runner.call('b__get_b', '{"q":"x"}')).toBe('get_b:{"q":"x"}')
    expect(b.callTool).toHaveBeenCalledWith('get_b', { q: 'x' }, expect.objectContaining({ timeoutMs: expect.any(Number) }))
    expect(a.callTool).not.toHaveBeenCalled()
  })

  it('refuses tools it was not given', async () => {
    const { a, b, runner } = await setup()
    expect(await runner.call('a__delete_everything', '{}')).toMatch(/unknown tool/)
    expect(a.callTool).not.toHaveBeenCalled()
    expect(b.callTool).not.toHaveBeenCalled()
  })

  it('returns an error string for bad JSON or non-object args', async () => {
    const { runner } = await setup()
    expect(await runner.call('a__get_a', '{nope')).toMatch(/^error: .*JSON/)
    expect(await runner.call('a__get_a', '[1]')).toMatch(/^error:/)
    expect(await runner.call('a__get_a', '')).toBe('ok')
  })

  it('returns tool errors as text and trims long results', async () => {
    const { runner } = await setup(name => {
      if (name === 'get_a') throw new McpError('bad input', 'tool')
      return 'y'.repeat(RESULT_CAP + 500)
    })
    expect(await runner.call('a__get_a', '{}')).toBe('error: bad input')
    const long = await runner.call('b__get_b', '{}')
    expect(long.startsWith('y'.repeat(RESULT_CAP))).toBe(true)
    expect(long.length).toBeLessThan(RESULT_CAP + 20)
  })
})

describe('collectWarmupPrompts', () => {
  const withPrompt = (prompts: McpPrompt[] | Error, text = 'Look up the account first.') => {
    const c = client([])
    c.listPrompts = vi.fn(async () => { if (prompts instanceof Error) throw prompts; return prompts })
    c.getPrompt = vi.fn(async () => text)
    return c
  }

  it('fills only the declared arguments, mapping meeting_title and focus', async () => {
    const a = withPrompt([{ name: WARMUP_PROMPT, arguments: [{ name: 'meeting_title' }, { name: 'focus', required: true }] }], 'A says hi')
    const b = withPrompt([{ name: WARMUP_PROMPT, arguments: [{ name: 'focus' }] }], 'B says hi')
    const out = await collectWarmupPrompts(
      [{ config: cfg('a', 'Alpha'), client: a }, { config: cfg('b', 'Beta'), client: b }],
      { meetingTitle: 'Acme sync', focus: null },
    )
    expect(a.getPrompt).toHaveBeenCalledWith(WARMUP_PROMPT, { meeting_title: 'Acme sync', focus: '' }, expect.anything())
    expect(b.getPrompt).toHaveBeenCalledWith(WARMUP_PROMPT, {}, expect.anything())
    expect(out).toEqual([{ serverName: 'Alpha', text: 'A says hi' }, { serverName: 'Beta', text: 'B says hi' }])
  })

  it('passes an empty string for a required argument it cannot fill and skips unknown optional ones', async () => {
    const a = withPrompt([{ name: WARMUP_PROMPT, arguments: [{ name: 'account_id', required: true }, { name: 'region' }, { name: 'focus' }] }])
    await collectWarmupPrompts([{ config: cfg('a'), client: a }], { meetingTitle: null, focus: 'pricing' })
    expect(a.getPrompt).toHaveBeenCalledWith(WARMUP_PROMPT, { account_id: '', focus: 'pricing' }, expect.anything())
  })

  it('skips servers without the prompt, failing servers and disabled servers', async () => {
    const none = withPrompt([{ name: 'something_else' }])
    const broken = withPrompt(new McpError('MCP server unreachable (VPN?)', 'unreachable'))
    const off = withPrompt([{ name: WARMUP_PROMPT }])
    const good = withPrompt([{ name: WARMUP_PROMPT }], 'ok')
    const out = await collectWarmupPrompts([
      { config: cfg('n'), client: none },
      { config: cfg('x'), client: broken },
      { config: cfg('o', 'o', false), client: off },
      { config: cfg('g', 'Good'), client: good },
    ], { meetingTitle: null, focus: null })
    expect(out).toEqual([{ serverName: 'Good', text: 'ok' }])
    expect(none.getPrompt).not.toHaveBeenCalled()
    expect(off.listPrompts).not.toHaveBeenCalled()
  })
})
