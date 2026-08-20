# dsh-plugin-repo

Persistent plugin repository for DeepSeek Harness — a **pure plugin** (no changes to any `@deepseek-ai/*` official package or engine source).

It has a **host half** (serves the repository over HTTP + registers `repo_*` model tools) and a **client half** (adds a "插件仓库" settings page). Non-official packages (anything whose name does **not** start with `@deepseek-ai/`) are listed, uploaded and pulled; official `@deepseek-ai/*` plugins are never listed or modified.

## Repository storage

`D:\0HAN\Work\plugin-repo\`
- `packages/<name>.tgz` — uploaded non-official install packages
- `index.json` — metadata (name, version, filename, size, uploadedAt)

## Settings page (client half)

After restart, Settings shows a "插件仓库" page (a `settings.section`, id `plugin-repo`):
- Lists installed non-official plugins (scanned from `~/.dsh/profiles/*/node_modules`, auto-excluding `@deepseek-ai/*`)
- Lists repository `.tgz` packages with a "拉取到本地" (download) action
- Upload a local `.tgz` to the repository, with optional package name

It talks to the host over the same-origin `/pluginrepo` REST API.

## HTTP API (served from the DSH web port, e.g. http://127.0.0.1:3080)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/pluginrepo` | HTML landing page |
| GET | `/pluginrepo/api/packages` | List repository `.tgz` packages |
| GET | `/pluginrepo/api/unofficial` | List non-official plugins (`{ installed, repo }`) |
| POST | `/pluginrepo/api/upload` | Upload a `.tgz` (raw body; `?name=` override optional) |
| GET | `/pluginrepo/download/<name>.tgz` | Download a repository `.tgz` |
| DELETE | `/pluginrepo/api/packages/<name>` | Delete a repository package |

## Model tools (available to every DSH session)

- `repo_list` — list repository `.tgz` packages
- `repo_unofficial` — detect/list non-official plugins (installed + repo)
- `repo_push` — upload a local `.tgz` (`sourcePath`, optional `name`)
- `repo_pull` — download a repository `.tgz` to a local path (`filename`, `targetPath`)
- `repo_delete` — remove a repository package (`filename`)

## Configuration

Optional plugin config: `repoDir` (absolute repository directory), `logLevel` (`silent` | `info`).
