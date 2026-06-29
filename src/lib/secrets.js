/**
 * Secret detection heuristics shared by the build-time leak guard.
 *
 * These patterns intentionally err toward the providers an MCP template is
 * likely to reference (Context7, Ref, Exa, generic long hex/base64 keys). The
 * goal is to stop a *template* from being written or committed with a raw
 * secret in it — not to be a general-purpose scanner (gitleaks handles that).
 */

/**
 * @typedef {{ name: string, regex: RegExp }} SecretPattern
 */

/** @type {SecretPattern[]} */
export const SECRET_PATTERNS = [
    { name: 'Context7 API key', regex: /ctx7sk-[A-Za-z0-9-]{8,}/ },
    { name: 'Ref.tools API key', regex: /\bref-[A-Za-z0-9]{16,}\b/ },
    { name: 'OpenAI key', regex: /\bsk-[A-Za-z0-9]{20,}\b/ },
    { name: 'AWS access key id', regex: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
    { name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
    { name: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
    { name: 'Generic long hex secret (>=32)', regex: /\b[a-f0-9]{32,}\b/i },
    { name: 'UUID-style token', regex: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
]

/**
 * Scan a string for likely secrets.
 *
 * @param {string} text
 * @returns {{ name: string, match: string }[]} findings (empty = clean)
 */
export function findSecrets(text) {
    const findings = []

    for (const { name, regex } of SECRET_PATTERNS) {
        const m = text.match(regex)
        if (m) {
            findings.push({ name, match: redact(m[0]) })
        }
    }

    return findings
}

/**
 * Partially mask a matched secret so it is safe to print in error output.
 *
 * @param {string} value
 * @returns {string}
 */
export function redact(value) {
    if (value.length <= 8) {
        return '*'.repeat(value.length)
    }

    return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`
}
