// Ole: audio conversion for streaming transcription (#85): the host's 16 kHz float samples to the 24 kHz PCM16 the
// Realtime API takes. Pure; the stream itself (yogurt/openaiStream.ts) is wired to the host's chunker and tracks.
import { Buffer } from 'node:buffer'

/** 16 kHz to 24 kHz by linear interpolation, carried across blocks of one turn */
export class Upsampler {
  /** the next output's position in thirds of an input sample, from the start of the next block (-3..0: between the last block's end and it) */
  private pos = 0
  private prev = 0
  private started = false
  reset() { this.pos = 0; this.prev = 0; this.started = false }
  push(x: Float32Array): Float32Array {
    if (!x.length) return new Float32Array(0)
    if (!this.started) { this.prev = x[0]; this.started = true }
    const out: number[] = []
    // output every 2/3 of an input sample: 3 outputs per 2 inputs
    while (this.pos <= (x.length - 1) * 3) {
      const i = Math.floor(this.pos / 3), frac = (this.pos - i * 3) / 3
      const a = i < 0 ? this.prev : x[i]
      const b = i + 1 < x.length ? x[i + 1] : a
      out.push(a + (b - a) * frac)
      this.pos += 2
    }
    this.pos -= x.length * 3
    this.prev = x[x.length - 1]
    return Float32Array.from(out)
  }
}

/** float samples to little-endian PCM16, base64 */
export function pcm16Base64(x: Float32Array): string {
  const b = Buffer.alloc(x.length * 2)
  for (let i = 0; i < x.length; i++) { const v = Math.max(-1, Math.min(1, x[i])); b.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), i * 2) }
  return b.toString('base64')
}
