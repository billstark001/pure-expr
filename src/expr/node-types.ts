// #region Core AST node types

/** Literal primitive value node. */
export interface JSLiteralNode {
  type: 'literal'
  value: null | undefined | boolean | number | bigint | string
  raw: string
  start?: number
  end?: number
}

/** Regular expression literal node. */
export interface JSRegexNode {
  type: 'regex'
  pattern: string
  flags: string
  raw: string
  start?: number
  end?: number
}

/** Identifier lookup node. */
export interface JSIdentifierNode {
  type: 'identifier'
  name: string
  start?: number
  end?: number
}

/** Hack-pipe topic reference node. */
export interface JSTopicReferenceNode {
  type: 'topic'
  start?: number
  end?: number
}

/** Binding identifier used in arrow parameters and destructuring patterns. */
export interface JSBindingIdentifierNode {
  type: 'binding-identifier'
  name: string
  start?: number
  end?: number
}

/** Binding node with a default initializer. */
export interface JSBindingAssignmentNode {
  type: 'binding-assignment'
  left: JSBindingNode
  defaultValue: JSExprNode
  start?: number
  end?: number
}

/** Array binding pattern node. */
export interface JSBindingArrayNode {
  type: 'binding-array'
  elements: Array<JSBindingNode | null>
  rest: JSBindingNode | null
  start?: number
  end?: number
}

/** One object binding property entry. */
export interface JSBindingPropertyNode {
  type: 'binding-property'
  key: JSExprNode
  value: JSBindingNode
  computed: boolean
  shorthand: boolean
  start?: number
  end?: number
}

/** Object binding pattern node. */
export interface JSBindingObjectNode {
  type: 'binding-object'
  properties: JSBindingPropertyNode[]
  rest: JSBindingIdentifierNode | null
  start?: number
  end?: number
}

/** Any binding node accepted in arrow parameters. */
export type JSBindingNode =
  | JSBindingIdentifierNode
  | JSBindingAssignmentNode
  | JSBindingArrayNode
  | JSBindingObjectNode

/** One formal arrow parameter. */
export interface JSArrowParameterNode {
  type: 'parameter'
  binding: JSBindingNode
  rest: boolean
  start?: number
  end?: number
}

/** Unary operator node. */
export interface JSUnaryNode {
  type: 'unary'
  operator: string
  operand: JSExprNode
  start?: number
  end?: number
}

/** Binary operator node. */
export interface JSBinaryNode {
  type: 'binary'
  operator: string
  left: JSExprNode
  right: JSExprNode
  start?: number
  end?: number
}

/** Short-circuit logical operator node. */
export interface JSLogicalNode {
  type: 'logical'
  operator: '&&' | '||' | '??'
  left: JSExprNode
  right: JSExprNode
  start?: number
  end?: number
}

/** Ternary conditional node. */
export interface JSConditionalNode {
  type: 'conditional'
  test: JSExprNode
  consequent: JSExprNode
  alternate: JSExprNode
  start?: number
  end?: number
}

/** Property access node. */
export interface JSMemberNode {
  type: 'member'
  object: JSExprNode
  property: JSExprNode
  computed: boolean // obj[x] vs obj.x
  optional: boolean // ?.
  start?: number
  end?: number
}

/** Function or method call node. */
export interface JSCallNode {
  type: 'call'
  callee: JSExprNode
  args: Array<JSExprNode | JSSpreadNode>
  optional: boolean // ?.()
  start?: number
  end?: number
}

/** Array literal node. */
export interface JSArrayNode {
  type: 'array'
  elements: Array<JSExprNode | JSSpreadNode | null>
  start?: number
  end?: number
}

/** Object property entry node. */
export interface JSObjectPropNode {
  type: 'property'
  key: JSExprNode
  value: JSExprNode
  computed: boolean
  shorthand: boolean
  start?: number
  end?: number
}

/** Object literal node. */
export interface JSObjectNode {
  type: 'object'
  props: Array<JSObjectPropNode | JSSpreadNode>
  start?: number
  end?: number
}

/** Spread element or property node. */
export interface JSSpreadNode {
  type: 'spread'
  argument: JSExprNode
  start?: number
  end?: number
}

/** Template literal node. */
export interface JSTemplateNode {
  type: 'template'
  tag: JSExprNode | null
  quasis: Array<{ raw: string; cooked: string | null }>
  expressions: JSExprNode[]
  start?: number
  end?: number
}

/** Comma-expression sequence node. */
export interface JSSequenceNode {
  type: 'sequence'
  expressions: JSExprNode[]
  start?: number
  end?: number
}

/** Pipeline operator node. */
export interface JSPipelineNode {
  type: 'pipeline'
  left: JSExprNode
  right: JSExprNode
  start?: number
  end?: number
}

/** Concise-body arrow function node. */
export interface JSArrowFunctionNode {
  type: 'arrow-function'
  params: JSArrowParameterNode[]
  body: JSExprNode
  start?: number
  end?: number
}

// #endregion

// #region AST union

/** Any AST node produced by the expression parser. */
export type JSExprNode =
  | JSLiteralNode
  | JSRegexNode
  | JSIdentifierNode
  | JSTopicReferenceNode
  | JSArrowFunctionNode
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

// #endregion
