import type { JSToken } from '../lexer/types.js'
import { JSParseError } from './errors.js'
import { FORBIDDEN_ARROW_REFERENCE_IDENTIFIERS } from './grammar.js'
import type {
  ArrowFunctionExpression,
  BindingPattern,
  ExpressionNode,
  Property,
} from './node-types.js'

export function assertValidLogicalMixing(
  operator: '&&' | '||' | '??',
  left: ExpressionNode,
  right: ExpressionNode,
  token: JSToken,
  parenthesizedNodes: WeakSet<ExpressionNode>,
  src: string,
): void {
  const mixesNullishWithBoolean =
    operator === '??'
      ? isUnparenthesizedShortCircuit(left, parenthesizedNodes) ||
        isUnparenthesizedShortCircuit(right, parenthesizedNodes)
      : isUnparenthesizedNullish(left, parenthesizedNodes) ||
        isUnparenthesizedNullish(right, parenthesizedNodes)

  if (mixesNullishWithBoolean) {
    throw new JSParseError("Cannot mix '??' with '&&' or '||' without parentheses", token, src)
  }
}

export function validateArrowFunction(node: ArrowFunctionExpression, src: string): void {
  const boundNames = new Set<string>()

  for (const param of node.params) {
    for (const name of collectBoundNames(param)) {
      if (boundNames.has(name)) {
        throw new JSParseError(
          `Duplicate parameter name '${name}' in arrow function`,
          undefined,
          src,
        )
      }
      boundNames.add(name)
    }
    validateBindingArrowReferences(param, src)
  }

  validateArrowReferences(node.body, src)
}

export function validateTopicUsage(
  node: ExpressionNode,
  parenthesizedNodes: WeakSet<ExpressionNode>,
  src: string,
): void {
  validateExpressionTopicUsage(node, false, parenthesizedNodes, src)
}

function collectBoundNames(binding: BindingPattern): string[] {
  switch (binding.type) {
    case 'Identifier':
      return [binding.name]
    case 'AssignmentPattern':
      return collectBoundNames(binding.left)
    case 'RestElement':
      return collectBoundNames(binding.argument)
    case 'ArrayPattern': {
      const names: string[] = []
      for (const element of binding.elements) {
        if (element) names.push(...collectBoundNames(element))
      }
      return names
    }
    case 'ObjectPattern': {
      const names: string[] = []
      for (const property of binding.properties) {
        names.push(
          ...collectBoundNames(
            property.type === 'RestElement' ? property.argument : property.value,
          ),
        )
      }
      return names
    }
  }
}

function validateBindingArrowReferences(binding: BindingPattern, src: string): void {
  switch (binding.type) {
    case 'Identifier':
      return
    case 'AssignmentPattern':
      validateBindingArrowReferences(binding.left, src)
      validateArrowReferences(binding.right, src)
      return
    case 'RestElement':
      validateBindingArrowReferences(binding.argument, src)
      return
    case 'ArrayPattern':
      for (const element of binding.elements) {
        if (element) validateBindingArrowReferences(element, src)
      }
      return
    case 'ObjectPattern':
      for (const property of binding.properties) {
        if (property.type === 'RestElement') {
          validateBindingArrowReferences(property.argument, src)
        } else {
          if (property.computed) validateArrowReferences(property.key, src)
          validateBindingArrowReferences(property.value, src)
        }
      }
      return
  }
}

function validateArrowReferences(node: ExpressionNode, src: string): void {
  switch (node.type) {
    case 'Literal':
    case 'TopicReference':
      return
    case 'Identifier':
      if (FORBIDDEN_ARROW_REFERENCE_IDENTIFIERS.has(node.name)) {
        throw new JSParseError(
          `Arrow functions do not support '${node.name}' in this context`,
          undefined,
          src,
        )
      }
      return
    case 'ArrowFunctionExpression':
      return
    case 'AssignmentExpression':
      validateArrowReferences(node.left, src)
      validateArrowReferences(node.right, src)
      return
    case 'UnaryExpression':
    case 'AwaitExpression':
      validateArrowReferences(node.argument, src)
      return
    case 'BinaryExpression':
    case 'LogicalExpression':
    case 'PipelineExpression':
      validateArrowReferences(node.left, src)
      validateArrowReferences(node.right, src)
      return
    case 'ConditionalExpression':
      validateArrowReferences(node.test, src)
      validateArrowReferences(node.consequent, src)
      validateArrowReferences(node.alternate, src)
      return
    case 'MemberExpression':
      validateArrowReferences(node.object, src)
      if (node.computed) validateArrowReferences(node.property, src)
      return
    case 'CallExpression':
      validateArrowReferences(node.callee, src)
      for (const argument of node.arguments) validateArrowReferences(argument, src)
      return
    case 'ChainExpression':
      validateArrowReferences(node.expression, src)
      return
    case 'ArrayExpression':
      for (const element of node.elements) {
        if (element) validateArrowReferences(element, src)
      }
      return
    case 'ObjectExpression':
      for (const property of node.properties) {
        if (property.type === 'SpreadElement') {
          validateArrowReferences(property.argument, src)
        } else {
          if (property.computed) validateArrowReferences(property.key, src)
          validateArrowReferences(property.value, src)
        }
      }
      return
    case 'SpreadElement':
      validateArrowReferences(node.argument, src)
      return
    case 'TemplateLiteral':
      for (const expression of node.expressions) validateArrowReferences(expression, src)
      return
    case 'TaggedTemplateExpression':
      validateArrowReferences(node.tag, src)
      validateArrowReferences(node.quasi, src)
      return
    case 'SequenceExpression':
      for (const expression of node.expressions) validateArrowReferences(expression, src)
      return
  }
}

function validateExpressionTopicUsage(
  node: ExpressionNode,
  allowTopic: boolean,
  parenthesizedNodes: WeakSet<ExpressionNode>,
  src: string,
): number {
  switch (node.type) {
    case 'Literal':
    case 'Identifier':
      return 0
    case 'TopicReference':
      if (!allowTopic) {
        throw new JSParseError(
          "Topic reference '%' is only allowed inside a pipeline body",
          undefined,
          src,
        )
      }
      return 1
    case 'ArrowFunctionExpression': {
      let topicCount = 0
      for (const param of node.params) {
        topicCount += validateBindingTopicUsage(param, allowTopic, parenthesizedNodes, src)
      }
      return (
        topicCount + validateExpressionTopicUsage(node.body, allowTopic, parenthesizedNodes, src)
      )
    }
    case 'AssignmentExpression':
      return (
        validateExpressionTopicUsage(node.left, allowTopic, parenthesizedNodes, src) +
        validateExpressionTopicUsage(node.right, allowTopic, parenthesizedNodes, src)
      )
    case 'UnaryExpression':
    case 'AwaitExpression':
      return validateExpressionTopicUsage(node.argument, allowTopic, parenthesizedNodes, src)
    case 'BinaryExpression':
    case 'LogicalExpression':
      return (
        validateExpressionTopicUsage(node.left, allowTopic, parenthesizedNodes, src) +
        validateExpressionTopicUsage(node.right, allowTopic, parenthesizedNodes, src)
      )
    case 'ConditionalExpression':
      return (
        validateExpressionTopicUsage(node.test, allowTopic, parenthesizedNodes, src) +
        validateExpressionTopicUsage(node.consequent, allowTopic, parenthesizedNodes, src) +
        validateExpressionTopicUsage(node.alternate, allowTopic, parenthesizedNodes, src)
      )
    case 'MemberExpression':
      return (
        validateExpressionTopicUsage(node.object, allowTopic, parenthesizedNodes, src) +
        validateExpressionTopicUsage(node.property, allowTopic, parenthesizedNodes, src)
      )
    case 'CallExpression': {
      let topicCount = validateExpressionTopicUsage(
        node.callee,
        allowTopic,
        parenthesizedNodes,
        src,
      )
      for (const argument of node.arguments) {
        topicCount += validateExpressionTopicUsage(argument, allowTopic, parenthesizedNodes, src)
      }
      return topicCount
    }
    case 'ChainExpression':
      return validateExpressionTopicUsage(node.expression, allowTopic, parenthesizedNodes, src)
    case 'ArrayExpression': {
      let topicCount = 0
      for (const element of node.elements) {
        if (element) {
          topicCount += validateExpressionTopicUsage(element, allowTopic, parenthesizedNodes, src)
        }
      }
      return topicCount
    }
    case 'ObjectExpression': {
      let topicCount = 0
      for (const property of node.properties) {
        topicCount += validatePropertyTopicUsage(property, allowTopic, parenthesizedNodes, src)
      }
      return topicCount
    }
    case 'SpreadElement':
      return validateExpressionTopicUsage(node.argument, allowTopic, parenthesizedNodes, src)
    case 'TemplateLiteral': {
      let topicCount = 0
      for (const expression of node.expressions) {
        topicCount += validateExpressionTopicUsage(expression, allowTopic, parenthesizedNodes, src)
      }
      return topicCount
    }
    case 'TaggedTemplateExpression':
      return (
        validateExpressionTopicUsage(node.tag, allowTopic, parenthesizedNodes, src) +
        validateExpressionTopicUsage(node.quasi, allowTopic, parenthesizedNodes, src)
      )
    case 'SequenceExpression': {
      let topicCount = 0
      for (const expression of node.expressions) {
        topicCount += validateExpressionTopicUsage(expression, allowTopic, parenthesizedNodes, src)
      }
      return topicCount
    }
    case 'PipelineExpression': {
      const outerTopicCount = validateExpressionTopicUsage(
        node.left,
        allowTopic,
        parenthesizedNodes,
        src,
      )
      validatePipeBodyTopicUsage(node.right, parenthesizedNodes, src)
      return outerTopicCount
    }
  }
}

function validatePropertyTopicUsage(
  property: Property | { type: 'SpreadElement'; argument: ExpressionNode },
  allowTopic: boolean,
  parenthesizedNodes: WeakSet<ExpressionNode>,
  src: string,
): number {
  if (property.type === 'SpreadElement') {
    return validateExpressionTopicUsage(property.argument, allowTopic, parenthesizedNodes, src)
  }
  return (
    (property.computed
      ? validateExpressionTopicUsage(property.key, allowTopic, parenthesizedNodes, src)
      : 0) + validateExpressionTopicUsage(property.value, allowTopic, parenthesizedNodes, src)
  )
}

function validateBindingTopicUsage(
  binding: BindingPattern,
  allowTopic: boolean,
  parenthesizedNodes: WeakSet<ExpressionNode>,
  src: string,
): number {
  switch (binding.type) {
    case 'Identifier':
      return 0
    case 'AssignmentPattern':
      return (
        validateBindingTopicUsage(binding.left, allowTopic, parenthesizedNodes, src) +
        validateExpressionTopicUsage(binding.right, allowTopic, parenthesizedNodes, src)
      )
    case 'RestElement':
      return validateBindingTopicUsage(binding.argument, allowTopic, parenthesizedNodes, src)
    case 'ArrayPattern': {
      let topicCount = 0
      for (const element of binding.elements) {
        if (element) {
          topicCount += validateBindingTopicUsage(element, allowTopic, parenthesizedNodes, src)
        }
      }
      return topicCount
    }
    case 'ObjectPattern': {
      let topicCount = 0
      for (const property of binding.properties) {
        if (property.type === 'RestElement') {
          topicCount += validateBindingTopicUsage(
            property.argument,
            allowTopic,
            parenthesizedNodes,
            src,
          )
        } else {
          if (property.computed) {
            topicCount += validateExpressionTopicUsage(
              property.key,
              allowTopic,
              parenthesizedNodes,
              src,
            )
          }
          topicCount += validateBindingTopicUsage(
            property.value,
            allowTopic,
            parenthesizedNodes,
            src,
          )
        }
      }
      return topicCount
    }
  }
}

function validatePipeBodyTopicUsage(
  node: ExpressionNode,
  parenthesizedNodes: WeakSet<ExpressionNode>,
  src: string,
): void {
  if (
    (node.type === 'ConditionalExpression' || node.type === 'ArrowFunctionExpression') &&
    !parenthesizedNodes.has(node)
  ) {
    throw new JSParseError(
      `Hack pipe body cannot be an unparenthesized ${node.type === 'ConditionalExpression' ? 'conditional expression' : 'arrow function'}`,
      undefined,
      src,
    )
  }

  if (validateExpressionTopicUsage(node, true, parenthesizedNodes, src) === 0) {
    throw new JSParseError("Hack pipe body must reference '%' at least once", undefined, src)
  }
}

function isUnparenthesizedNullish(
  node: ExpressionNode,
  parenthesizedNodes: WeakSet<ExpressionNode>,
): boolean {
  return (
    !parenthesizedNodes.has(node) && node.type === 'LogicalExpression' && node.operator === '??'
  )
}

function isUnparenthesizedShortCircuit(
  node: ExpressionNode,
  parenthesizedNodes: WeakSet<ExpressionNode>,
): boolean {
  return (
    !parenthesizedNodes.has(node) &&
    node.type === 'LogicalExpression' &&
    (node.operator === '&&' || node.operator === '||')
  )
}
