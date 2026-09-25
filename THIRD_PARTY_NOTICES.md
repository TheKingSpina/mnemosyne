# Third-party notices

Mnemosyne is distributed under AGPL-3.0. The dependency inventory and SPDX expressions are checked from `package-lock.json` by:

```bash
npm run license:check
```

The check currently approves the runtime/dev npm licenses recorded in the lockfile and requires review for unknown or copyleft expressions. The repository does not replace the license text shipped by each dependency. When publishing a release, preserve the corresponding package license notices in the source distribution and review the licenses of the PostgreSQL/pgvector, Redis, Neo4j, and Node base images separately.

A license finding is a release blocker until it is resolved or explicitly reviewed in the release notes.
