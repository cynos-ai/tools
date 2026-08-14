# Contributing

Cynos Tools is the public source for `@cynos-ai/tools`.

## Development setup

```bash
npm ci
npm run verify
npm run pack:dry-run
```

Node.js 22 or newer is required.

## Pull requests

- Explain the behavior or maintenance problem being addressed.
- Add focused tests for runtime changes.
- Run `npm run verify` and `npm run pack:dry-run` for package changes.
- Keep generated `index.js`, `node_modules/`, `.cynos/`, tarballs, credentials,
  and screenshots out of commits.
- Preserve upstream license notices.

The build creates a readable, unminified CommonJS bundle with esbuild.
