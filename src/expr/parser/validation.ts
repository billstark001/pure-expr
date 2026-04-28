import type { JSToken } from '../lexer.js'
import type { JSArrowFunctionNode, JSBindingNode, JSExprNode } from '../node-types.js'
import { FORBIDDEN_ARROW_REFERENCE_IDENTIFIERS } from './grammar.js'
import { JSParseError } from './errors.js'

export function assertValidLogicalMixing(
  operator: '&&' | '||' | '??',
  left: JSExprNode,
  right: JSExprNode,
  token: JSToken,
  parenthesizedNodes: WeakSet<JSExprNode>,
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

export function validateArrowFunction(node: JSArrowFunctionNode, src: string): void {
  const boundNames = new Set<string>()

  for (const param of node.params) {
    for (const name of collectBoundNames(param.binding)) {
      if (boundNames.has(name)) {
        throw new JSParseError(
          `Duplicate parameter name '${name}' in arrow function`,
          undefined,
          src,
        )
      }
      boundNames.add(name)
    }

    validateBindingArrowReferences(param.binding, src)
  }

  validateArrowReferences(node.body, src)
}

export function validateTopicUsage(
  node: JSExprNode,
  parenthesizedNodes: WeakSet<JSExprNode>,
  src: string,
): void {
  validateExpressionTopicUsage(node, false, parenthesizedNodes, src)
}

function collectBoundNames(binding: JSBindingNode): string[] {
  switch (binding.type) {
    case 'binding-identifier':
      return [binding.name]
    case 'binding-assignment':
      return collectBoundNames(binding.left)
    case 'binding-array': {
      const names: string[] = []
      for (const element of binding.elements) {
        if (element) names.push(...collectBoundNames(element))
      }
      if (binding.rest) names.push(...collectBoundNames(binding.rest))
      return names
    }
    case 'binding-object': {
      const names: string[] = []
      for (const prop of binding.properties) names.push(...collectBoundNames(prop.value))
      if (binding.rest) names.push(binding.rest.name)
      return names
    }
  }
}

function validateBindingArrowReferences(binding: JSBindingNode, src: string): void {
  switch (binding.type) {
    case 'binding-identifier':
      return
    case 'binding-assignment':
      validateBindingArrowReferences(binding.left, src)
      validateArrowReferences(binding.defaultValue, src)
      return
    case 'binding-array':
      for (const element of binding.elements) {
        if (element) validateBindingArrowReferences(element, src)
      }
      if (binding.rest) validateBindingArrowReferences(binding.rest, src)
      return
    case 'binding-object':
      for (const prop of binding.properties) {
        if (prop.computed) validateArrowReferences(prop.key, src)
        validateBindingArrowReferences(prop.value, src)
      }
      return
  }
}

function validateArrowReferences(node: JSExprNode, src: string): void {
  switch (node.type) {
    case 'literal':
    case 'regex':
    case 'topic':
      return
    case 'identifier':
      if (FORBIDDEN_ARROW_REFERENCE_IDENTIFIERS.has(node.name)) {
        throw new JSParseError(
          `Arrow functions do not support '${node.name}' in this context`,
          undefined,
          src,
        )
      }
      return
    case 'arrow-function':
      return
    case 'unary':
      validateArrowReferences(node.operand, src)
      return
    case 'binary':
    case 'logical':
      validateArrowReferences(node.left, src)
      validateArrowReferences(node.right, src)
      return
    case 'conditional':
      validateArrowReferences(node.test, src)
      validateArrowReferences(node.consequent, src)
      validateArrowReferences(node.alternate, src)
      return
    case 'member':
      validateArrowReferences(node.object, src)
      if (node.computed) validateArrowReferences(node.property, src)
      return
    case 'call':
      validateArrowReferences(node.callee, src)
      for (const arg of node.args) validateArrowReferences(arg, src)
      return
    case 'array':
      for (const element of node.elements) {
        if (element) validateArrowReferences(element, src)
      }
      return
    case 'object':
      for (const prop of node.props) {
        if (prop.type === 'spread') {
          validateArrowReferences(prop.argument, src)
        } else {
          if (prop.computed) validateArrowReferences(prop.key, src)
          validateArrowReferences(prop.value, src)
        }
      }
      return
    case 'spread':
      validateArrowReferences(node.argument, src)
      return
    case 'template':
      if (node.tag) validateArrowReferences(node.tag, src)
      for (const expression of node.expressions) validateArrowReferences(expression, src)
      return
    case 'sequence':
      for (const expression of node.expressions) validateArrowReferences(expression, src)
      return
    case 'pipeline':
      validateArrowReferences(node.left, src)
      validateArrowReferences(node.right, src)
      return
  }
}

function validateExpressionTopicUsage(
  node: JSExprNode,
  allowTopic: boolean,
  parenthesizedNodes: WeakSet<JSExprNode>,
  src: string,
): number {
  switch (node.type) {
    case 'literal':
    case 'regex':
    case 'identifier':
      return 0
    case 'topic':
      if (!allowTopic) {
        throw new JSParseError(
          "Topic reference '%' is only allowed inside a pipeline body",
          undefined,
          src,
        )
      }
      return 1
    case 'arrow-function': {
      let topicCount = 0
      for (const param of node.params) {
        topicCount += validateBindingTopicUsage(param.binding, allowTopic, parenthesizedNodes, src)
      }
      topicCount += validateExpressionTopicUsage(node.body, allowTopic, parenthesizedNodes, src)
      return topicCount
    }
    case 'unary':
      return validateExpressionTopicUsage(node.operand, allowTopic, parenthesizedNodes, src)
    case 'binary':
    case 'logical':
      return (
        validateExpressionTopicUsage(node.left, allowTopic, parenthesizedNodes, src) +
        validateExpressionTopicUsage(node.right, allowTopic, parenthesizedNodes, src)
      )
    case 'conditional':
      return (
        validateExpressionTopicUsage(node.test, allowTopic, parenthesizedNodes, src) +
        validateExpressionTopicUsage(node.consequent, allowTopic, parenthesizedNodes, src) +
        validateExpressionTopicUsage(node.alternate, allowTopic, parenthesizedNodes, src)
      )
    case 'member':
      return (
        validateExpressionTopicUsage(node.object, allowTopic, parenthesizedNodes, src) +
        validateExpressionTopicUsage(node.property, allowTopic, parenthesizedNodes, src)
      )
    case 'call': {
      let topicCount = validateExpressionTopicUsage(
        node.callee,
        allowTopic,
        parenthesizedNodes,
        src,
      )
      for (const arg of node.args) {
        topicCount += validateExpressionTopicUsage(arg, allowTopic, parenthesizedNodes, src)
      }
      return topicCount
    }
    case 'array': {
      let topicCount = 0
      for (const element of node.elements) {
        if (element !== null) {
          topicCount += validateExpressionTopicUsage(element, allowTopic, parenthesizedNodes, src)
        }
      }
      return topicCount
    }
    case 'object': {
      let topicCount = 0
      for (const prop of node.props) {
        topicCount +=
          prop.type === 'spread'
            ? validateExpressionTopicUsage(prop.argument, allowTopic, parenthesizedNodes, src)
            : (prop.computed
                ? validateExpressionTopicUsage(prop.key, allowTopic, parenthesizedNodes, src)
                : 0) + validateExpressionTopicUsage(prop.value, allowTopic, parenthesizedNodes, src)
      }
      return topicCount
    }
    case 'spread':
      return validateExpressionTopicUsage(node.argument, allowTopic, parenthesizedNodes, src)
    case 'template': {
      let topicCount = node.tag
        ? validateExpressionTopicUsage(node.tag, allowTopic, parenthesizedNodes, src)
        : 0
      for (const expression of node.expressions) {
        topicCount += validateExpressionTopicUsage(expression, allowTopic, parenthesizedNodes, src)
      }
      return topicCount
    }
    case 'sequence': {
      let topicCount = 0
      for (const expression of node.expressions) {
        topicCount += validateExpressionTopicUsage(expression, allowTopic, parenthesizedNodes, src)
      }
      return topicCount
    }
    case 'pipeline': {
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

function validateBindingTopicUsage(
  binding: JSBindingNode,
  allowTopic: boolean,
  parenthesizedNodes: WeakSet<JSExprNode>,
  src: string,
): number {
  switch (binding.type) {
    case 'binding-identifier':
      return 0
    case 'binding-assignment':
      return (
        validateBindingTopicUsage(binding.left, allowTopic, parenthesizedNodes, src) +
        validateExpressionTopicUsage(binding.defaultValue, allowTopic, parenthesizedNodes, src)
      )
    case 'binding-array': {
      let topicCount = 0
      for (const element of binding.elements) {
        if (element) {
          topicCount += validateBindingTopicUsage(element, allowTopic, parenthesizedNodes, src)
        }
      }
      if (binding.rest) {
        topicCount += validateBindingTopicUsage(binding.rest, allowTopic, parenthesizedNodes, src)
      }
      return topicCount
    }
    case 'binding-object': {
      let topicCount = 0
      for (const prop of binding.properties) {
        if (prop.computed) {
          topicCount += validateExpressionTopicUsage(prop.key, allowTopic, parenthesizedNodes, src)
        }
        topicCount += validateBindingTopicUsage(prop.value, allowTopic, parenthesizedNodes, src)
      }
      return topicCount
    }
  }
}

function validatePipeBodyTopicUsage(
  node: JSExprNode,
  parenthesizedNodes: WeakSet<JSExprNode>,
  src: string,
): void {
  if (
    (node.type === 'conditional' || node.type === 'arrow-function') &&
    !parenthesizedNodes.has(node)
  ) {
    throw new JSParseError(
      `Hack pipe body cannot be an unparenthesized ${node.type === 'conditional' ? 'conditional expression' : 'arrow function'}`,
      undefined,
      src,
    )
  }

  if (validateExpressionTopicUsage(node, true, parenthesizedNodes, src) === 0) {
    throw new JSParseError("Hack pipe body must reference '%' at least once", undefined, src)
  }
}

function isUnparenthesizedNullish(
  node: JSExprNode,
  parenthesizedNodes: WeakSet<JSExprNode>,
): boolean {
  return !parenthesizedNodes.has(node) && node.type === 'logical' && node.operator === '??'
}

function isUnparenthesizedShortCircuit(
  node: JSExprNode,
  parenthesizedNodes: WeakSet<JSExprNode>,
): boolean {
  return (
    !parenthesizedNodes.has(node) &&
    node.type === 'logical' &&
    (node.operator === '&&' || node.operator === '||')
  )
}
