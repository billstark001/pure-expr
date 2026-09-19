import type {
  BaseNode,
  ArrayExpression as ESTreeArrayExpression,
  ArrayPattern as ESTreeArrayPattern,
  ArrowFunctionExpression as ESTreeArrowFunctionExpression,
  AssignmentExpression as ESTreeAssignmentExpression,
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
  UpdateExpression as ESTreeUpdateExpression,
} from 'estree'
import type { SupportedUnaryOperator } from './operators.js'

/** Any standard ESTree node (including its optional `loc` and `range` fields). */
export type AstNode = BaseNode

export type Literal = ESTreeLiteral

export interface Identifier extends ESTreeIdentifier {}

export interface TopicReference extends BaseNode {
  type: 'TopicReference'
}

export interface UnaryExpression extends Omit<ESTreeUnaryExpression, 'argument' | 'operator'> {
  argument: ExpressionNode
  operator: SupportedUnaryOperator
}

export type AssignmentTarget = Identifier | MemberExpression

export interface UpdateExpression extends Omit<ESTreeUpdateExpression, 'argument'> {
  argument: AssignmentTarget
}

export interface AwaitExpression extends Omit<ESTreeAwaitExpression, 'argument'> {
  argument: ExpressionNode
}

export interface BinaryExpression extends Omit<ESTreeBinaryExpression, 'left' | 'right'> {
  left: ExpressionNode
  right: ExpressionNode
}

export interface LogicalExpression extends Omit<ESTreeLogicalExpression, 'left' | 'right'> {
  left: ExpressionNode
  right: ExpressionNode
}

export interface ConditionalExpression
  extends Omit<ESTreeConditionalExpression, 'test' | 'consequent' | 'alternate'> {
  test: ExpressionNode
  consequent: ExpressionNode
  alternate: ExpressionNode
}

export interface MemberExpression extends Omit<ESTreeMemberExpression, 'object' | 'property'> {
  object: ExpressionNode
  property: ExpressionNode
}

export interface CallExpression extends Omit<ESTreeCallExpression, 'callee' | 'arguments'> {
  type: 'CallExpression'
  callee: ExpressionNode
  arguments: Array<ExpressionNode | SpreadElement>
  optional: boolean
}

export interface ChainExpression extends Omit<ESTreeChainExpression, 'expression'> {
  expression: MemberExpression | CallExpression
}

export interface ArrayExpression extends Omit<ESTreeArrayExpression, 'elements'> {
  elements: Array<ExpressionNode | SpreadElement | null>
}

export interface Property extends Omit<ESTreeProperty, 'key' | 'value' | 'kind' | 'method'> {
  key: ExpressionNode
  value: ExpressionNode
  kind: 'init'
  method: false
}

export interface ObjectExpression extends Omit<ESTreeObjectExpression, 'properties'> {
  properties: Array<Property | SpreadElement>
}

export interface SpreadElement extends Omit<ESTreeSpreadElement, 'argument'> {
  argument: ExpressionNode
}

export interface SequenceExpression extends Omit<ESTreeSequenceExpression, 'expressions'> {
  expressions: ExpressionNode[]
}

export interface TemplateElement extends ESTreeTemplateElement {}

export interface TemplateLiteral extends Omit<ESTreeTemplateLiteral, 'quasis' | 'expressions'> {
  quasis: TemplateElement[]
  expressions: ExpressionNode[]
}

export interface TaggedTemplateExpression
  extends Omit<ESTreeTaggedTemplateExpression, 'tag' | 'quasi'> {
  tag: ExpressionNode
  quasi: TemplateLiteral
}

export interface AssignmentPattern extends Omit<ESTreeAssignmentPattern, 'left' | 'right'> {
  left: BindingPattern
  right: ExpressionNode
}

export interface AssignmentExpression extends Omit<ESTreeAssignmentExpression, 'left' | 'right'> {
  left: AssignmentTarget
  right: ExpressionNode
}

export interface RestElement extends Omit<ESTreeRestElement, 'argument'> {
  argument: BindingPattern
}

export interface ArrayPattern extends Omit<ESTreeArrayPattern, 'elements'> {
  elements: Array<BindingPattern | null>
}

export interface AssignmentProperty
  extends Omit<ESTreeAssignmentProperty, 'key' | 'value' | 'kind' | 'method'> {
  key: ExpressionNode
  value: BindingPattern
  kind: 'init'
  method: false
}

export interface ObjectPattern extends Omit<ESTreeObjectPattern, 'properties'> {
  properties: Array<AssignmentProperty | RestElement>
}

export type BindingPattern =
  | Identifier
  | AssignmentPattern
  | RestElement
  | ArrayPattern
  | ObjectPattern

export interface ArrowFunctionExpression
  extends Omit<ESTreeArrowFunctionExpression, 'params' | 'body'> {
  params: BindingPattern[]
  body: ExpressionNode
  expression: true
  generator: false
  async: false
}

/** Explicit ESTree extension for Hack-style pipelines. */
export interface PipelineExpression extends BaseNode {
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
  | AssignmentExpression
  | UpdateExpression
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
