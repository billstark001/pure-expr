import type { BindingPattern, ExpressionNode } from '../node-types.js'
import { JSParseError, type JSParserOptions } from './errors.js'

export function validateSourceLength(
  expression: string,
  options: Pick<JSParserOptions, 'maxSourceLength'>,
): void {
  const max = options.maxSourceLength
  if (max !== undefined && expression.length > max) {
    throw new JSParseError(`Expression exceeds maximum source length (${max})`)
  }
}

export function validateSyntaxBudget(
  ast: ExpressionNode | BindingPattern,
  options: JSParserOptions,
  rootKind: 'expression' | 'binding',
): void {
  let nodeCount = 0

  const bumpBudget = (depth: number): void => {
    nodeCount += 1
    if (options.maxAstNodes !== undefined && nodeCount > options.maxAstNodes) {
      throw new JSParseError(`Expression exceeds maximum AST node count (${options.maxAstNodes})`)
    }
    if (options.maxAstDepth !== undefined && depth > options.maxAstDepth) {
      throw new JSParseError(`Expression exceeds maximum AST depth (${options.maxAstDepth})`)
    }
  }

  const visitBinding = (binding: BindingPattern, depth: number): void => {
    bumpBudget(depth)
    switch (binding.type) {
      case 'Identifier':
        return
      case 'AssignmentPattern':
        visitBinding(binding.left, depth + 1)
        visit(binding.right, depth + 1)
        return
      case 'RestElement':
        visitBinding(binding.argument, depth + 1)
        return
      case 'ArrayPattern':
        for (const element of binding.elements) {
          if (element) visitBinding(element, depth + 1)
        }
        return
      case 'ObjectPattern':
        for (const property of binding.properties) {
          bumpBudget(depth + 1)
          if (property.type === 'RestElement') visitBinding(property.argument, depth + 2)
          else {
            if (property.computed) visit(property.key, depth + 2)
            visitBinding(property.value, depth + 2)
          }
        }
        return
    }
  }

  const visit = (node: ExpressionNode, depth: number): void => {
    bumpBudget(depth)
    switch (node.type) {
      case 'Literal':
      case 'Identifier':
      case 'TopicReference':
        return
      case 'ArrowFunctionExpression':
        for (const param of node.params) visitBinding(param, depth + 1)
        visit(node.body, depth + 1)
        return
      case 'AssignmentExpression':
        visit(node.left, depth + 1)
        visit(node.right, depth + 1)
        return
      case 'UpdateExpression':
        visit(node.argument, depth + 1)
        return
      case 'UnaryExpression':
      case 'AwaitExpression':
        visit(node.argument, depth + 1)
        return
      case 'BinaryExpression':
      case 'LogicalExpression':
      case 'PipelineExpression':
        visit(node.left, depth + 1)
        visit(node.right, depth + 1)
        return
      case 'ConditionalExpression':
        visit(node.test, depth + 1)
        visit(node.consequent, depth + 1)
        visit(node.alternate, depth + 1)
        return
      case 'MemberExpression':
        visit(node.object, depth + 1)
        visit(node.property, depth + 1)
        return
      case 'CallExpression':
        if (
          options.maxCallArguments !== undefined &&
          node.arguments.length > options.maxCallArguments
        ) {
          throw new JSParseError(
            `Expression exceeds maximum call argument count (${options.maxCallArguments})`,
          )
        }
        visit(node.callee, depth + 1)
        for (const argument of node.arguments) visit(argument, depth + 1)
        return
      case 'ChainExpression':
        visit(node.expression, depth + 1)
        return
      case 'ArrayExpression':
        if (
          options.maxArrayElements !== undefined &&
          node.elements.length > options.maxArrayElements
        ) {
          throw new JSParseError(
            `Expression exceeds maximum array element count (${options.maxArrayElements})`,
          )
        }
        for (const element of node.elements) {
          if (element) visit(element, depth + 1)
        }
        return
      case 'ObjectExpression':
        if (
          options.maxObjectProperties !== undefined &&
          node.properties.length > options.maxObjectProperties
        ) {
          throw new JSParseError(
            `Expression exceeds maximum object property count (${options.maxObjectProperties})`,
          )
        }
        for (const property of node.properties) {
          if (property.type === 'SpreadElement') visit(property.argument, depth + 1)
          else {
            visit(property.key, depth + 1)
            visit(property.value, depth + 1)
          }
        }
        return
      case 'SpreadElement':
        visit(node.argument, depth + 1)
        return
      case 'TemplateLiteral':
        if (
          options.maxTemplateExpressions !== undefined &&
          node.expressions.length > options.maxTemplateExpressions
        ) {
          throw new JSParseError(
            `Expression exceeds maximum template expression count (${options.maxTemplateExpressions})`,
          )
        }
        for (const expression of node.expressions) visit(expression, depth + 1)
        return
      case 'TaggedTemplateExpression':
        visit(node.tag, depth + 1)
        visit(node.quasi, depth + 1)
        return
      case 'SequenceExpression':
        for (const expression of node.expressions) visit(expression, depth + 1)
        return
    }
  }

  if (rootKind === 'expression') visit(ast as ExpressionNode, 1)
  else visitBinding(ast as BindingPattern, 1)
}
