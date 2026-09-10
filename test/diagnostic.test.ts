import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConfigurationTarget, WorkspaceConfiguration } from 'coc.nvim'
import { setDiagnosticRule } from '../src/diagnostic.ts'

type Settings = { 'diagnostic.disabled'?: string[]; 'diagnostic.override'?: Record<string, string> }
function configuration(user: Settings, project: Settings): WorkspaceConfiguration {
  return {
    has: (key: keyof Settings) => key in project || key in user,
    get: (key: keyof Settings, fallback: unknown) => project[key] ?? user[key] ?? fallback,
    inspect: (key: keyof Settings) => ({ key, globalValue: user[key], workspaceFolderValue: project[key] }),
    update: async (key: keyof Settings, value: any, target: ConfigurationTarget) => {
      (target === ConfigurationTarget.Global ? user : project)[key] = value
    },
  } as unknown as WorkspaceConfiguration
}

describe('diagnostic rule settings', () => {
  it('preserves inherited rules when disabling and re-enabling in a project', async () => {
    const user: Settings = { 'diagnostic.disabled': ['existing', 'target'] }
    const project: Settings = {}
    const config = configuration(user, project)
    await setDiagnosticRule(config, 'added', 'disable', ConfigurationTarget.WorkspaceFolder)
    await setDiagnosticRule(config, 'target', 'enable', ConfigurationTarget.WorkspaceFolder)
    assert.deepEqual(project['diagnostic.disabled'], ['existing', 'added'])
    assert.deepEqual(user['diagnostic.disabled'], ['existing', 'target'])
  })

  it('does not copy project rules into user settings', async () => {
    const user: Settings = { 'diagnostic.disabled': ['global'] }
    const project: Settings = { 'diagnostic.disabled': ['project-only'] }
    await setDiagnosticRule(configuration(user, project), 'target', 'disable', ConfigurationTarget.Global)
    assert.deepEqual(user['diagnostic.disabled'], ['global', 'target'])
    assert.deepEqual(project['diagnostic.disabled'], ['project-only'])
  })

  it('changes and removes only the selected severity override', async () => {
    const user: Settings = { 'diagnostic.override': { inherited: 'error' } }
    const project: Settings = { 'diagnostic.override': { existing: 'hint' } }
    const config = configuration(user, project)
    await setDiagnosticRule(config, 'target', 'warning', ConfigurationTarget.WorkspaceFolder)
    assert.deepEqual({ ...project['diagnostic.override'] }, { existing: 'hint', target: 'warning' })
    await setDiagnosticRule(config, 'target', 'resetSeverity', ConfigurationTarget.WorkspaceFolder)
    assert.deepEqual({ ...project['diagnostic.override'] }, { existing: 'hint' })
    assert.deepEqual(user['diagnostic.override'], { inherited: 'error' })
  })
})
