// #region Public template entrypoints

export {
  parseTemplate,
  type TemplateParseOptions,
  type TemplateRenderError,
  type TemplateSegment,
  type TemplateParseResult,
  type TemplateExpressionSegment,
  type TemplateTextSegment,
} from './parser.js'

export {
  compileTemplate,
  renderTemplate,
  type CompiledTemplate,
  type CompiledTemplateRenderOptions,
  type CompileTemplateOptions,
  type TemplateFormat,
  type RenderTemplateOptions,
  type TemplateRenderResult,
} from './renderer.js'

// #endregion
