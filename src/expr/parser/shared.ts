import { cookTemplate } from '../lexer/template.js'

export function parseStringValue(raw: string): string {
  return cookTemplate(raw.slice(1, -1)) ?? raw.slice(1, -1)
}
