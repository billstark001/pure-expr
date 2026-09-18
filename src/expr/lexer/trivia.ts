import {
  CC_ASTERISK,
  CC_SLASH,
  isLineTerminatorCode,
  isTriviaWhitespaceCode,
} from './char-codes.js'
import { JSLexError } from './types.js'

export function skipTrivia(src: string, start: number): number {
  let pos = start

  while (pos < src.length) {
    const code = src.charCodeAt(pos)
    if (isTriviaWhitespaceCode(code)) {
      pos++
      continue
    }

    if (code !== CC_SLASH) return pos

    const next = src.charCodeAt(pos + 1)
    if (next === CC_SLASH) {
      pos += 2
      while (pos < src.length && !isLineTerminatorCode(src.charCodeAt(pos))) pos++
      continue
    }

    if (next !== CC_ASTERISK) return pos

    const commentStart = pos
    pos += 2
    let closed = false
    while (pos < src.length) {
      if (src.charCodeAt(pos) === CC_ASTERISK && src.charCodeAt(pos + 1) === CC_SLASH) {
        pos += 2
        closed = true
        break
      }
      pos++
    }

    if (!closed) throw new JSLexError('Unterminated block comment', commentStart, src)
  }

  return pos
}
