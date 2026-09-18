import type { ArrowFunctionExpression, ExpressionNode } from '../node-types.js'
import {
  collectArrowBoundNames,
  compileArrowBinding,
  getArrowExpectedArgumentCount,
} from './arrows.js'
import {
  type CompiledArrowRuntime,
  type CompiledNodeEvaluator,
  type EvalState,
  PERFORMANCE_ARROW_RUNTIME_CACHE,
} from './types.js'

export interface CompileRuntimeOptions {
  evalArrowFunction(node: ArrowFunctionExpression, state: EvalState): unknown
  evalNode(node: ExpressionNode, state: EvalState): unknown
}

export interface CompileRuntime {
  compileNode(node: ExpressionNode): CompiledNodeEvaluator
  getCompiledArrowRuntime(node: ArrowFunctionExpression): CompiledArrowRuntime
}

/**
 * Creates the cached arrow runtime. The AST is already immutable execution data, so the
 * compiled evaluator delegates to the shared ESTree evaluator while parameter binders are
 * precompiled and cached per arrow node.
 */
export function createCompileRuntime(options: CompileRuntimeOptions): CompileRuntime {
  const compileNode =
    (node: ExpressionNode): CompiledNodeEvaluator =>
    (state) =>
      options.evalNode(node, state)

  function getCompiledArrowRuntime(node: ArrowFunctionExpression): CompiledArrowRuntime {
    const cached = PERFORMANCE_ARROW_RUNTIME_CACHE.get(node)
    if (cached) return cached

    const compiled = {
      body: compileNode(node.body),
      params: node.params.map((param) => ({
        rest: param.type === 'RestElement',
        bind: compileArrowBinding(param, compileNode),
      })),
      boundNames: collectArrowBoundNames(node.params),
      expectedArgumentCount: getArrowExpectedArgumentCount(node.params),
    } satisfies CompiledArrowRuntime

    PERFORMANCE_ARROW_RUNTIME_CACHE.set(node, compiled)
    return compiled
  }

  return { compileNode, getCompiledArrowRuntime }
}
