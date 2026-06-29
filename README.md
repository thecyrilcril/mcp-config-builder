# @thecyrilcril/mcp-config-builder

Build a project's `.mcp.json` from a **committed placeholder template**, injecting
secrets from `.env` at build time — with a built-in **leak guard** that refuses to
process a template containing raw secrets.

The pattern: commit `.mcp.json.template` with `VITE_*` placeholders (no secrets),
keep real keys in `.env` (git-ignored), and generate the gitignored `.mcp.json`
on `npm run dev`. Secrets never touch version control.

## Install

```bash
npm install --save-dev github:thecyrilcril/mcp-config-builder
```

## Usage

Add the bins to your `package.json`:

```json
{
    "scripts": {
        "dev": "mcp-build && vite",
        "mcp:build": "mcp-build",
        "mcp:watch": "mcp-watch"
    }
}
```

Create `.mcp.json.template` (committed, **placeholders only**):

```json
{
    "mcpServers": {
        "laravel-boost": { "command": "php", "args": ["artisan", "boost:mcp"] },
        "herd": {
            "command": "php",
            "args": ["/Applications/Herd.app/Contents/Resources/herd-mcp.phar"],
            "env": { "SITE_PATH": "PROJECT_PATH" }
        },
        "context7": {
            "type": "http",
            "url": "https://mcp.context7.com/mcp",
            "headers": { "CONTEXT7_API_KEY": "VITE_CONTEXT7_API_KEY" }
        }
    }
}
```

Put the real values in `.env` (git-ignored):

```dotenv
VITE_CONTEXT7_API_KEY=ctx7sk-your-real-key
```

Git-ignore the generated output and backup:

```gitignore
.mcp.json
.mcp.json.backup
```

Run `npm run dev` (or `npx mcp-build`) → `.mcp.json` is generated with real keys.

## Placeholders

| Placeholder | Replaced with |
|-------------|---------------|
| `PROJECT_PATH` | The project root (`process.cwd()`) |
| `VITE_<NAME>` | `process.env.VITE_<NAME>`, falling back to `.env`. If unset, the placeholder is left in place and a warning is printed. |

## Leak guard

Before processing, the builder scans the **template** for raw secrets (Context7,
Ref, OpenAI, AWS, Google, GitHub, Slack tokens, long hex/UUID values). If
any are found it **throws and writes nothing** — because the template is committed,
a secret in it is a leak. Move the value to `.env`, replace it with its `VITE_*`
placeholder, and rebuild. Matched secrets are redacted in error output.

Disable per build (not recommended) via the library: `build({ guard: false })`.

## Behavior

- **Merge-preserving**: servers you add to `.mcp.json` that aren't in the template
  are kept across rebuilds.
- **Idempotent**: no write when the result is unchanged (key-order-independent).
- **Safe writes**: backs up to `.mcp.json.backup` and restores on write failure.
- **Opt-out**: `MCP_DYNAMIC=false` skips generation entirely.

## Library API

```js
import { build, watchTemplate, findSecrets } from '@thecyrilcril/mcp-config-builder'

const result = build({ cwd: process.cwd(), guard: true }) // { status: 'written' | 'unchanged' | 'skipped' }
const stop = watchTemplate({ debounceMs: 500 })
const findings = findSecrets(someText) // [{ name, match }]
```

Subpath exports: `/builder`, `/watcher`, `/secrets`.

## Requirements

Node.js ≥ 18. Zero runtime dependencies.

## License

MIT
