import type { TemplateLiteral } from '../node-types.js'
import type { EmulatedTemplateStringsArray, TaggedTemplateArrayMode } from './types.js'

const SPEC_TEMPLATE_OBJECT_CACHE = new WeakMap<TemplateLiteral, EmulatedTemplateStringsArray>()
const LOOSE_TEMPLATE_OBJECT_CACHE = new WeakMap<TemplateLiteral, EmulatedTemplateStringsArray>()

function createTaggedTemplateObject(
  node: TemplateLiteral,
  mode: TaggedTemplateArrayMode,
): EmulatedTemplateStringsArray {
  const cooked = node.quasis.map((quasi) =>
    quasi.value.cooked === null ? undefined : quasi.value.cooked,
  )
  const raw = node.quasis.map((quasi) => quasi.value.raw)

  if (mode === 'loose') {
    return Object.assign(cooked, { raw }) as unknown as EmulatedTemplateStringsArray
  }

  const templateObject = cooked.slice() as Array<string | undefined>
  const rawObject = Object.freeze(raw.slice())

  Object.defineProperty(templateObject, 'raw', {
    value: rawObject,
    enumerable: false,
    writable: false,
    configurable: false,
  })

  return Object.freeze(templateObject) as unknown as EmulatedTemplateStringsArray
}

export function getTaggedTemplateObject(
  node: TemplateLiteral,
  mode: TaggedTemplateArrayMode,
): EmulatedTemplateStringsArray {
  const cache = mode === 'loose' ? LOOSE_TEMPLATE_OBJECT_CACHE : SPEC_TEMPLATE_OBJECT_CACHE
  const cached = cache.get(node)
  if (cached) return cached

  const created = createTaggedTemplateObject(node, mode)
  cache.set(node, created)
  return created
}
