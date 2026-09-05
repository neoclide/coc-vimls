# coc-vimls

Vim script and Vim9 script language support for coc.nvim, powered by
[vimls-go](https://github.com/neoclide/vimls-go).

Provides completion, diagnostics, hover, navigation, rename, formatting,
semantic highlighting, inlay hints and code lenses through the language server.

## Installation

Requires Node.js 22.15+ and coc.nvim 0.0.82 or newer.

```vim
:CocInstall coc-vimls
```

Open a Vim file. On first activation the extension queries the latest stable
GitHub release, downloads the matching binary with coc.nvim's `download` API,
verifies its SHA-256 checksum and caches it in the extension storage directory.
Later starts reuse the cached executable, including when offline. The first
installation and updates require access to GitHub. coc.nvim's HTTP proxy settings
apply to release queries and downloads.

macOS, Linux, Windows and FreeBSD are supported where the release contains a
binary matching the operating system and CPU architecture.

Remove any manually configured `languageserver.vimls` entry or competing Vim
language-server extension to avoid running duplicate servers.

## Updating

```vim
:CocCommand vimls.update
```

Checks the latest GitHub release and installs it if needed, then restarts the
language service. Failed downloads or checksum checks preserve the previous
installation and running service. After a successful installation, only the current
version and one previous version are retained in extension storage.

When `vimls.command` is configured, the command explains that the custom executable
must be updated manually. Clear that setting and reload the extension to return
to managed release downloads.

The service appears as `vimls` in `:CocList services`; logs are available in the
`vimls-go` output channel through `:CocCommand workspace.showOutput`.

## Settings

Set options in `:CocConfig`:

| Setting | Default | Description |
| --- | --- | --- |
| `vimls.trace.server` | `"off"` | Protocol logging: `off`, `messages` or `verbose`. Updates dynamically; logs appear in the `vimls-go` output channel. |
| `vimls.command` | `""` | Custom executable path; empty uses managed GitHub releases. Reload after changing. |
| `vimls.args` | `[]` | Server arguments; retain stdio transport. Reload after changing. |
| `vim.configFiles` | `[]` | Absolute paths/globs, including `~/`, treated as user configuration files. Restart the server after changing. |
| `vim.workspace.rebuildDebounce` | `100` | Workspace rebuild delay in milliseconds. |
| `vim.suggest.excludeRuntimePath` | `false` | Exclude completion items from runtime files outside the workspace. |
| `vim.diagnostic.disabled` | `[]` | Exact diagnostic codes to suppress. |
| `vim.diagnostic.override` | `{}` | Map codes to `error`, `warning`, `information` or `hint`. |
| `vim.diagnostic.maxNumber` | `1000` | Maximum diagnostics per document. |

Workspace, completion and diagnostic settings update dynamically. The extension
passes the editor's runtimepath at initialization and synchronizes
additions, removals and reordering with `vimls/didChangeRuntimepath`.

To use a local vimls-go build:

```sh
go -C /path/to/vimls-go build -o /path/to/vimls-go/bin/vimls ./cmd/vimls
```

```json
{
  "vimls.command": "/path/to/vimls-go/bin/vimls"
}
```

## Development

```sh
npm ci
mkdir -p .test-bin
go -C /path/to/vimls-go build -o "$PWD/.test-bin/vimls" ./cmd/vimls
npm run typecheck
npm run build
npm run test:nvim
npm run test:vim
npm pack --dry-run
```

Alternatively set `VIMLS_TEST_BIN` to a directory containing `vimls`.
Tests load TypeScript source through coc-test, exercise a real server in both
editors, and test the release update command against GitHub. The update test
requires network access. CI pins the server source used for local integration.
