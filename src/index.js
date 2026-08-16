export {
    build,
    processTemplate,
    merge,
    removedServers,
    validate,
    assertNotWipingEveryServer,
    isEqual,
    assertTemplateHasNoSecrets,
    LeakGuardError,
    DEFAULTS,
} from './lib/builder.js'

export { watchTemplate } from './lib/watcher.js'
export { findSecrets, redact, SECRET_PATTERNS } from './lib/secrets.js'
