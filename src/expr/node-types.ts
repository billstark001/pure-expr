import type {
  BaseNode,
  ArrayExpression as ESTreeArrayExpression,
  ArrayPattern as ESTreeArrayPattern,
  ArrowFunctionExpression as ESTreeArrowFunctionExpression,
  AssignmentPattern as ESTreeAssignmentPattern,
  AssignmentProperty as ESTreeAssignmentProperty,
  AwaitExpression as ESTreeAwaitExpression,
  BinaryExpression as ESTreeBinaryExpression,
  CallExpression as ESTreeCallExpression,
  ChainExpression as ESTreeChainExpression,
  ConditionalExpression as ESTreeConditionalExpression,
  Identifier as ESTreeIdentifier,
  Literal as ESTreeLiteral,
  LogicalExpression as ESTreeLogicalExpression,
  MemberExpression as ESTreeMemberExpression,
  ObjectExpression as ESTreeObjectExpression,
  ObjectPattern as ESTreeObjectPattern,
  Property as ESTreeProperty,
  RestElement as ESTreeRestElement,
  SequenceExpression as ESTreeSequenceExpression,
  SpreadElement as ESTreeSpreadElement,
  TaggedTemplateExpression as ESTreeTaggedTemplateExpression,
  TemplateElement as ESTreeTemplateElement,
  TemplateLiteral as ESTreeTemplateLiteral,
  UnaryExpression as ESTreeUnaryExpression,
} from 'estree'

/** Source offsets retained in addition to ESTree's optional `loc` and `range`. */
export interface SourceOffsets {
  start?: number
  end?: number
}

export type AstNode = BaseNode & SourceOffsets

export type Literal = ESTreeLiteral & SourceOffsets

export interface Identifier extends ESTreeIdentifier, SourceOffsets {}

export interface TopicReference extends BaseNode, SourceOffsets {
  type: 'TopicReference'
}

export interface UnaryExpression extends Omit<ESTreeUnaryExpression, 'argument'>, SourceOffsets {
  argument: ExpressionNode
}

export interface AwaitExpression extends Omit<ESTreeAwaitExpression, 'argument'>, SourceOffsets {
  argument: ExpressionNode
}

export interface BinaryExpression
  extends Omit<ESTreeBinaryExpression, 'left' | 'right'>,
    SourceOffsets {
  left: ExpressionNode
  right: ExpressionNode
}

export interface LogicalExpression
  extends Omit<ESTreeLogicalExpression, 'left' | 'right'>,
    SourceOffsets {
  left: ExpressionNode
  right: ExpressionNode
}

export interface ConditionalExpression
  extends Omit<ESTreeConditionalExpression, 'test' | 'consequent' | 'alternate'>,
    SourceOffsets {
  test: ExpressionNode
  consequent: ExpressionNode
  alternate: ExpressionNode
}

export interface MemberExpression
  extends Omit<ESTreeMemberExpression, 'object' | 'property'>,
    SourceOffsets {
  object: ExpressionNode
  property: ExpressionNode
}

export interface CallExpression
  extends Omit<ESTreeCallExpression, 'callee' | 'arguments'>,
    SourceOffsets {
  type: 'CallExpression'
  callee: ExpressionNode
  arguments: Array<ExpressionNode | SpreadElement>
  optional: boolean
}

export interface ChainExpression extends Omit<ESTreeChainExpression, 'expression'>, SourceOffsets {
  expression: MemberExpression | CallExpression
}

export interface ArrayExpression extends Omit<ESTreeArrayExpression, 'elements'>, SourceOffsets {
  elements: Array<ExpressionNode | SpreadElement | null>
}

export interface Property
  extends Omit<ESTreeProperty, 'key' | 'value' | 'kind' | 'method'>,
    SourceOffsets {
  key: ExpressionNode
  value: ExpressionNode
  kind: 'init'
  method: false
}

export interface ObjectExpression
  extends Omit<ESTreeObjectExpression, 'properties'>,
    SourceOffsets {
  properties: Array<Property | SpreadElement>
}

export interface SpreadElement extends Omit<ESTreeSpreadElement, 'argument'>, SourceOffsets {
  argument: ExpressionNode
}

export interface SequenceExpression
  extends Omit<ESTreeSequenceExpression, 'expressions'>,
    SourceOffsets {
  expressions: ExpressionNode[]
}

export interface TemplateElement extends ESTreeTemplateElement, SourceOffsets {}

export interface TemplateLiteral
  extends Omit<ESTreeTemplateLiteral, 'quasis' | 'expressions'>,
    SourceOffsets {
  quasis: TemplateElement[]
  expressions: ExpressionNode[]
}

export interface TaggedTemplateExpression
  extends Omit<ESTreeTaggedTemplateExpression, 'tag' | 'quasi'>,
    SourceOffsets {
  tag: ExpressionNode
  quasi: TemplateLiteral
}

export interface AssignmentPattern
  extends Omit<ESTreeAssignmentPattern, 'left' | 'right'>,
    SourceOffsets {
  left: BindingPattern
  right: ExpressionNode
}

export interface RestElement extends Omit<ESTreeRestElement, 'argument'>, SourceOffsets {
  argument: BindingPattern
}

export interface ArrayPattern extends Omit<ESTreeArrayPattern, 'elements'>, SourceOffsets {
  elements: Array<BindingPattern | null>
}

export interface AssignmentProperty
  extends Omit<ESTreeAssignmentProperty, 'key' | 'value' | 'kind' | 'method'>,
    SourceOffsets {
  key: ExpressionNode
  value: BindingPattern
  kind: 'init'
  method: false
}

export interface ObjectPattern extends Omit<ESTreeObjectPattern, 'properties'>, SourceOffsets {
  properties: Array<AssignmentProperty | RestElement>
}

export type BindingPattern =
  | Identifier
  | AssignmentPattern
  | RestElement
  | ArrayPattern
  | ObjectPattern

export interface ArrowFunctionExpression
  extends Omit<ESTreeArrowFunctionExpression, 'params' | 'body'>,
    SourceOffsets {
  params: BindingPattern[]
  body: ExpressionNode
  expression: true
  generator: false
  async: false
}

/** Explicit ESTree extension for Hack-style pipelines. */
export interface PipelineExpression extends BaseNode, SourceOffsets {
  type: 'PipelineExpression'
  left: ExpressionNode
  right: ExpressionNode
}

/** The restricted ESTree expression union produced and accepted by pure-expr. */
export type ExpressionNode =
  | Literal
  | Identifier
  | TopicReference
  | ArrowFunctionExpression
  | UnaryExpression
  | AwaitExpression
  | BinaryExpression
  | LogicalExpression
  | ConditionalExpression
  | MemberExpression
  | CallExpression
  | ChainExpression
  | ArrayExpression
  | ObjectExpression
  | SpreadElement
  | TemplateLiteral
  | TaggedTemplateExpression
  | SequenceExpression
  | PipelineExpression
