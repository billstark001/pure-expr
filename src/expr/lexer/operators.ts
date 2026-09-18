import {
  CC_AMPERSAND,
  CC_ASTERISK,
  CC_CARET,
  CC_COLON,
  CC_COMMA,
  CC_DOT,
  CC_EQUAL,
  CC_EXCLAMATION,
  CC_GT,
  CC_LEFT_BRACE,
  CC_LEFT_BRACKET,
  CC_LEFT_PAREN,
  CC_LT,
  CC_MINUS,
  CC_PERCENT,
  CC_PIPE,
  CC_PLUS,
  CC_QUESTION,
  CC_RIGHT_BRACE,
  CC_RIGHT_BRACKET,
  CC_RIGHT_PAREN,
  CC_SEMICOLON,
  CC_SLASH,
  CC_TILDE,
  isDecimalDigitCode,
} from './char-codes.js'

export function scanOperatorLength(src: string, pos: number): number {
  const code = src.charCodeAt(pos)
  const next = src.charCodeAt(pos + 1)
  const third = src.charCodeAt(pos + 2)
  const fourth = src.charCodeAt(pos + 3)

  switch (code) {
    case CC_GT:
      if (next === CC_GT) {
        if (third === CC_GT) return fourth === CC_EQUAL ? 4 : 3
        return third === CC_EQUAL ? 3 : 2
      }
      return next === CC_EQUAL ? 2 : 1

    case CC_LT:
      if (next === CC_LT) return third === CC_EQUAL ? 3 : 2
      return next === CC_EQUAL ? 2 : 1

    case CC_EQUAL:
      if (next === CC_EQUAL) return third === CC_EQUAL ? 3 : 2
      return next === CC_GT ? 2 : 1

    case CC_EXCLAMATION:
      if (next === CC_EQUAL) return third === CC_EQUAL ? 3 : 2
      return 1

    case CC_PLUS:
      return next === CC_PLUS || next === CC_EQUAL ? 2 : 1

    case CC_MINUS:
      return next === CC_MINUS || next === CC_EQUAL ? 2 : 1

    case CC_ASTERISK:
      if (next === CC_ASTERISK) return third === CC_EQUAL ? 3 : 2
      return next === CC_EQUAL ? 2 : 1

    case CC_SLASH:
    case CC_PERCENT:
    case CC_CARET:
      return next === CC_EQUAL ? 2 : 1

    case CC_AMPERSAND:
      if (next === CC_AMPERSAND) return third === CC_EQUAL ? 3 : 2
      return next === CC_EQUAL ? 2 : 1

    case CC_PIPE:
      if (next === CC_PIPE) return third === CC_EQUAL ? 3 : 2
      if (next === CC_EQUAL || next === CC_GT) return 2
      return 1

    case CC_QUESTION:
      if (next === CC_QUESTION) return third === CC_EQUAL ? 3 : 2
      return next === CC_DOT && !isDecimalDigitCode(third) ? 2 : 1

    case CC_DOT:
      return next === CC_DOT && third === CC_DOT ? 3 : 1

    case CC_TILDE:
    case CC_COLON:
    case CC_COMMA:
    case CC_LEFT_PAREN:
    case CC_RIGHT_PAREN:
    case CC_LEFT_BRACKET:
    case CC_RIGHT_BRACKET:
    case CC_LEFT_BRACE:
    case CC_RIGHT_BRACE:
    case CC_SEMICOLON:
      return 1

    default:
      return 0
  }
}
