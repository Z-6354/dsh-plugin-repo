# dsh-plugin-repo

Self-hosted plugin repository for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — a **pure Cordis plugin** (no changes to `@deepseek-ai/*` packages).

Each device runs its own repo over HTTP: list / upload / download `.tgz`, detect non-official plugins, install with version checks, and **pull or push** packages across devices. Official `@deepseek-ai/*` plugins are never listed or modified.

## Install

```bash
# from npm
dsh plugin --profile web add dsh-plugin-repo

# or from a release tarball
dsh plugin --profile web add ./dsh-plugin-repo-1.5.2.tgz
```

Restart DSH, then open **Settings → 插件仓库**. Prefer a hard refresh (`Ctrl+Shift+R`) after upgrades.

## Settings UI (v1.5)

| Tab | Purpose |
| --- | --- |
| **本机仓库** | List local `.tgz`, install, manual upload |
| **跨设备同步** | Connect to another DSH; **pull → local** or **push → remote** |
| **已安装** | Pack-upload installed non-official plugins into the local repo |
| **高级** | Extra search roots for discovering plugins |

Cross-device sync uses a dual pane (local | remote). Badges show concrete versions (`本机 1.5.2 > 对方 1.5.0`). Use **选需推送** / **选需拉取** to select only packages that differ (including **version unknown → default push**). Push confirms warn on downgrade; equal packages show as already synced. **最近推送** records persist under `repoDir/push-history.json` across restarts and explain whether remote was already unknown vs push stripped the version.

## Repository storage

Default under the configured `repoDir` (often `~/.dsh/plugin-repo` or a custom path):

- `packages/<name>.tgz` — non-official packages
- `index.json` — metadata (`name`, `version`, `filename`, `size`, `uploadedAt`)

## HTTP API (on the DSH web port, e.g. `http://127.0.0.1:3080`)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/pluginrepo` | HTML landing |
| GET | `/pluginrepo/api/packages` | List repo packages |
| GET | `/pluginrepo/api/unofficial` | Installed + repo non-official plugins |
| POST | `/pluginrepo/api/upload` | Upload `.tgz` (raw body; `?name=` optional) |
| GET | `/pluginrepo/download/<file>.tgz` | Download |
| POST | `/pluginrepo/api/remote-pull` | Pull from another device into **this** repo |
| POST | `/pluginrepo/api/remote-push` | Push local-repo `.tgz` to another device |
| POST | `/pluginrepo/api/install` | Plan / confirm install into local profile |
| DELETE | `/pluginrepo/api/packages/<key>` | Delete a repo package |

Remote address rules: bare host → `http` + port `3080`; `https://` → port `443`; explicit `:port` wins.

## Model tools

- `repo_list` / `repo_unofficial` / `repo_push` / `repo_pull` / `repo_delete`
- `repo_remote` / `repo_remote_pull` / `repo_remote_push`
- `repo_install` (requires `installConfirm=true` to apply)

## Configuration

Optional plugin config:

- `repoDir` — absolute repository directory
- `logLevel` — `silent` | `info`

> **Note:** Use schemastery-style config (fields optional by default). Do **not** call zod’s `.optional()` on schemastery schemas.

## License

MIT
