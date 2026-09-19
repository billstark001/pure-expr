import { LEXICAL_PUNCTUATORS } from '../operators.js'
import { isDecimalDigitCode } from './char-codes.js'

const ASCII_CARDINALITY = 128
const DEAD_STATE = 0
const ROOT_STATE = 1

interface MutableTrieState {
  acceptingLength: number
  transitions: Map<number, number>
}

function compilePunctuatorDfa(): {
  acceptingLengths: Uint8Array
  continuingStates: Uint8Array
  maxLength: number
  transitions: Uint8Array
} {
  const states: MutableTrieState[] = [
    { acceptingLength: 0, transitions: new Map() },
    { acceptingLength: 0, transitions: new Map() },
  ]
  let maxLength = 0

  for (const punctuator of LEXICAL_PUNCTUATORS) {
    maxLength = Math.max(maxLength, punctuator.length)
    let state = ROOT_STATE
    for (let index = 0; index < punctuator.length; index += 1) {
      const code = punctuator.charCodeAt(index)
      if (code >= ASCII_CARDINALITY) {
        throw new TypeError(`Lexer punctuator '${punctuator}' must contain only ASCII characters`)
      }
      let next = states[state].transitions.get(code)
      if (next === undefined) {
        next = states.length
        states[state].transitions.set(code, next)
        states.push({ acceptingLength: 0, transitions: new Map() })
      }
      state = next
    }
    states[state].acceptingLength = punctuator.length
  }

  if (states.length > 0xff) throw new TypeError('Lexer punctuator DFA exceeds 255 states')
  const transitions = new Uint8Array(states.length * ASCII_CARDINALITY)
  const acceptingLengths = new Uint8Array(states.length)
  const continuingStates = new Uint8Array(states.length)
  for (let state = ROOT_STATE; state < states.length; state += 1) {
    acceptingLengths[state] = states[state].acceptingLength
    continuingStates[state] = states[state].transitions.size === 0 ? 0 : 1
    for (const [code, next] of states[state].transitions) {
      transitions[state * ASCII_CARDINALITY + code] = next
    }
  }
  return { acceptingLengths, continuingStates, maxLength, transitions }
}

const {
  acceptingLengths: PUNCTUATOR_ACCEPTING_LENGTHS,
  continuingStates: PUNCTUATOR_CONTINUING_STATES,
  maxLength: MAX_PUNCTUATOR_LENGTH,
  transitions: PUNCTUATOR_TRANSITIONS,
} = compilePunctuatorDfa()

export function scanOperatorLength(src: string, pos: number): number {
  let state = ROOT_STATE
  let matchedLength = 0
  for (let offset = 0; offset < MAX_PUNCTUATOR_LENGTH; offset += 1) {
    if (pos + offset >= src.length) break
    const code = src.charCodeAt(pos + offset)
    if (code >= ASCII_CARDINALITY) break
    state = PUNCTUATOR_TRANSITIONS[(state << 7) + code]
    if (state === DEAD_STATE) break
    const acceptingLength = PUNCTUATOR_ACCEPTING_LENGTHS[state]
    if (acceptingLength !== 0) {
      matchedLength = acceptingLength
      if (PUNCTUATOR_CONTINUING_STATES[state] === 0) {
        if (
          acceptingLength === 2 &&
          src.charCodeAt(pos) === 0x3f &&
          isDecimalDigitCode(src.charCodeAt(pos + acceptingLength))
        ) {
          return 1
        }
        return acceptingLength
      }
    }
  }

  if (
    matchedLength === 2 &&
    src.charCodeAt(pos) === 0x3f &&
    isDecimalDigitCode(src.charCodeAt(pos + matchedLength))
  ) {
    return 1
  }
  return matchedLength
}
