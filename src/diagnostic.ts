import { CodeActionKind, commands, ConfigurationTarget, Diagnostic, diagnosticManager, ExtensionContext, languages, Range, Uri, window, workspace, WorkspaceConfiguration } from 'coc.nvim'

export type DiagnosticRuleAction = 'enable' | 'disable' | 'error' | 'warning' | 'information' | 'hint' | 'resetSeverity'

export async function setDiagnosticRule(config: WorkspaceConfiguration, code: string, action: DiagnosticRuleAction, target: ConfigurationTarget): Promise<void> {
  const global = target === ConfigurationTarget.Global
  if (action === 'enable' || action === 'disable') {
    const inspected = config.inspect<string[]>('diagnostic.disabled')
    // A project list replaces the inherited list; preserve effective entries on
    // its first edit. User settings must not copy entries from a project.
    const disabled = global ? inspected?.globalValue ?? [] : config.get<string[]>('diagnostic.disabled', [])
    const value = disabled.filter(item => item !== code)
    if (action === 'disable') value.push(code)
    await config.update('diagnostic.disabled', value, target)
  } else {
    const inspected = config.inspect<Record<string, string>>('diagnostic.override')
    const value = { ...(global ? inspected?.globalValue : inspected?.workspaceFolderValue) }
    if (action === 'resetSeverity') delete value[code]
    else value[code] = action
    await config.update('diagnostic.override', Object.keys(value).length ? value : undefined, target)
  }
}

async function manageDiagnostics(code?: string): Promise<void> {
  const document = await workspace.document
  const root = Uri.file(workspace.rootPath)
  const config = workspace.getConfiguration('vim', root)
  if (!code) {
    const codes = new Set([
      ...config.get<string[]>('diagnostic.disabled', []),
      ...Object.keys(config.get<Record<string, string>>('diagnostic.override', {})),
    ])
    if (document) {
      for (const diagnostic of diagnosticManager.getDiagnosticsInRange(document.textDocument, Range.create(0, 0, document.lineCount, 0))) {
        if (diagnostic.source === 'vimls' && diagnostic.code != null) codes.add(String(diagnostic.code))
      }
    }
    const item = await window.showQuickPick([
      ...Array.from(codes).sort().map(code => ({ label: code, code })),
      { label: 'Enter diagnostic code…', code: '' },
    ], { title: 'Vim diagnostic rule' })
    if (!item) return
    code = item.code || await window.requestInput('Diagnostic code (for example vim/E117)')
  }
  if (typeof code !== 'string' || !code.trim()) return
  code = code.trim()
  const folder = workspace.getWorkspaceFolder(root)
  const targets = [{ label: 'User settings', target: ConfigurationTarget.Global }]
  if (folder) targets.push({ label: `Current project (${folder.name})`, target: ConfigurationTarget.WorkspaceFolder })
  const scope = await window.showQuickPick(targets, { title: `Configure ${code} in` })
  if (!scope) return
  const actions: { label: string; action: DiagnosticRuleAction }[] = [
    { label: 'Enable diagnostic', action: 'enable' },
    { label: 'Disable diagnostic', action: 'disable' },
    { label: 'Set severity: error', action: 'error' },
    { label: 'Set severity: warning', action: 'warning' },
    { label: 'Set severity: information', action: 'information' },
    { label: 'Set severity: hint', action: 'hint' },
    { label: 'Remove severity override from these settings', action: 'resetSeverity' },
  ]
  const item = await window.showQuickPick(actions, { title: code })
  if (!item) return
  // Re-read after the menus, preserving edits made while they were open.
  await setDiagnosticRule(workspace.getConfiguration('vim', root), code, item.action, scope.target)
}

export function registerDiagnosticQuickfix(context: ExtensionContext): void {
  context.subscriptions.push(commands.registerCommand('vimls.diagnostics', manageDiagnostics))
  context.subscriptions.push(commands.registerCommand('vimls.disableDiagnostic', async (code: string, uri?: string) => {
    if (typeof code !== 'string' || !code) return
    const config = workspace.getConfiguration('vim', uri)
    const target = Array.isArray(config.inspect<string[]>('diagnostic.disabled')?.workspaceFolderValue)
      ? ConfigurationTarget.WorkspaceFolder : ConfigurationTarget.Global
    await setDiagnosticRule(config, code, 'disable', target)
  }, undefined, true))

  context.subscriptions.push(languages.registerCodeActionProvider(
    [{ language: 'vim', scheme: 'file' }, { language: 'vim', scheme: 'untitled' }],
    {
      async provideCodeActions(document, _range, _context, token) {
        const current = await workspace.document
        if (current.uri !== document.uri) return []
        const position = await window.getCursorPosition()
        if (token.isCancellationRequested) return []
        const config = workspace.getConfiguration('vim', document.uri)
        const disabled = config.get<string[]>('diagnostic.disabled', [])
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
        const project = Array.isArray(config.inspect<string[]>('diagnostic.disabled')?.workspaceFolderValue)
        const title = `Disable diagnostic ${code}${project ? ' in project' : ''}`
        return [{
          title,
          kind: CodeActionKind.QuickFix,
          diagnostics: [nearest],
          command: { title, command: 'vimls.disableDiagnostic', arguments: [code, document.uri] },
        }]
      },
    },
    'vimls',
    [CodeActionKind.QuickFix],
  ))
}
