import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { testOpenAI } from '../../src/main/ole/openaiTest'
import { OpenAIKeyRow } from '../../src/renderer/src/ole/OleSettings'

const models = (ids: string[]) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), { status: 200 }))
const base = { chatModel: 'gpt-5.6-luna', transcribeModel: 'gpt-4o-mini-transcribe' }

describe('OpenAI key test (#2)', () => {
  it('asks for a key without calling OpenAI', async () => {
    const f = models([])
    expect(await testOpenAI({ ...base, key: null, fetch: f })).toEqual({ ok: false, error: 'Save a key first' })
    expect(f).not.toHaveBeenCalled()
  })
  it('reports a working key and which configured models are on the account', async () => {
    const r = await testOpenAI({ ...base, key: 'sk-test-123456', fetch: models(['gpt-5.6-luna']) })
    expect(r).toEqual({ ok: true, chatModel: { name: 'gpt-5.6-luna', found: true }, transcribeModel: { name: 'gpt-4o-mini-transcribe', found: false } })
  })
  it('says the key was rejected on a 401', async () => {
    const f = vi.fn<typeof fetch>(async () => new Response('{}', { status: 401 }))
    expect((await testOpenAI({ ...base, key: 'sk-test-123456', fetch: f })).error).toBe('OpenAI rejected the key')
  })
  it('gives up quickly when OpenAI cannot be reached, and never echoes the key', async () => {
    const hang = vi.fn<typeof fetch>((_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))))
    const r = await testOpenAI({ ...base, key: 'sk-test-123456', fetch: hang, timeoutMs: 50 })
    expect(r).toEqual({ ok: false, error: "Couldn't reach OpenAI" })
    const echo = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { message: 'bad sk-test-123456 here' } }), { status: 429 }))
    expect((await testOpenAI({ ...base, key: 'sk-test-123456', fetch: echo })).error).not.toContain('sk-test-123456')
  })
  it('the key row has a Test button', () => {
    const html = renderToStaticMarkup(createElement(OpenAIKeyRow, { status: { set: true, masked: 'sk-…3456' }, save: async () => true, test: async () => ({ ok: true }) }))
    expect(html).toContain('data-testid="ole-openai-test"')
    expect(html).not.toContain('sk-test')
  })
})
