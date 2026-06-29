#!/usr/bin/env node

import { build } from '../lib/builder.js'
import { loadEnv } from '../lib/env.js'

const cwd = process.cwd()
const env = loadEnv(cwd)

console.log('🔄 Building MCP configuration…')

try {
    build({ cwd, env })
} catch (error) {
    console.error('❌', error.message)
    process.exit(1)
}
