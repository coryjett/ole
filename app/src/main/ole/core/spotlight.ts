// What a call's bullets say loudly and what they keep quiet (#172). Pure, so every surface splits them the same way.
import type { OleBullet } from './types'

/** act bullets shown as Right now */
export const NOW_MAX = 2

/** Right now: the newest act bullets. Earlier: everything else, newest first. */
export function spotlight(bullets: readonly OleBullet[]): { now: OleBullet[]; earlier: OleBullet[] } {
  const sorted = [...bullets].sort((a, b) => b.at - a.at)
  const now = sorted.filter(b => b.act).slice(0, NOW_MAX)
  const ids = new Set(now.map(b => b.id))
  return { now, earlier: sorted.filter(b => !ids.has(b.id)) }
}

/** the bullets that may interrupt: the floating window and the Live badge */
export function loudBullets(bullets: readonly OleBullet[]): OleBullet[] {
  return bullets.filter(b => b.act)
}
