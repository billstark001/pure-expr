import type {
  ArrayExpression as PublicArrayExpression,
  ArrayPattern as PublicArrayPattern,
  ArrowFunctionExpression as PublicArrowFunctionExpression,
  AssignmentExpression as PublicAssignmentExpression,
  AssignmentPattern as PublicAssignmentPattern,
  AssignmentProperty as PublicAssignmentProperty,
  AwaitExpression as PublicAwaitExpression,
  BinaryExpression as PublicBinaryExpression,
  CallExpression as PublicCallExpression,
  ChainExpression as PublicChainExpression,
  ConditionalExpression as PublicConditionalExpression,
  Identifier as PublicIdentifier,
  Literal as PublicLiteral,
  LogicalExpression as PublicLogicalExpression,
  MemberExpression as PublicMemberExpression,
  ObjectExpression as PublicObjectExpression,
  ObjectPattern as PublicObjectPattern,
  PipelineExpression as PublicPipelineExpression,
  Property as PublicProperty,
  RestElement as PublicRestElement,
  SequenceExpression as PublicSequenceExpression,
  SpreadElement as PublicSpreadElement,
  TaggedTemplateExpression as PublicTaggedTemplateExpression,
  TemplateElement as PublicTemplateElement,
  TemplateLiteral as PublicTemplateLiteral,
  TopicReference as PublicTopicReference,
  UnaryExpression as PublicUnaryExpression,
  UpdateExpression as PublicUpdateExpression,
} from '../node-types.js'

/** Parser-only offsets used to build and validate the public ESTree tree. */
export interface SourceOffsets {
  start: number
  end: number
}

export type Literal = PublicLiteral & SourceOffsets
export interface Identifier extends PublicIdentifier, SourceOffsets {}
export interface TopicReference extends PublicTopicReference, SourceOffsets {}

export interface UnaryExpression extends Omit<PublicUnaryExpression, 'argument'>, SourceOffsets {
  argument: ExpressionNode
}

export interface UpdateExpression extends Omit<PublicUpdateExpression, 'argument'>, SourceOffsets {
  argument: Identifier
}

export interface AwaitExpression extends Omit<PublicAwaitExpression, 'argument'>, SourceOffsets {
  argument: ExpressionNode
}

export interface BinaryExpression
  extends Omit<PublicBinaryExpression, 'left' | 'right'>,
    SourceOffsets {
  left: ExpressionNode
  right: ExpressionNode
}

export interface LogicalExpression
  extends Omit<PublicLogicalExpression, 'left' | 'right'>,
    SourceOffsets {
  left: ExpressionNode
  right: ExpressionNode
}

export interface ConditionalExpression
  extends Omit<PublicConditionalExpression, 'test' | 'consequent' | 'alternate'>,
    SourceOffsets {
  test: ExpressionNode
  consequent: ExpressionNode
  alternate: ExpressionNode
}

export interface MemberExpression
  extends Omit<PublicMemberExpression, 'object' | 'property'>,
    SourceOffsets {
  object: ExpressionNode
  property: ExpressionNode
}

export interface CallExpression
  extends Omit<PublicCallExpression, 'callee' | 'arguments'>,
    SourceOffsets {
  callee: ExpressionNode
  arguments: Array<ExpressionNode | SpreadElement>
}

export interface ChainExpression extends Omit<PublicChainExpression, 'expression'>, SourceOffsets {
  expression: MemberExpression | CallExpression
}

export interface ArrayExpression extends Omit<PublicArrayExpression, 'elements'>, SourceOffsets {
  elements: Array<ExpressionNode | SpreadElement | null>
}

export interface Property extends Omit<PublicProperty, 'key' | 'value'>, SourceOffsets {
  key: ExpressionNode
  value: ExpressionNode
}

export interface ObjectExpression
  extends Omit<PublicObjectExpression, 'properties'>,
    SourceOffsets {
  properties: Array<Property | SpreadElement>
}

export interface SpreadElement extends Omit<PublicSpreadElement, 'argument'>, SourceOffsets {
  argument: ExpressionNode
}

export interface SequenceExpression
  extends Omit<PublicSequenceExpression, 'expressions'>,
    SourceOffsets {
  expressions: ExpressionNode[]
}

export interface TemplateElement extends PublicTemplateElement, SourceOffsets {}

export interface TemplateLiteral
  extends Omit<PublicTemplateLiteral, 'quasis' | 'expressions'>,
    SourceOffsets {
  quasis: TemplateElement[]
  expressions: ExpressionNode[]
}

export interface TaggedTemplateExpression
  extends Omit<PublicTaggedTemplateExpression, 'tag' | 'quasi'>,
    SourceOffsets {
  tag: ExpressionNode
  quasi: TemplateLiteral
}

export interface AssignmentPattern
  extends Omit<PublicAssignmentPattern, 'left' | 'right'>,
    SourceOffsets {
  left: BindingPattern
  right: ExpressionNode
}

export interface AssignmentExpression
  extends Omit<PublicAssignmentExpression, 'left' | 'right'>,
    SourceOffsets {
  left: Identifier
  right: ExpressionNode
}

export interface RestElement extends Omit<PublicRestElement, 'argument'>, SourceOffsets {
  argument: BindingPattern
}

export interface ArrayPattern extends Omit<PublicArrayPattern, 'elements'>, SourceOffsets {
  elements: Array<BindingPattern | null>
}

export interface AssignmentProperty
  extends Omit<PublicAssignmentProperty, 'key' | 'value'>,
    SourceOffsets {
  key: ExpressionNode
  value: BindingPattern
}

export interface ObjectPattern extends Omit<PublicObjectPattern, 'properties'>, SourceOffsets {
  properties: Array<AssignmentProperty | RestElement>
}

export type BindingPattern =
  | Identifier
  | AssignmentPattern
  | RestElement
  | ArrayPattern
  | ObjectPattern

export interface ArrowFunctionExpression
  extends Omit<PublicArrowFunctionExpression, 'params' | 'body'>,
    SourceOffsets {
  params: BindingPattern[]
  body: ExpressionNode
}

export interface PipelineExpression
  extends Omit<PublicPipelineExpression, 'left' | 'right'>,
    SourceOffsets {
  left: ExpressionNode
  right: ExpressionNode
}

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
