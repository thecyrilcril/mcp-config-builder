#!/usr/bin/env node

import { watchTemplate } from '../lib/watcher.js'
import { build } from '../lib/builder.js'
import { loadEnv } from '../lib/env.js'

const cwd = process.cwd()
const env = loadEnv(cwd)

// Build once up front so the config exists before watching.
try {
    build({ cwd, env })
} catch (error) {
    console.error('❌', error.message)
    process.exit(1)
}

const stop = watchTemplate({ cwd, env })

process.on('SIGINT', () => {
    stop()
    process.exit(0)
})
