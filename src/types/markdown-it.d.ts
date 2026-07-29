declare module 'markdown-it' {
  type RendererRule = (
    tokens: any[],
    idx: number,
    options: any,
    env: any,
    self: any,
  ) => string

  class MarkdownIt {
    renderer: {
      rules: Record<string, RendererRule | undefined>
      renderToken(tokens: any[], idx: number, options: any): string
    }

    constructor(options?: Record<string, unknown>)
    render(source: string, env?: Record<string, unknown>): string
    use(plugin: any, ...params: any[]): this
  }

  export default MarkdownIt
}
