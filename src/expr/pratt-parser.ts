export type PrattToken = PrattOperatorToken | PrattExprToken

export class PrattParseError extends Error {
  start?: number
  end?: number
  place?: string
  token?: PrattToken

  constructor(message: string, token?: PrattToken) {
    const positionInfo =
      token?.start !== undefined && token?.end !== undefined
        ? ` at position ${token.start}-${token.end}`
        : ''
    super(message + positionInfo)
    this.name = 'PrattParseError'
    this.token = token
    this.start = token?.start
    this.end = token?.end
  }
}

export interface PrattOperatorToken {
  type: 'opr'
  start?: number
  end?: number
  place?: string
  value: string
}

export interface PrattExprToken {
  type: 'expr'
  start?: number
  end?: number
  place?: string
  value: any
}

export type PrattASTNode<T = LeafNode> =
  | T
  | PrefixNode<T>
  | PostfixNode<T>
  | BinaryNode<T>

export interface LeafNode {
  type: 'leaf'
  value: any
}

function defaultLeafNodeCreator(value: any): LeafNode {
  return { type: 'leaf', value }
}

interface OperatorNodeMetadata {
  operator: string
  start?: number
  end?: number
  place?: string
}

export interface PrefixNode<T> extends OperatorNodeMetadata {
  type: 'prefix'
  operand: PrattASTNode<T>
}

export interface PostfixNode<T> extends OperatorNodeMetadata {
  type: 'postfix'
  operand: PrattASTNode<T>
}

export interface BinaryNode<T> extends OperatorNodeMetadata {
  type: 'binary'
  left: PrattASTNode<T>
  right: PrattASTNode<T>
}

export type Associativity = 'left' | 'right'

export interface OperatorConfig {
  precedence: number
  associativity?: Associativity
  prefix?: boolean
  postfix?: boolean
  infix?: boolean
}

export type OperatorValidator<T = LeafNode> = (
  operator: string,
  operands: PrattASTNode<T>[],
  token?: PrattToken
) => boolean

export interface PrattParserConfig<T = LeafNode> {
  operators: Record<string, OperatorConfig>
  leafNodeCreator?: (token: PrattExprToken) => T
  validators?: Record<string, OperatorValidator<T>>
}

export class PrattParser<T = LeafNode> {
  private readonly operators: ReadonlyMap<string, OperatorConfig>
  private readonly leafNodeCreator: (token: PrattExprToken) => T
  private readonly validators: ReadonlyMap<string, OperatorValidator<T>>
  private tokens: PrattToken[]
  private position: number

  constructor(config: PrattParserConfig<T>) {
    this.operators = new Map(Object.entries(config.operators))
    this.leafNodeCreator =
      config.leafNodeCreator || (defaultLeafNodeCreator as any)
    this.validators = new Map(Object.entries(config.validators || {}))
    this.tokens = []
    this.position = 0
  }

  parse(tokens: PrattToken[]): PrattASTNode<T> | undefined {
    if (tokens.length === 0) return undefined
    this.tokens = tokens
    this.position = 0
    const result = this.parseExpression(0)
    if (this.hasNext()) {
      const rem = this.peek()!
      throw new PrattParseError(
        `Unexpected token after expression: '${
          rem.type === 'opr' ? rem.value : 'expression'
        }'`,
        rem
      )
    }
    return result
  }

  private parseExpression(minPrecedence: number): PrattASTNode<T> {
    let left = this.parsePrefix()
    while (this.hasNext()) {
      const token = this.peek()!
      if (token.type !== 'opr') break
      const config = this.operators.get(token.value)
      if (!config) break

      if (config.postfix && config.precedence >= minPrecedence) {
        this.advance()
        const node: PostfixNode<T> = {
          type: 'postfix',
          operator: token.value,
          start: token.start,
          end: token.end,
          place: token.place,
          operand: left,
        }
        const validator = this.validators.get(token.value)
        if (validator && !validator(token.value, [left], token))
          throw new PrattParseError(
            `Validation failed for postfix operator '${token.value}'`,
            token
          )
        left = node
        continue
      }

      if (config.infix && config.precedence >= minPrecedence) {
        const precedence = config.precedence
        const assoc = config.associativity || 'left'
        this.advance()
        const nextMin = assoc === 'right' ? precedence : precedence + 1
        const right = this.parseExpression(nextMin)
        const node: BinaryNode<T> = {
          type: 'binary',
          operator: token.value,
          start: token.start,
          end: token.end,
          place: token.place,
          left,
          right,
        }
        const validator = this.validators.get(token.value)
        if (validator && !validator(token.value, [left, right], token))
          throw new PrattParseError(
            `Validation failed for infix operator '${token.value}'`,
            token
          )
        left = node
        continue
      }
      break
    }
    return left
  }

  private parsePrefix(): PrattASTNode<T> {
    const token = this.advance()
    if (!token) throw new PrattParseError('Unexpected end of input')
    if (token.type === 'expr') return this.leafNodeCreator!(token)
    const config = this.operators.get(token.value)
    if (!config || !config.prefix)
      throw new PrattParseError(
        `Unexpected operator '${token.value}' at prefix position`,
        token
      )
    const operand = this.parseExpression(config.precedence)
    const node: PrefixNode<T> = {
      type: 'prefix',
      operator: token.value,
      start: token.start,
      end: token.end,
      place: token.place,
      operand,
    }
    const validator = this.validators.get(token.value)
    if (validator && !validator(token.value, [operand], token))
      throw new PrattParseError(
        `Validation failed for prefix operator '${token.value}'`,
        token
      )
    return node
  }

  private peek(): PrattToken | undefined {
    return this.tokens[this.position]
  }
  private advance(): PrattToken | undefined {
    return this.tokens[this.position++]
  }
  private hasNext(): boolean {
    return this.position < this.tokens.length
  }
}
