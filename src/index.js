export {
    build,
    processTemplate,
    merge,
    validate,
    isEqual,
    assertTemplateHasNoSecrets,
    LeakGuardError,
    DEFAULTS,
} from './lib/builder.js'

export { watchTemplate } from './lib/watcher.js'
export { findSecrets, redact, SECRET_PATTERNS } from './lib/secrets.js'
