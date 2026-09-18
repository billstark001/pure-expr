import {
  CC_0,
  CC_BACKSLASH,
  CC_BACKTICK,
  CC_B_LOWER,
  CC_DOLLAR,
  CC_F_LOWER,
  CC_LEFT_BRACE,
  CC_N_LOWER,
  CC_R_LOWER,
  CC_RIGHT_BRACE,
  CC_T_LOWER,
  CC_U_LOWER,
  CC_V_LOWER,
  CC_X_LOWER,
  isDecimalDigitCode,
  isHexDigitCode,
  isLineTerminatorCode,
} from './char-codes.js'

export function cookTemplate(raw: string): string | null {
  let cooked = ''

  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index)
    if (code !== CC_BACKSLASH) {
      cooked += raw[index]
      continue
    }

    const next = raw.charCodeAt(index + 1)
    if (Number.isNaN(next)) return null

    const continuationEnd = consumeLineContinuation(raw, index + 1)
    if (continuationEnd !== -1) {
      index = continuationEnd
      continue
    }

    if (next === CC_0) {
      if (isDecimalDigitCode(raw.charCodeAt(index + 2))) return null
      cooked += '\0'
      index++
      continue
    }

    if (next === CC_B_LOWER) {
      cooked += '\b'
      index++
      continue
    }
    if (next === CC_F_LOWER) {
      cooked += '\f'
      index++
      continue
    }
    if (next === CC_N_LOWER) {
      cooked += '\n'
      index++
      continue
    }
    if (next === CC_R_LOWER) {
      cooked += '\r'
      index++
      continue
    }
    if (next === CC_T_LOWER) {
      cooked += '\t'
      index++
      continue
    }
    if (next === CC_V_LOWER) {
      cooked += '\v'
      index++
      continue
    }
    if (next === CC_BACKTICK || next === CC_DOLLAR || next === CC_BACKSLASH) {
      cooked += raw[index + 1]
      index++
      continue
    }

    if (next === CC_X_LOWER) {
      const a = raw.charCodeAt(index + 2)
      const b = raw.charCodeAt(index + 3)
      if (!isHexDigitCode(a) || !isHexDigitCode(b)) return null
      cooked += String.fromCharCode(hexValue(a) * 16 + hexValue(b))
      index += 3
      continue
    }

    if (next === CC_U_LOWER) {
      if (raw.charCodeAt(index + 2) === CC_LEFT_BRACE) {
        let end = index + 3
        let codePoint = 0
        let digits = 0
        while (end < raw.length && raw.charCodeAt(end) !== CC_RIGHT_BRACE) {
          const digit = raw.charCodeAt(end)
          if (!isHexDigitCode(digit)) return null
          codePoint = codePoint * 16 + hexValue(digit)
          if (codePoint > 0x10ffff) return null
          digits++
          end++
        }

        if (digits === 0 || raw.charCodeAt(end) !== CC_RIGHT_BRACE) return null
        cooked += String.fromCodePoint(codePoint)
        index = end
        continue
      }

      const a = raw.charCodeAt(index + 2)
      const b = raw.charCodeAt(index + 3)
      const c = raw.charCodeAt(index + 4)
      const d = raw.charCodeAt(index + 5)
      if (!isHexDigitCode(a) || !isHexDigitCode(b) || !isHexDigitCode(c) || !isHexDigitCode(d)) {
        return null
      }
      cooked += String.fromCharCode(
        hexValue(a) * 0x1000 + hexValue(b) * 0x100 + hexValue(c) * 0x10 + hexValue(d),
      )
      index += 5
      continue
    }

    if (isDecimalDigitCode(next)) return null

    cooked += raw[index + 1]
    index++
  }

  return cooked
}

function consumeLineContinuation(raw: string, index: number): number {
  const code = raw.charCodeAt(index)
  if (code === 0x0d && raw.charCodeAt(index + 1) === 0x0a) return index + 1
  return isLineTerminatorCode(code) ? index : -1
}

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10
  return code - 0x61 + 10
}
