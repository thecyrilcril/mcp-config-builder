import { existsSync, watch } from 'node:fs'
import { build } from './builder.js'

/**
 * @typedef {Object} WatchOptions
 * @property {string} [cwd]       Project root (default: process.cwd()).
 * @property {string} [template]  Template filename (default: '.mcp.json.template').
 * @property {number} [debounceMs] Debounce window (default: 500).
 * @property {Record<string,string>} [env]
 * @property {(msg: string) => void} [logger]
 */

/**
 * Watch the template and rebuild on change. Returns a stop() function.
 *
 * @param {WatchOptions} [options]
 * @returns {() => void} stop the watcher
 */
export function watchTemplate(options = {}) {
    const cwd = options.cwd ?? process.cwd()
    const template = options.template ?? '.mcp.json.template'
    const debounceMs = options.debounceMs ?? 500
    const log = options.logger ?? console.log
    const path = `${cwd}/${template}`

    if (!existsSync(path)) {
        throw new Error(`Template "${template}" not found in ${cwd}.`)
    }

    let timer = null
    let building = false

    const rebuild = () => {
        if (building) {
            return
        }
        building = true
        try {
            build({ cwd, template, env: options.env, logger: log })
        } catch (error) {
            log(`❌ ${error.message}`)
        } finally {
            building = false
        }
    }

    log(`👀 Watching ${template}…`)

    const watcher = watch(path, (event) => {
        if (event !== 'change') {
            return
        }
        clearTimeout(timer)
        timer = setTimeout(() => {
            log('📝 Template changed')
            rebuild()
        }, debounceMs)
    })

    return () => {
        clearTimeout(timer)
        watcher.close()
        log('\n👋 Stopped watching')
    }
}
