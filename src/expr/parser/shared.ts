import { cookTemplate } from '../lexer.js'

export function parseStringValue(raw: string): string {
  return cookTemplate(raw.slice(1, -1)) ?? raw.slice(1, -1)
}
