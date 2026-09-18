export const CC_NUL = 0x00
export const CC_TAB = 0x09
export const CC_LF = 0x0a
export const CC_VT = 0x0b
export const CC_FF = 0x0c
export const CC_CR = 0x0d
export const CC_SPACE = 0x20
export const CC_EXCLAMATION = 0x21
export const CC_DOUBLE_QUOTE = 0x22
export const CC_DOLLAR = 0x24
export const CC_PERCENT = 0x25
export const CC_AMPERSAND = 0x26
export const CC_SINGLE_QUOTE = 0x27
export const CC_LEFT_PAREN = 0x28
export const CC_RIGHT_PAREN = 0x29
export const CC_ASTERISK = 0x2a
export const CC_PLUS = 0x2b
export const CC_COMMA = 0x2c
export const CC_MINUS = 0x2d
export const CC_DOT = 0x2e
export const CC_SLASH = 0x2f
export const CC_0 = 0x30
export const CC_9 = 0x39
export const CC_COLON = 0x3a
export const CC_SEMICOLON = 0x3b
export const CC_LT = 0x3c
export const CC_EQUAL = 0x3d
export const CC_GT = 0x3e
export const CC_QUESTION = 0x3f
export const CC_A_UPPER = 0x41
export const CC_B_UPPER = 0x42
export const CC_F_UPPER = 0x46
export const CC_O_UPPER = 0x4f
export const CC_X_UPPER = 0x58
export const CC_Z_UPPER = 0x5a
export const CC_LEFT_BRACKET = 0x5b
export const CC_BACKSLASH = 0x5c
export const CC_RIGHT_BRACKET = 0x5d
export const CC_CARET = 0x5e
export const CC_UNDERSCORE = 0x5f
export const CC_BACKTICK = 0x60
export const CC_A_LOWER = 0x61
export const CC_B_LOWER = 0x62
export const CC_C_LOWER = 0x63
export const CC_D_LOWER = 0x64
export const CC_E_LOWER = 0x65
export const CC_F_LOWER = 0x66
export const CC_G_LOWER = 0x67
export const CC_H_LOWER = 0x68
export const CC_I_LOWER = 0x69
export const CC_J_LOWER = 0x6a
export const CC_K_LOWER = 0x6b
export const CC_L_LOWER = 0x6c
export const CC_M_LOWER = 0x6d
export const CC_N_LOWER = 0x6e
export const CC_O_LOWER = 0x6f
export const CC_P_LOWER = 0x70
export const CC_Q_LOWER = 0x71
export const CC_R_LOWER = 0x72
export const CC_S_LOWER = 0x73
export const CC_T_LOWER = 0x74
export const CC_U_LOWER = 0x75
export const CC_V_LOWER = 0x76
export const CC_W_LOWER = 0x77
export const CC_X_LOWER = 0x78
export const CC_Y_LOWER = 0x79
export const CC_Z_LOWER = 0x7a
export const CC_LEFT_BRACE = 0x7b
export const CC_PIPE = 0x7c
export const CC_RIGHT_BRACE = 0x7d
export const CC_TILDE = 0x7e
export const CC_LINE_SEPARATOR = 0x2028
export const CC_PARAGRAPH_SEPARATOR = 0x2029

export function isDecimalDigitCode(code: number): boolean {
  return code >= CC_0 && code <= CC_9
}

export function isAsciiLetterCode(code: number): boolean {
  return (code >= CC_A_UPPER && code <= CC_Z_UPPER) || (code >= CC_A_LOWER && code <= CC_Z_LOWER)
}

export function isIdentifierStartCode(code: number): boolean {
  return isAsciiLetterCode(code) || code === CC_UNDERSCORE || code === CC_DOLLAR
}

export function isIdentifierPartCode(code: number): boolean {
  return isIdentifierStartCode(code) || isDecimalDigitCode(code)
}

export function isHexDigitCode(code: number): boolean {
  return (
    isDecimalDigitCode(code) ||
    (code >= CC_A_UPPER && code <= CC_F_UPPER) ||
    (code >= CC_A_LOWER && code <= CC_F_LOWER)
  )
}

export function isLineTerminatorCode(code: number): boolean {
  return (
    code === CC_LF ||
    code === CC_CR ||
    code === CC_LINE_SEPARATOR ||
    code === CC_PARAGRAPH_SEPARATOR
  )
}

export function isTriviaWhitespaceCode(code: number): boolean {
  return (
    code === CC_SPACE ||
    code === CC_TAB ||
    code === CC_CR ||
    code === CC_LF ||
    code === CC_FF ||
    code === CC_VT
  )
}

export function isRegexFlagCode(code: number): boolean {
  return (
    code === CC_D_LOWER ||
    code === CC_G_LOWER ||
    code === CC_I_LOWER ||
    code === CC_M_LOWER ||
    code === CC_S_LOWER ||
    code === CC_U_LOWER ||
    code === CC_V_LOWER ||
    code === CC_Y_LOWER
  )
}
