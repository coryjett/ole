import { describe, expect, it } from 'vitest'
import { boundedSchema, isReadOnly, SCHEMA_MAX_CHARS } from '../../src/main/ole/core/tools'

describe('read-only check', () => {
  it('never trusts a read prefix when a write verb appears anywhere in the name', () => {
    expect(isReadOnly({ name: 'get_and_delete_record' })).toBe(false)
    expect(isReadOnly({ name: 'list_then_send_email' })).toBe(false)
    expect(isReadOnly({ name: 'search_and_update' })).toBe(false)
  })
  it('still accepts plain read names and an explicit readOnlyHint', () => {
    expect(isReadOnly({ name: 'get_account_details' })).toBe(true)
    expect(isReadOnly({ name: 'search_calls' })).toBe(true)
    expect(isReadOnly({ name: 'anything', annotations: { readOnlyHint: true } })).toBe(true)
  })
})

describe('tool schemas', () => {
  it('drops a schema that is too large or too deep', () => {
    expect(boundedSchema({ type: 'object', description: 'x'.repeat(SCHEMA_MAX_CHARS) })).toBeNull()
    let deep: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 12; i++) deep = { type: 'object', properties: { a: deep } }
    expect(boundedSchema(deep)).toBeNull()
  })
  it('keeps a normal schema and fills in a missing one', () => {
    const s = { type: 'object', properties: { account_id: { type: 'string' } } }
    expect(boundedSchema(s)).toBe(s)
    expect(boundedSchema(undefined)).toEqual({ type: 'object', properties: {} })
  })
})
