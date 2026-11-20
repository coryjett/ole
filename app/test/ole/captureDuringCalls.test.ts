import { describe, expect, it } from 'vitest'
import { shouldProtect } from '../../src/main/ole/capture'
import { PROVIDER_DEFAULTS } from '../../src/main/ole/providers'

describe('hide while sharing: off by default, only during a call (#61)', () => {
  it('is off unless turned on', () => {
    expect(PROVIDER_DEFAULTS.hideWhileSharing).toBe(false)
  })
  it('protects only while a call records', () => {
    expect(shouldProtect(true, true)).toBe(true)
    expect(shouldProtect(true, false)).toBe(false)
    expect(shouldProtect(false, true)).toBe(false)
  })
})
