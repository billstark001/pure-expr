export interface JSLiteralNode {
  type: 'literal'
  value: null | undefined | boolean | number | bigint | string
  raw: string
  start?: number
  end?: number
}

export interface JSRegexNode {
  type: 'regex'
  pattern: string
  flags: string
  raw: string
  start?: number
  end?: number
}

export interface JSIdentifierNode {
  type: 'identifier'
  name: string
  start?: number
  end?: number
}

export interface JSUnaryNode {
  type: 'unary'
  operator: string
  operand: JSExprNode
  start?: number
  end?: number
}

export interface JSBinaryNode {
  type: 'binary'
  operator: string
  left: JSExprNode
  right: JSExprNode
  start?: number
  end?: number
}

export interface JSLogicalNode {
  type: 'logical'
  operator: '&&' | '||' | '??'
  left: JSExprNode
  right: JSExprNode
  start?: number
  end?: number
}

export interface JSConditionalNode {
  type: 'conditional'
  test: JSExprNode
  consequent: JSExprNode
  alternate: JSExprNode
  start?: number
  end?: number
}

export interface JSMemberNode {
  type: 'member'
  object: JSExprNode
  property: JSExprNode
  computed: boolean   // obj[x] vs obj.x
  optional: boolean   // ?.
  start?: number
  end?: number
}

export interface JSCallNode {
  type: 'call'
  callee: JSExprNode
  args: Array<JSExprNode | JSSpreadNode>
  optional: boolean   // ?.()
  start?: number
  end?: number
}

export interface JSArrayNode {
  type: 'array'
  elements: Array<JSExprNode | JSSpreadNode | null>
  start?: number
  end?: number
}

export interface JSObjectPropNode {
  type: 'property'
  key: JSExprNode
  value: JSExprNode
  computed: boolean
  shorthand: boolean
  start?: number
  end?: number
}

export interface JSObjectNode {
  type: 'object'
  props: Array<JSObjectPropNode | JSSpreadNode>
  start?: number
  end?: number
}

export interface JSSpreadNode {
  type: 'spread'
  argument: JSExprNode
  start?: number
  end?: number
}

export interface JSTemplateNode {
  type: 'template'
  tag: JSExprNode | null
  quasis: Array<{ raw: string; cooked: string | null }>
  expressions: JSExprNode[]
  start?: number
  end?: number
}

export interface JSSequenceNode {
  type: 'sequence'
  expressions: JSExprNode[]
  start?: number
  end?: number
}

export interface JSPipelineNode {
  type: 'pipeline'
  left: JSExprNode
  right: JSExprNode
  start?: number
  end?: number
}

export type JSExprNode =
  | JSLiteralNode
  | JSRegexNode
  | JSIdentifierNode
  | JSUnaryNode
  | JSBinaryNode
  | JSLogicalNode
  | JSConditionalNode
  | JSMemberNode
  | JSCallNode
  | JSArrayNode
  | JSObjectNode
  | JSSpreadNode
  | JSTemplateNode
  | JSSequenceNode
  | JSPipelineNode