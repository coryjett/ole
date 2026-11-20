// Steering a call (#174, #175, #176): notes on bullets, muted topics and directions the person gives Ole mid-call.

/** directions kept per call, newest last */
export const DIRECTIONS_MAX = 10
/** characters in one direction or one note on a bullet */
export const DIRECTION_MAX = 200
export const NOTE_MAX = 200

/** one line of text from the person, cleaned and capped; '' when there is none */
export function steerLine(v: unknown, max = DIRECTION_MAX): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max).trim() : ''
}

/** the directions given so far, as a prompt part; '' when none */
export function directionsPart(directions: readonly string[] | undefined): string {
  return directions?.length ? `Direction from the user for this call (follow it):\n${directions.map(d => `- ${d}`).join('\n')}` : ''
}
