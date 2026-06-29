import { test, describe, beforeEach, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
    build,
    processTemplate,
    merge,
    validate,
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
})

describe('merge', () => {
    test('preserves custom servers absent from template', () => {
        const existing = { mcpServers: { custom: { command: 'node', args: ['x.js'] } } }
        const out = merge(existing, { mcpServers: { a: { command: 'php' } } })
        assert.ok(out.mcpServers.custom)
        assert.ok(out.mcpServers.a)
    })

    test('template wins for overlapping server names', () => {
        const existing = { mcpServers: { a: { command: 'OLD' } } }
        const out = merge(existing, { mcpServers: { a: { command: 'NEW' } } })
        assert.equal(out.mcpServers.a.command, 'NEW')
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

    test('preserves a user-added custom server across rebuilds', () => {
        writeTemplate(CLEAN_TEMPLATE)
        const env = { VITE_CONTEXT7_API_KEY: 'ctx7sk-real-key-value' }
        build({ cwd: dir, env, logger: () => {} })

        const out = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))
        out.mcpServers.myCustom = { command: 'node', args: ['custom.js'] }
        writeFileSync(join(dir, '.mcp.json'), JSON.stringify(out, null, 4))

        build({ cwd: dir, env, logger: () => {} })
        const after = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))
        assert.ok(after.mcpServers.myCustom, 'custom server must survive rebuild')
    })
})
