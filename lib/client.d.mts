export declare const name: 'plugin-repo'
export declare const inject: readonly ['slots']
export declare function apply(ctx: import('@deepseek-ai/cordis').Context): void

declare const plugin: {
  name: typeof name
  inject: typeof inject
  apply: typeof apply
}

export default plugin
