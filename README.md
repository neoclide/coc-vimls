<p align="center">
  <img src="https://raw.githubusercontent.com/neoclide/coc-vimls/main/assets/logo.svg" width="160" alt="coc-vimls logo">
</p>

# coc-vimls

[![CI](https://github.com/neoclide/coc-vimls/actions/workflows/test.yml/badge.svg)](https://github.com/neoclide/coc-vimls/actions/workflows/test.yml)

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
`vimls` output channel through `:CocCommand vimls.openOutput` or `:CocCommand workspace.showOutput`.

The extension automatically checks for new releases once a week in the background and notifies you when an update is available.

## Commands

- `vimls.update`: Check the latest GitHub release and install it if needed, then restart the language service.
- `vimls.restart`: Restart the `vimls-go` language server.
- `vimls.doctor`: Display health information, binary details, versions, and active runtimepath entries in the output channel.
- `vimls.openOutput`: Open the `vimls` output channel.
- `vimls.executeSelected`: Execute the currently selected Vim script lines (also exposed as a Code Action for nonempty visual selections). Automatically distinguishes between Vim9 script and legacy Vim script, executing Vim9 script with system Vim when running in Neovim.

## Code Actions

- `Disable diagnostic <code>`: A quickfix for the vimls diagnostic nearest the cursor on the current line. Adds its code to the user setting `vim.diagnostic.disabled`, preserving existing entries. Suppresses that diagnostic code across files.
- `Execute selected Vim script`: Available when selecting a nonempty range of Vim script code to execute directly in the running editor.


## Settings

Set options in `:CocConfig`:

| Setting | Default | Description |
| --- | --- | --- |
| `vimls.trace.server` | `"off"` | Protocol logging: `off`, `messages` or `verbose`. Updates dynamically; logs appear in the `vimls` output channel. |
| `vimls.command` | `""` | Custom executable path; empty uses managed GitHub releases. Reload after changing. |
| `vimls.args` | `[]` | Server arguments; retain stdio transport. Reload after changing. |
| `vimls.vimCommand` | `"vim"` | Path to system vim executable for executing Vim9 script in Neovim. |
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
