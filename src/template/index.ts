// #region Public template entrypoints

export {
  parseTemplate,
  type TemplateExpressionSegment,
  type TemplateParseOptions,
  type TemplateParseResult,
  type TemplateRenderError,
  type TemplateSegment,
  type TemplateSyntax,
  type TemplateTextSegment,
} from './parser.js'

export {
  type CompiledTemplate,
  type CompiledTemplateRenderOptions,
  type CompileTemplateOptions,
  compileTemplate,
  type RenderTemplateOptions,
  renderTemplate,
  type TemplateFormat,
  type TemplateRenderResult,
} from './renderer.js'

// #endregion
