import { test, describe, beforeEach, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
    build,
    processTemplate,
    merge,
    removedServers,
    validate,
    assertNotWipingEveryServer,
    isEqual,
    assertTemplateHasNoSecrets,
    LeakGuardError,
} from '../src/lib/builder.js'
import { findSecrets } from '../src/lib/secrets.js'

const CLEAN_TEMPLATE = {
    mcpServers: {
        'laravel-boost': { command: 'php', args: ['artisan', 'boost:mcp'] },
        herd: {
            command: 'php',
            args: ['/Applications/Herd.app/Contents/Resources/herd-mcp.phar'],
            env: { SITE_PATH: 'PROJECT_PATH' },
        },
        context7: {
            type: 'http',
            url: 'https://mcp.context7.com/mcp',
            headers: { CONTEXT7_API_KEY: 'VITE_CONTEXT7_API_KEY' },
        },
    },
}

let dir

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-builder-'))
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

const writeTemplate = (obj) =>
    writeFileSync(join(dir, '.mcp.json.template'), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 4))

describe('processTemplate', () => {
    test('replaces PROJECT_PATH with cwd', () => {
        const out = processTemplate(CLEAN_TEMPLATE, {}, '/my/project')
        assert.equal(out.mcpServers.herd.env.SITE_PATH, '/my/project')
    })

    test('replaces VITE_* from environment', () => {
        const out = processTemplate(CLEAN_TEMPLATE, { VITE_CONTEXT7_API_KEY: 'ctx7sk-real' }, '/p')
        assert.equal(out.mcpServers.context7.headers.CONTEXT7_API_KEY, 'ctx7sk-real')
    })

    test('leaves placeholder when VITE_* missing', () => {
        const out = processTemplate(CLEAN_TEMPLATE, {}, '/p')
        assert.equal(out.mcpServers.context7.headers.CONTEXT7_API_KEY, 'VITE_CONTEXT7_API_KEY')
    })

    test('PROJECT_PATH is a whole-token replace (does not mangle PROJECT_PATH_X)', () => {
        const tpl = { mcpServers: { a: { command: 'x', args: ['PROJECT_PATH', 'PROJECT_PATH_ROOT'] } } }
        const out = processTemplate(tpl, {}, '/home/u')
        assert.equal(out.mcpServers.a.args[0], '/home/u')
        assert.equal(out.mcpServers.a.args[1], 'PROJECT_PATH_ROOT')
    })

    test('a project path containing $ is inserted literally', () => {
        const tpl = { mcpServers: { a: { command: 'x', args: ['PROJECT_PATH'] } } }
        const out = processTemplate(tpl, {}, '/home/$user/app')
        assert.equal(out.mcpServers.a.args[0], '/home/$user/app')
    })
})

describe('merge', () => {
    test('drops servers absent from the template', () => {
        const existing = { mcpServers: { custom: { command: 'node', args: ['x.js'] } } }
        const out = merge(existing, { mcpServers: { a: { command: 'php' } } })
        assert.equal(out.mcpServers.custom, undefined, 'template is the source of truth')
        assert.ok(out.mcpServers.a)
    })

    test('logs each server it removes', () => {
        const messages = []
        const existing = { mcpServers: { gone: { command: 'node' }, a: { command: 'php' } } }
        merge(existing, { mcpServers: { a: { command: 'php' } } }, (m) => messages.push(m))
        assert.equal(messages.length, 1)
        // Assert the removal wording, not just the name: the pre-2.0 code logged
        // "Preserved custom server: gone", which also matched a bare /gone/.
        assert.match(messages[0], /Removed server absent from template: gone/)
    })

    test('result contains exactly the template servers', () => {
        const existing = { mcpServers: { old1: { command: 'x' }, old2: { command: 'y' } } }
        const out = merge(existing, { mcpServers: { a: { command: 'php' }, b: { type: 'http' } } })
        assert.deepEqual(Object.keys(out.mcpServers).sort(), ['a', 'b'])
    })

    test('template wins for overlapping server names', () => {
        const existing = { mcpServers: { a: { command: 'OLD' } } }
        const out = merge(existing, { mcpServers: { a: { command: 'NEW' } } })
        assert.equal(out.mcpServers.a.command, 'NEW')
    })

    test('preserves top-level template keys like $schema', () => {
        const out = merge(null, { $schema: 'https://example/schema.json', mcpServers: { a: { command: 'php' } } })
        assert.equal(out.$schema, 'https://example/schema.json')
        assert.ok(out.mcpServers.a)
    })
})

describe('validate', () => {
    test('rejects missing mcpServers', () => {
        assert.throws(() => validate({}), /mcpServers/)
    })

    test('rejects server without command or type', () => {
        assert.throws(() => validate({ mcpServers: { a: { foo: 1 } } }), /command.*type/)
    })

    test('accepts command-based and type-based servers', () => {
        assert.doesNotThrow(() =>
            validate({ mcpServers: { a: { command: 'php' }, b: { type: 'http', url: 'x' } } })
        )
    })
})

describe('isEqual', () => {
    test('order-independent equality', () => {
        assert.ok(isEqual({ a: 1, b: 2 }, { b: 2, a: 1 }))
    })
    test('null is never equal', () => {
        assert.equal(isEqual(null, {}), false)
    })
})

// NOTE: every "secret" below is SYNTHETIC — same shape as a real key so the
// detection regexes fire, but all-zero payloads so no real credential is ever
// committed to this repo (which would defeat the package's purpose).
describe('leak guard', () => {
    test('findSecrets flags a Context7 key', () => {
        assert.ok(findSecrets('ctx7sk-0000000000000000000000000000000000').length > 0)
    })

    test('findSecrets flags a ref.tools key', () => {
        assert.ok(findSecrets('ref-0000000000000000').length > 0)
    })

    test('findSecrets flags a modern OpenAI project key (sk-proj-)', () => {
        assert.ok(findSecrets('sk-proj-0000000000000000000000000000').length > 0)
    })

    test('findSecrets flags a legacy OpenAI key (sk-)', () => {
        assert.ok(findSecrets('sk-0000000000000000000000').length > 0)
    })

    test('findSecrets flags a long hex secret', () => {
        assert.ok(findSecrets('0000000000000000000000000000000000000000000000000000000000000000').length > 0)
    })

    test('findSecrets is clean for placeholder template', () => {
        assert.equal(findSecrets(JSON.stringify(CLEAN_TEMPLATE)).length, 0)
    })

    test('assertTemplateHasNoSecrets throws LeakGuardError on raw key', () => {
        assert.throws(
            () => assertTemplateHasNoSecrets('"KEY": "ctx7sk-0000000000000000000000000000000000"'),
            LeakGuardError
        )
    })

    test('redacted output never contains the full secret', () => {
        const secret = 'ctx7sk-0000000000000000000000000000000000'
        try {
            assertTemplateHasNoSecrets(`x ${secret} y`)
            assert.fail('should have thrown')
        } catch (e) {
            assert.ok(!e.message.includes(secret), 'error message must not echo the raw secret')
        }
    })
})

describe('build (integration)', () => {
    test('writes .mcp.json from a clean template', () => {
        writeTemplate(CLEAN_TEMPLATE)
        const res = build({ cwd: dir, env: { VITE_CONTEXT7_API_KEY: 'ctx7sk-real-key-value' }, logger: () => {} })
        assert.equal(res.status, 'written')
        const out = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))
        assert.equal(out.mcpServers.context7.headers.CONTEXT7_API_KEY, 'ctx7sk-real-key-value')
        assert.equal(out.mcpServers.herd.env.SITE_PATH, dir)
    })

    test('refuses to build when the template contains a raw secret', () => {
        writeTemplate(JSON.stringify({
            mcpServers: { context7: { type: 'http', url: 'x', headers: { K: 'ctx7sk-0000000000000000000000000000000000' } } },
        }))
        assert.throws(() => build({ cwd: dir, env: {}, logger: () => {} }), LeakGuardError)
        assert.equal(existsSync(join(dir, '.mcp.json')), false, 'must not write output on leak')
    })

    test('skips when MCP_DYNAMIC=false', () => {
        writeTemplate(CLEAN_TEMPLATE)
        const res = build({ cwd: dir, env: { MCP_DYNAMIC: 'false' }, logger: () => {} })
        assert.equal(res.status, 'skipped')
    })

    test('is idempotent — second build reports unchanged', () => {
        writeTemplate(CLEAN_TEMPLATE)
        const env = { VITE_CONTEXT7_API_KEY: 'ctx7sk-real-key-value' }
        build({ cwd: dir, env, logger: () => {} })
        const res = build({ cwd: dir, env, logger: () => {} })
        assert.equal(res.status, 'unchanged')
    })

    test('throws a helpful error when template is missing', () => {
        assert.throws(() => build({ cwd: dir, env: {}, logger: () => {} }), /not found/)
    })

    test('drops a hand-added server not present in the template', () => {
        writeTemplate(CLEAN_TEMPLATE)
        const env = { VITE_CONTEXT7_API_KEY: 'ctx7sk-real-key-value' }
        build({ cwd: dir, env, logger: () => {} })

        const out = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))
        out.mcpServers.myCustom = { command: 'node', args: ['custom.js'] }
        writeFileSync(join(dir, '.mcp.json'), JSON.stringify(out, null, 4))

        build({ cwd: dir, env, logger: () => {} })
        const after = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))
        assert.equal(after.mcpServers.myCustom, undefined, 'template is the source of truth')
    })

    test('removing a server from the template removes it from the output', () => {
        writeTemplate(CLEAN_TEMPLATE)
        const env = { VITE_CONTEXT7_API_KEY: 'ctx7sk-real-key-value' }
        build({ cwd: dir, env, logger: () => {} })

        const before = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))
        assert.ok(before.mcpServers.context7, 'precondition: server is present')

        const trimmed = JSON.parse(JSON.stringify(CLEAN_TEMPLATE))
        delete trimmed.mcpServers.context7
        writeTemplate(trimmed)

        const res = build({ cwd: dir, env, logger: () => {} })
        assert.equal(res.status, 'written', 'a removal is a change, not a no-op')

        const after = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))
        assert.equal(after.mcpServers.context7, undefined)
        assert.deepEqual(Object.keys(after.mcpServers).sort(), ['herd', 'laravel-boost'])
    })

    test('a removed server takes its injected secret with it', () => {
        writeTemplate(CLEAN_TEMPLATE)
        const env = { VITE_CONTEXT7_API_KEY: 'ctx7sk-real-key-value' }
        build({ cwd: dir, env, logger: () => {} })
        assert.match(readFileSync(join(dir, '.mcp.json'), 'utf8'), /ctx7sk-real-key-value/)

        const trimmed = JSON.parse(JSON.stringify(CLEAN_TEMPLATE))
        delete trimmed.mcpServers.context7
        writeTemplate(trimmed)
        build({ cwd: dir, env, logger: () => {} })

        const after = readFileSync(join(dir, '.mcp.json'), 'utf8')
        assert.doesNotMatch(after, /ctx7sk-real-key-value/, 'stale key must not survive removal')
    })
})

describe('removedServers', () => {
    test('lists servers absent from the template', () => {
        const existing = { mcpServers: { a: { command: 'x' }, gone: { command: 'y' } } }
        assert.deepEqual(removedServers(existing, { mcpServers: { a: { command: 'x' } } }), ['gone'])
    })

    test('is empty when nothing was removed', () => {
        const existing = { mcpServers: { a: { command: 'x' } } }
        assert.deepEqual(removedServers(existing, { mcpServers: { a: { command: 'x' } } }), [])
    })

    test('is empty when there is no existing config', () => {
        assert.deepEqual(removedServers(null, { mcpServers: { a: { command: 'x' } } }), [])
    })
})

describe('assertNotWipingEveryServer', () => {
    test('throws when a non-empty config would be emptied', () => {
        const existing = { mcpServers: { a: { command: 'x' } } }
        assert.throws(() => assertNotWipingEveryServer(existing, { mcpServers: {} }), /Refusing to build/)
    })

    test('allows a partial removal', () => {
        const existing = { mcpServers: { a: { command: 'x' }, b: { command: 'y' } } }
        assertNotWipingEveryServer(existing, { mcpServers: { a: { command: 'x' } } })
    })

    test('allows an empty result when there was nothing to lose', () => {
        assertNotWipingEveryServer(null, { mcpServers: {} })
        assertNotWipingEveryServer({ mcpServers: {} }, { mcpServers: {} })
    })
})

describe('build (destructive-change safety)', () => {
    let dir

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'mcp-builder-safety-'))
    })

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    const writeTpl = (obj) =>
        writeFileSync(join(dir, '.mcp.json.template'), JSON.stringify(obj, null, 4))

    const ENV = { VITE_CONTEXT7_API_KEY: 'ctx7sk-real-key-value' }

    test('refuses a template whose mcpServers key is typo\'d, leaving the output intact', () => {
        writeTpl(CLEAN_TEMPLATE)
        build({ cwd: dir, env: ENV, logger: () => {} })
        const before = readFileSync(join(dir, '.mcp.json'), 'utf8')

        writeTpl({ mcpSevrers: CLEAN_TEMPLATE.mcpServers })
        assert.throws(() => build({ cwd: dir, env: ENV, logger: () => {} }), /Refusing to build/)

        assert.equal(readFileSync(join(dir, '.mcp.json'), 'utf8'), before, 'output must be untouched')
    })

    test('refuses an explicitly emptied template', () => {
        writeTpl(CLEAN_TEMPLATE)
        build({ cwd: dir, env: ENV, logger: () => {} })

        writeTpl({ mcpServers: {} })
        assert.throws(() => build({ cwd: dir, env: ENV, logger: () => {} }), /Refusing to build/)
    })

    test('a removal writes a non-rolling snapshot that survives later builds', () => {
        writeTpl(CLEAN_TEMPLATE)
        build({ cwd: dir, env: ENV, logger: () => {} })

        const trimmed = JSON.parse(JSON.stringify(CLEAN_TEMPLATE))
        delete trimmed.mcpServers.context7
        writeTpl(trimmed)
        build({ cwd: dir, env: ENV, logger: () => {} })

        const snapshots = readdirSync(dir).filter((f) => f.startsWith('.mcp.json.removed-'))
        assert.equal(snapshots.length, 1, 'exactly one snapshot for one removal build')
        assert.match(readFileSync(join(dir, snapshots[0]), 'utf8'), /ctx7sk-real-key-value/)

        // A later, unrelated write flushes the rolling backup — the snapshot must outlive it.
        const edited = JSON.parse(JSON.stringify(trimmed))
        edited.mcpServers['laravel-boost'].args = ['artisan', 'boost:mcp', '--verbose']
        writeTpl(edited)
        build({ cwd: dir, env: ENV, logger: () => {} })

        assert.doesNotMatch(readFileSync(join(dir, '.mcp.json.backup'), 'utf8'), /ctx7sk-real-key-value/)
        assert.match(readFileSync(join(dir, snapshots[0]), 'utf8'), /ctx7sk-real-key-value/)
    })

    test('no snapshot is written when nothing was removed', () => {
        writeTpl(CLEAN_TEMPLATE)
        build({ cwd: dir, env: ENV, logger: () => {} })

        const edited = JSON.parse(JSON.stringify(CLEAN_TEMPLATE))
        edited.mcpServers['laravel-boost'].args = ['artisan', 'boost:mcp', '--verbose']
        writeTpl(edited)
        build({ cwd: dir, env: ENV, logger: () => {} })

        assert.equal(readdirSync(dir).filter((f) => f.startsWith('.mcp.json.removed-')).length, 0)
    })

    test('build() reports removals in its return value', () => {
        writeTpl(CLEAN_TEMPLATE)
        assert.deepEqual(build({ cwd: dir, env: ENV, logger: () => {} }).removed, [])

        const trimmed = JSON.parse(JSON.stringify(CLEAN_TEMPLATE))
        delete trimmed.mcpServers.context7
        writeTpl(trimmed)

        const res = build({ cwd: dir, env: ENV, logger: () => {} })
        assert.equal(res.status, 'written')
        assert.deepEqual(res.removed, ['context7'], 'removals must be inspectable without scraping logs')
    })
})
