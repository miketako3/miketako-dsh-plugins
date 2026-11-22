import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '../src/index.ts'
import { loadSkillContent, registerSkill, SKILL_PATH, stripFrontmatter } from '../src/skill.ts'

interface Registration {
  name: string
  description: string
  content: string
  source: string
  path?: string
}

/** Minimal context surface used by the plugin. */
function fakeContext(registrations: Registration[]) {
  const warnings: unknown[][] = []
  const mounted: unknown[][] = []
  const ctx = {
    skills: {
      register(skill: Registration) {
        registrations.push(skill)
        return () => {}
      },
    },
    effect(body: () => () => void) {
      body()
    },
    logger: {
      warn(...args: unknown[]) {
        warnings.push(args)
      },
    },
    plugin: vi.fn(async (...args: unknown[]) => {
      mounted.push(args)
    }),
  }
  return { ctx: ctx as unknown as Context, warnings, mounted }
}

/** Importable module source for a fake optional plugin. */
function moduleUrl(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`
}

describe('antigravity-acp config', () => {
  it('materializes the documented defaults', () => {
    const config = Config({})
    expect(config.providerName).toBe('antigravity')
    expect(config.toolName).toBe('subagent_antigravity')
    expect(config.command).toBe('agy')
    expect(config.args).toEqual(['acp', '--sandbox', '--disable-telemetry'])
    expect(config.permission).toBe('reject')
    expect(config.autoConfigure).toBe(true)
  })
})

describe('embedded skill', () => {
  it('matches the standalone repository skill byte for byte', () => {
    const standalone = readFileSync(new URL('../../../skills/antigravity-acp/SKILL.md', import.meta.url), 'utf8')
    const asset = readFileSync(new URL('../assets/SKILL.md', import.meta.url), 'utf8')
    expect(asset).toBe(standalone)
  })

  it('strips frontmatter and keeps the skill body', () => {
    const raw = readFileSync(SKILL_PATH, 'utf8')
    expect(raw.startsWith('---\n')).toBe(true)
    const body = stripFrontmatter(raw)
    expect(body.startsWith('# Antigravity ACP subagent')).toBe(true)
    expect(body).not.toContain('name: antigravity-acp')
  })

  it('adds plugin-specific mounting guidance', () => {
    const config = Config({})
    const content = loadSkillContent(config)
    expect(content).toContain('dsh-plugin-antigravity-acp')
    expect(content).toContain('antigravity')
    expect(content).toContain('subagent_antigravity')
    expect(content).toContain('## Preflight')
  })

  it('registers a model- and user-invocable bundled skill', () => {
    const registrations: Registration[] = []
    const { ctx } = fakeContext(registrations)
    registerSkill(ctx, Config({}))
    expect(registrations).toHaveLength(1)
    expect(registrations[0]).toMatchObject({
      name: 'antigravity-acp',
      source: 'bundled',
      path: SKILL_PATH,
    })
    expect(registrations[0]?.content).toContain('# Antigravity ACP subagent')
  })
})

describe('optional backend mounting', () => {
  const temporary: string[] = []
  afterEach(() => {
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
  })

  function profileFixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'antigravity-acp-'))
    temporary.push(root)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true }))
    for (const name of ['fake-backend', 'fake-tool']) {
      const dir = join(root, 'node_modules', name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.js' }))
      writeFileSync(join(dir, 'index.js'), `export const name = ${JSON.stringify(name)}; export function apply() {}\n`)
    }
    return root
  }

  it('skips dynamic mounting when autoConfigure is false', async () => {
    const registrations: Registration[] = []
    const { ctx, mounted } = fakeContext(registrations)
    await apply(ctx, Config({ autoConfigure: false }))
    expect(registrations).toHaveLength(1)
    expect(mounted).toHaveLength(0)
  })

  it('mounts a fake backend and tool when both modules import', async () => {
    const registrations: Registration[] = []
    const { ctx, mounted, warnings } = fakeContext(registrations)
    const backend = moduleUrl('export const name = "fake-backend"; export function apply() {}')
    const tool = moduleUrl('export const name = "fake-tool"; export function apply() {}')
    await apply(ctx, Config({ backendModule: backend, toolModule: tool, autoConfigure: true }))

    expect(warnings).toHaveLength(0)
    expect(mounted).toHaveLength(2)
    expect(mounted[0]?.[1]).toMatchObject({
      providerName: 'antigravity',
      command: 'agy',
      permission: 'reject',
    })
    expect(mounted[1]?.[1]).toEqual({
      provider: 'antigravity',
      toolName: 'subagent_antigravity',
      modelSelection: false,
      maxDepth: 'provider-managed',
    })
  })

  it('resolves optional modules from the profile base URL', async () => {
    const root = profileFixture()
    const registrations: Registration[] = []
    const { ctx, mounted, warnings } = fakeContext(registrations)
    ;(ctx as unknown as { baseUrl?: string }).baseUrl = pathToFileURL(join(root, 'cordis.yml')).href
    await apply(ctx, Config({
      backendModule: 'fake-backend',
      toolModule: 'fake-tool',
      autoConfigure: true,
    }))

    expect(warnings).toHaveLength(0)
    expect(mounted).toHaveLength(2)
  })

  it('degrades to the skill when the backend is missing', async () => {
    const registrations: Registration[] = []
    const { ctx, mounted, warnings } = fakeContext(registrations)
    const missing = moduleUrl('throw new Error("not installed")')
    await apply(ctx, Config({ backendModule: missing, autoConfigure: true }))

    expect(registrations).toHaveLength(1)
    expect(mounted).toHaveLength(0)
    expect(warnings.length).toBeGreaterThan(0)
    expect(String(warnings[0]?.[0])).toContain('registered the skill only')
  })

  it('keeps the provider when only the tool module is missing', async () => {
    const registrations: Registration[] = []
    const { ctx, mounted, warnings } = fakeContext(registrations)
    const backend = moduleUrl('export const name = "fake-backend"; export function apply() {}')
    const missing = moduleUrl('throw new Error("tool not installed")')
    await apply(ctx, Config({ backendModule: backend, toolModule: missing, autoConfigure: true }))

    expect(mounted).toHaveLength(1)
    expect(warnings.length).toBeGreaterThan(0)
    expect(String(warnings[0]?.[0])).toContain('no subagent_antigravity tool')
  })
})
