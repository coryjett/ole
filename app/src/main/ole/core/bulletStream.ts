// Ole: reads a bullets reply while it streams (#84). A small tolerant JSON scanner: it finds the top-level "bullets"
// array and hands over each element object as soon as its closing brace arrives, parsed with JSON.parse. Anything
// before the first "{" (a code fence, a stray word) is skipped. It never throws; what it can't read it leaves to the
// whole-reply parse (parseBullets), which stays the authority once the reply is complete.

export type BulletStream = {
  /** the next piece of the reply */
  push(text: string): void
  /** how many complete elements of "bullets" it has handed over */
  count(): number
}

export function createBulletStream(onItem: (item: unknown) => void): BulletStream {
  /** the open containers, outermost first */
  const stack: Array<'{' | '['> = []
  let inString = false, escaped = false
  /** the raw text of the string being read, when it may be a key of the top-level object */
  let str: string | null = null
  /** the last complete string at the top level, and the key it became */
  let lastString: string | null = null, key: string | null = null
  /** the top-level "bullets" array is open */
  let inBullets = false
  /** the element object being read, from its opening brace */
  let item: string | null = null
  let handed = 0
  /** the top-level object closed: anything after it is ignored */
  let closed = false

  const push = (text: string) => {
    for (const ch of text) {
      if (closed) return
      if (item !== null) item += ch
      if (inString) {
        if (str !== null) str += ch
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') {
          inString = false
          if (str !== null) {
            try { lastString = JSON.parse(`"${str}`) as string } catch { lastString = null }
            str = null
          }
        }
        continue
      }
      // outside any container only an opening brace matters (a code fence or a word before the JSON is skipped)
      if (!stack.length) { if (ch === '{') stack.push('{'); continue }
      if (ch === '"') {
        inString = true
        str = stack.length === 1 ? '' : null
        continue
      }
      if (ch === ':' && stack.length === 1) { key = lastString; continue }
      if (ch === ',' && stack.length === 1) { key = null; lastString = null; continue }
      if (ch === '{' || ch === '[') {
        if (ch === '[' && stack.length === 1 && key === 'bullets') inBullets = true
        if (ch === '{' && inBullets && stack.length === 2) item = '{'
        stack.push(ch)
        continue
      }
      if (ch === '}' || ch === ']') {
        stack.pop()
        if (ch === '}' && inBullets && stack.length === 2 && item !== null) {
          const raw = item
          item = null
          let parsed: unknown
          try { parsed = JSON.parse(raw) } catch { parsed = undefined }
          if (parsed !== undefined) { handed++; onItem(parsed) }
        }
        if (ch === ']' && inBullets && stack.length === 1) inBullets = false
        if (!stack.length) closed = true
      }
    }
  }
  return { push, count: () => handed }
}
