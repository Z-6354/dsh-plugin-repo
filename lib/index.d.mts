export interface PluginRepoConfig {
  repoFile?: string
  logLevel?: 'silent' | 'info'
}

export declare const Config: import('@deepseek-ai/schemastery').S<PluginRepoConfig>
export declare const name: 'plugin-repo'
export declare const inject: readonly ['fs', 'webServer', 'sandboxPolicy', 'tools']
export declare function apply(ctx: import('@deepseek-ai/cordis').Context, config?: PluginRepoConfig): void

declare const plugin: {
  name: typeof name
  inject: typeof inject
  Config: typeof Config
  apply: typeof apply
}

export default plugin
