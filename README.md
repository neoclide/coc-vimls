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

If installation or startup fails, `vimls.doctor` remains available with the last
error and cache information. Fix the cause, then run `vimls.restart` to retry
without reloading the extension.

## Updating

```vim
:CocCommand vimls.update
```

Checks the latest GitHub release and installs it if needed, then restarts the
language service. Failed downloads or checksum checks preserve the previous
installation and running service. After a successful installation, only the current
version and one previous version are retained in extension storage. If the new
server fails to start, the extension restores the previous binary and restarts it.
Use `:CocCommand vimls.rollback` to return to the previous installation manually.

When `vimls.command` is configured, the command explains that the custom executable
must be updated manually. Clear that setting and reload the extension to return
to managed release downloads.

The service appears as `vimls` in `:CocList services`; logs are available in the
`vimls` output channel through `:CocCommand vimls.openOutput` or `:CocCommand workspace.showOutput`.

The extension checks for new releases once a week in the background and notifies
you when an update is available. Set `vimls.checkForUpdates` to `false` to disable
these checks; initial installation and `vimls.update` still work.

## Commands

- `vimls.update`: Check the latest GitHub release and install it if needed, then restart the language service.
- `vimls.rollback`: Switch back to the previous managed installation and restart. Unavailable for custom executables.
- `vimls.restart`: Restart the `vimls-go` language server.
- `vimls.doctor`: Display the running binary and server-reported version, startup arguments, last error, managed cache details, and active runtimepath entries in the output channel.
- `vimls.openOutput`: Open the `vimls` output channel.
- `vimls.diagnostics`: Enable or disable diagnostic codes and edit severity overrides in user or current project settings.
- `vimls.executeSelected`: Execute the currently selected Vim script lines (also exposed as a Code Action for nonempty visual selections). Automatically distinguishes between Vim9 script and legacy Vim script, executing Vim9 script with system Vim when running in Neovim.

## Code Actions

- `Disable diagnostic <code>`: A quickfix for the vimls diagnostic nearest the cursor on the current line. Adds its code to the user setting `vim.diagnostic.disabled`, preserving existing entries. Suppresses that diagnostic code across files.
- `Execute selected Vim script`: Available when selecting a nonempty range of Vim script code to execute directly in the running editor.


## Executing selections

Legacy Vim script runs in the current editor. In Vim with Vim9 support, complete
lines of Vim9 script are sourced directly from the current buffer, preserving
its filename, relative imports and script-local state from previous execution.
The extension never automatically executes code outside the selection.

In Neovim, Vim9 script runs in a separate system Vim process. File-backed
selections use the original filename for relative imports and `<sfile>`, without
reading or modifying the original file. Imports and variables needed by the
snippet must be included in the selection. This also applies to partial-line
Vim9 selections in Vim when a filename is available; they run as independent
snippets to avoid executing the rest of the line. Unnamed standalone snippets
use a temporary script. `vimls.vimCommand` selects the external Vim executable.

## Diagnostic rules

Run `:CocCommand vimls.diagnostics` to select a diagnostic from the current file,
a disabled rule or an existing severity override. You can also enter a code.
Choose user settings or the current project's `.vim/coc-settings.json`, then
choose the action. The project option is available when coc.nvim has a workspace
folder for its current root. The language server uses one set of settings for the
workspace; this is not per-buffer suppression.

Enabling a rule removes it from that scope's disabled list. Severity changes do
not re-enable disabled rules. Removing a project severity override restores the
inherited user setting, if any. The existing quickfix still disables the nearest
diagnostic globally in one action.

## Settings

Set options in `:CocConfig`:

| Setting | Default | Description |
| --- | --- | --- |
| `vimls.trace.server` | `"off"` | Protocol logging: `off`, `messages` or `verbose`. Updates dynamically; logs appear in the `vimls` output channel. |
| `vimls.checkForUpdates` | `true` | Check for releases weekly in the background. |
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
Tests load TypeScript source through coc-test and exercise a real server in both
editors. Download tests use a local HTTP fixture and do not access GitHub. CI pins the server source used for local integration.
