# Contributing to Mnemosyne

Thank you for helping improve Mnemosyne.

## Before opening a change

1. Check the specification and existing tests.
2. Open an issue or discussion for architectural changes.
3. Keep changes small and reviewable.
4. Never include real memory data, conversations, credentials, tokens, or backups.

## Development

```bash
npm install
npm run verify
npm run e2e:synthetic
```

The project uses TypeScript, npm workspaces, Vitest, ESLint, and Prettier.
Run `npm run license:check` when dependencies change.

## Pull requests

- explain the user-visible behavior;
- add or update deterministic tests for behavior changes;
- run `npm run verify` and the relevant Docker/E2E checks;
- run `npm run license:check` for dependency changes;
- update documentation when contracts or configuration change;
- do not change the memory model or API meaning without a migration plan.

## Security

Do not disclose vulnerabilities in a public issue. Follow [`SECURITY.md`](SECURITY.md).
