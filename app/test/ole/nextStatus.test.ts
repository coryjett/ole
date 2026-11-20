// #142: Home's next-meeting label comes from Ole's own Prepare only, never from the server's calendar match.
import { describe, expect, it } from 'vitest'
import { clockTime, nextStatus, nextStatusLabel, type NextStatusInput } from '../../src/main/ole/core/nextStatus'

const at = (h: number, m: number) => new Date(2026, 10, 20, h, m).getTime()
const input = (o: Partial<NextStatusInput> = {}): NextStatusInput =>
  ({ autoPrepare: true, leadMs: 10 * 60_000, now: at(13, 0), start: at(14, 30), prepared: null, preparing: false, ...o })
const label = (o: Partial<NextStatusInput> = {}) => nextStatusLabel(nextStatus(input(o)))

describe('the next meeting\'s state (#142)', () => {
  it('before auto-prepare runs: Prepares at the start minus the lead, local time', () => {
    expect(nextStatus(input())).toEqual({ status: 'scheduled', preparesAt: at(14, 20) })
    expect(label()).toBe('Prepares at 14:20')
    expect(label({ leadMs: 15 * 60_000 })).toBe('Prepares at 14:15')
  })
  it('due but not run yet (the next auto-prepare tick): still the time it prepares at', () => {
    expect(label({ now: at(14, 21) })).toBe('Prepares at 14:20')
  })
  it('while a Prepare runs: Preparing…, whatever else holds', () => {
    expect(label({ preparing: true })).toBe('Preparing…')
    expect(label({ preparing: true, prepared: { matched: true } })).toBe('Preparing…')
    expect(label({ preparing: true, autoPrepare: false })).toBe('Preparing…')
    expect(nextStatus(input({ preparing: true })).preparesAt).toBeNull()
  })
  it('after: Briefing ready when it matched a record, No match when it matched none', () => {
    expect(label({ prepared: { matched: true } })).toBe('Briefing ready')
    expect(label({ prepared: { matched: false } })).toBe('No match')
    expect(label({ prepared: { matched: false }, autoPrepare: false })).toBe('No match')
    expect(nextStatus(input({ prepared: { matched: true } })).preparesAt).toBeNull()
  })
  it('auto-prepare off (or not picking this meeting) and not prepared: no state label', () => {
    expect(nextStatus(input({ autoPrepare: false }))).toEqual({ status: 'idle', preparesAt: null })
    expect(label({ autoPrepare: false })).toBeNull()
  })
  it('a meeting already on is not auto-prepared any more: no state label', () => {
    expect(label({ now: at(14, 31) })).toBeNull()
    expect(label({ now: at(14, 30) })).toBeNull()
  })
})

describe('clockTime', () => {
  it('HH:MM, 24-hour, zero-padded, local time', () => {
    expect(clockTime(at(9, 5))).toBe('09:05')
    expect(clockTime(at(0, 0))).toBe('00:00')
    expect(clockTime(at(23, 59))).toBe('23:59')
    expect(clockTime(at(14, 20) + 59_000)).toBe('14:20')
  })
  it('an invalid time gives no label', () => {
    expect(clockTime(NaN)).toBe('')
    expect(nextStatusLabel({ status: 'scheduled', preparesAt: NaN })).toBeNull()
    expect(nextStatusLabel({ status: 'scheduled', preparesAt: null })).toBeNull()
  })
})
