import { CodeActionKind, commands, Diagnostic, diagnosticManager, ExtensionContext, languages, Range, window, workspace } from 'coc.nvim'

export function registerDiagnosticQuickfix(context: ExtensionContext): void {
  context.subscriptions.push(commands.registerCommand('vimls.disableDiagnostic', async (code: string) => {
    if (typeof code !== 'string' || !code) return
    const config = workspace.getConfiguration('vim')
    const disabled = config.get<string[]>('diagnostic.disabled', [])
    if (!disabled.includes(code)) {
      await config.update('diagnostic.disabled', [...disabled, code], true)
    }
  }, undefined, true))

  context.subscriptions.push(languages.registerCodeActionProvider(
    [{ language: 'vim', scheme: 'file' }, { language: 'vim', scheme: 'untitled' }],
    {
      async provideCodeActions(document, _range, _context, token) {
        const current = await workspace.document
        if (current.uri !== document.uri) return []
        const position = await window.getCursorPosition()
        if (token.isCancellationRequested) return []
        const disabled = workspace.getConfiguration('vim', document.uri).get<string[]>('diagnostic.disabled', [])
        let nearest: Diagnostic | undefined
        let distance = Infinity
        const lineRange = Range.create(position.line, 0, position.line, current.getline(position.line).length)
        for (const diagnostic of diagnosticManager.getDiagnosticsInRange(document, lineRange)) {
          if (diagnostic.source !== 'vimls') continue
          const { start, end } = diagnostic.range
          if (diagnostic.code == null || String(diagnostic.code) === '' || disabled.includes(String(diagnostic.code))) continue
          if (position.line < start.line || position.line > end.line) continue
          // A multiline range ending at column zero does not cover its final line.
          if (end.line > start.line && position.line === end.line && end.character === 0) continue
          const left = position.line === start.line ? start.character : 0
          const right = position.line === end.line ? end.character : Infinity
          const delta = Math.max(left - position.character, position.character - right, 0)
          if (delta < distance) {
            nearest = diagnostic
            distance = delta
          }
        }
        if (!nearest) return []
        const code = String(nearest.code)
        const title = `Disable diagnostic ${code}`
        return [{
          title,
          kind: CodeActionKind.QuickFix,
          diagnostics: [nearest],
          command: { title, command: 'vimls.disableDiagnostic', arguments: [code] },
        }]
      },
    },
    'vimls',
    [CodeActionKind.QuickFix],
  ))
}
