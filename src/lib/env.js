import { readFileSync, existsSync } from 'node:fs'

/**
 * Minimal .env loader (no dependency on dotenv or Vite). Reads `.env` from the
 * given cwd, layers it under process.env (process.env wins), and returns the
 * merged map. Only KEY=VALUE lines are parsed; quotes are stripped.
 *
 * @param {string} [cwd]
 * @returns {Record<string,string>}
 */
export function loadEnv(cwd = process.cwd()) {
    const merged = { ...process.env }
    const path = `${cwd}/.env`

    if (!existsSync(path)) {
        return merged
    }

    const text = readFileSync(path, 'utf8')

    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) {
            continue
        }

        const eq = line.indexOf('=')
        if (eq === -1) {
            continue
        }

        const key = line.slice(0, eq).trim()
        let value = line.slice(eq + 1).trim()

        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1)
        }

        // process.env takes precedence; .env only fills gaps.
        if (merged[key] === undefined) {
            merged[key] = value
        }
    }

    return merged
}
