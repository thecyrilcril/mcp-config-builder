import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { findSecrets } from './secrets.js'

/**
 * @typedef {Object} BuildOptions
 * @property {string} [cwd]          Project root (default: process.cwd()).
 * @property {string} [template]     Template filename (default: '.mcp.json.template').
 * @property {string} [output]       Output filename (default: '.mcp.json').
 * @property {string} [backup]       Backup filename (default: '.mcp.json.backup').
 * @property {Record<string,string>} [env]  Environment map for placeholder resolution.
 * @property {(msg: string) => void} [logger]  Log sink (default: console.log).
 * @property {boolean} [guard]       Enforce the leak guard (default: true).
 */

/**
 * @typedef {Object} BuildResult
 * @property {'written'|'unchanged'|'skipped'} status
 * @property {string} [output] Absolute-ish path written.
 * @property {string[]} [removed] Servers dropped because the template no longer defines them.
 */

const DEFAULTS = {
    template: '.mcp.json.template',
    output: '.mcp.json',
    backup: '.mcp.json.backup',
}

class LeakGuardError extends Error {}

/**
 * Resolve PROJECT_PATH and VITE_* placeholders in a config object.
 *
 * @param {object} config
 * @param {Record<string,string>} environment
 * @param {string} projectPath
 * @param {(msg: string) => void} logger
 * @returns {object}
 */
export function processTemplate(config, environment, projectPath, logger = () => {}) {
    let json = JSON.stringify(config, null, 4)

    // Whole-token replace so values like "PROJECT_PATH_ROOT" are not mangled.
    // Use a function replacer so $-sequences in projectPath aren't interpreted.
    json = json.replace(/\bPROJECT_PATH\b/g, () => projectPath)

    json = json.replace(/VITE_([A-Z0-9_]+)/g, (match, name) => {
        const value = environment[`VITE_${name}`]
        if (!value) {
            logger(`⚠️  VITE_${name} not set — leaving placeholder in place`)
            return match
        }
        return value
    })

    return JSON.parse(json)
}

/**
 * Resolve the config to write from a freshly-processed template.
 *
 * The template is the single source of truth: additions, edits and removals in
 * `.mcp.json.template` all propagate to the output. A server absent from the
 * template is absent from the result, so deleting a block from the template
 * deletes it from `.mcp.json` on the next build.
 *
 * `existing` is accepted only so removals can be reported; it never contributes
 * servers to the result. To run a machine-specific server that is not committed,
 * add it to the template and gate it with an env placeholder, or configure it in
 * your MCP client outside this project.
 *
 * @param {object|null} existing
 * @param {object} template
 * @param {(msg: string) => void} logger
 * @returns {object}
 */
export function merge(existing, template, logger = () => {}) {
    const templateServers = Object.keys(template.mcpServers || {})
    // Preserve any top-level template keys (e.g. "$schema"), not just mcpServers.
    const result = { ...template, mcpServers: { ...template.mcpServers } }

    if (existing?.mcpServers) {
        for (const name of Object.keys(existing.mcpServers)) {
            if (!templateServers.includes(name)) {
                logger(`🗑️  Removed server absent from template: ${name}`)
            }
        }
    }

    return result
}

/**
 * Names of servers present in `existing` but not in `template`.
 *
 * The same set `merge()` reports through its logger, returned as data so callers
 * can react to deletions without scraping log text.
 *
 * @param {object|null} existing
 * @param {object} template
 * @returns {string[]}
 */
export function removedServers(existing, template) {
    const templateServers = Object.keys(template.mcpServers || {})

    return Object.keys(existing?.mcpServers ?? {}).filter((name) => !templateServers.includes(name))
}

/**
 * Validate the merged config shape before writing.
 *
 * @param {object} config
 */
export function validate(config) {
    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
        throw new Error('Invalid MCP config: "mcpServers" must be an object. Check the template syntax.')
    }

    for (const [name, server] of Object.entries(config.mcpServers)) {
        if (!server.command && !server.type) {
            throw new Error(
                `MCP server "${name}" is invalid: it must have either "command" (CLI tools) or "type" (HTTP services).`
            )
        }
    }
}

/**
 * Leak guard: refuse to treat a TEMPLATE that contains raw secrets as valid.
 * The template is committed to git, so a secret in it is a leak. Real secrets
 * belong in .env and must be referenced via VITE_* placeholders.
 *
 * @param {string} templateText raw template file contents
 */
export function assertTemplateHasNoSecrets(templateText) {
    const findings = findSecrets(templateText)
    if (findings.length === 0) {
        return
    }

    const lines = findings.map((f) => `   • ${f.name}: ${f.match}`)
    throw new LeakGuardError(
        'Refusing to build: the MCP template appears to contain raw secret(s):\n' +
        lines.join('\n') +
        '\n\nThe template is committed to git — secrets must live in .env and be referenced as ' +
        'VITE_* placeholders (e.g. "CONTEXT7_API_KEY": "VITE_CONTEXT7_API_KEY"). ' +
        'Move the value to .env, replace it with its placeholder, and rebuild.'
    )
}

/**
 * Refuse a build that would remove every server from a non-empty config.
 *
 * The template is the source of truth, so removals are expected and allowed —
 * but wiping *everything* is far more often a malformed template (a typo'd or
 * missing `mcpServers` key, an accidentally emptied block) than a real intent.
 * `merge()` spreads `template.mcpServers` unconditionally, so an absent key
 * arrives here as `{}` and is indistinguishable from an explicitly empty one;
 * both are treated as suspect. Removing the last server deliberately is still
 * possible — delete `.mcp.json` by hand, or empty the template when the output
 * is already empty.
 *
 * @param {object|null} existing
 * @param {object} merged
 * @param {string} template template filename, for the error message
 */
export function assertNotWipingEveryServer(existing, merged, template = DEFAULTS.template) {
    const existingCount = Object.keys(existing?.mcpServers ?? {}).length
    const mergedCount = Object.keys(merged.mcpServers ?? {}).length

    if (existingCount > 0 && mergedCount === 0) {
        throw new Error(
            `Refusing to build: "${template}" defines no MCP servers, which would remove all ` +
            `${existingCount} server(s) from the generated config. This is usually a typo'd or ` +
            `missing "mcpServers" key in the template. If you really mean to remove every server, ` +
            `delete the generated file by hand.`
        )
    }
}

/**
 * Order-independent deep equality via canonical (key-sorted) JSON, so a config
 * that differs only in key ordering is treated as unchanged.
 *
 * @param {object|null} a
 * @param {object|null} b
 * @returns {boolean}
 */
export function isEqual(a, b) {
    if (!a || !b) {
        return false
    }
    return canonicalize(a) === canonicalize(b)
}

/**
 * Deterministic JSON: object keys sorted recursively, arrays left in order.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonicalize(value) {
    return JSON.stringify(sortKeys(value))
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeys(value) {
    if (Array.isArray(value)) {
        return value.map(sortKeys)
    }
    if (value && typeof value === 'object') {
        return Object.keys(value)
            .sort()
            .reduce((acc, key) => {
                acc[key] = sortKeys(value[key])
                return acc
            }, {})
    }
    return value
}

/**
 * Build the MCP config from the template.
 *
 * @param {BuildOptions} [options]
 * @returns {BuildResult}
 */
export function build(options = {}) {
    const cwd = options.cwd ?? process.cwd()
    const template = options.template ?? DEFAULTS.template
    const output = options.output ?? DEFAULTS.output
    const backup = options.backup ?? DEFAULTS.backup
    const env = options.env ?? process.env
    const log = options.logger ?? console.log
    const guard = options.guard ?? true

    const path = (name) => `${cwd}/${name}`

    if (env.MCP_DYNAMIC === 'false') {
        log('⏭️  MCP_DYNAMIC=false — skipping generation')
        return { status: 'skipped' }
    }

    if (!existsSync(path(template))) {
        throw new Error(
            `Template "${template}" not found in ${cwd}. ` +
            `Restore it from git (git checkout ${template}) or create it.`
        )
    }

    const templateText = readFileSync(path(template), 'utf8')

    if (guard) {
        assertTemplateHasNoSecrets(templateText)
    }

    const parsedTemplate = JSON.parse(templateText)
    const processed = processTemplate(parsedTemplate, env, cwd, log)

    const existing = existsSync(path(output))
        ? JSON.parse(readFileSync(path(output), 'utf8'))
        : null

    const merged = merge(existing, processed, log)
    validate(merged)
    assertNotWipingEveryServer(existing, merged, template)

    if (isEqual(existing, merged)) {
        log('✅ No changes')
        return { status: 'unchanged', output: path(output), removed: [] }
    }

    const removed = removedServers(existing, processed)

    if (existsSync(path(output))) {
        // `.mcp.json.backup` is a single rolling slot: the next write overwrites it.
        // That is fine for an edit, but a removal is the one case where the previous
        // contents are irreplaceable — the dropped server and its injected secret
        // exist nowhere else. Snapshot those to a distinct, non-rolling file first.
        if (removed.length > 0) {
            const snapshot = `${output}.removed-${Date.now()}`
            copyFileSync(path(output), path(snapshot))
            log(`🧷 Saved pre-removal snapshot: ${snapshot}`)
        }

        copyFileSync(path(output), path(backup))
    }

    try {
        writeFileSync(path(output), JSON.stringify(merged, null, 4) + '\n')
    } catch (error) {
        if (existsSync(path(backup))) {
            copyFileSync(path(backup), path(output))
            log('🔄 Restored output from backup after write failure')
        }
        throw error
    }

    log(`✅ Updated ${output}`)
    return { status: 'written', output: path(output), removed }
}

export { LeakGuardError, DEFAULTS }
