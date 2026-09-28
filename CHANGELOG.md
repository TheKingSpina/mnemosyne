# Changelog

## [Unreleased]

### Added

- Per-client credentials: `POST`, `GET /v1/admin/client-tokens` and `POST /v1/admin/client-tokens/{name}/revoke`, plus `npm run token:client` to mint, list and revoke them from the client machine. Only a SHA-256 hash and a displayable prefix are stored, the plaintext is returned exactly once, and every token has the `owner` role.
- Host keep-alive for the Mac mini: launchd agents that start the container runtime at login, reconcile the Compose project, probe the API and the dashboard every 5 minutes and repair after consecutive failures, plus a scheduled encrypted PostgreSQL backup with verified restore.
- Optional anonymous access for MCP HTTP with `MNEMOSYNE_MCP_REQUIRE_TOKEN=false`, scoped by `MNEMOSYNE_MCP_ANONYMOUS_PROFILE` so a caller without credentials can be given the harness profile while the owner-only tools stay unregistered.
- The Redis corpus cache moved from `apps/api` to `packages/redis`, mirroring `packages/postgres`, and MCP now owns a cache too. Harnesses re-read the same scopes within a task, and the repeated reads were not being cached: 25 MCP searches, 15 of them byte-identical repeats, wrote no Redis keys at all, while one API search wrote one. Both processes resolve the cache through the same `connectCorpusCache`, which degrades to no cache on an unset or unreachable `REDIS_URL` instead of failing startup.

### Changed

- Credential writes are excluded from the idempotent replay path: the mint response carries a token in plaintext and must not be persisted, and reissuing a live client name returns `409` instead of silently rotating a credential in use.
- A presented `Authorization` header is always verified, including on an anonymous endpoint: a valid per-client token escalates to its profile and an invalid or revoked one gets `401` instead of a silent downgrade.
- `AccessPolicy.authenticate` may return a promise, which is what lets a deployment resolve per-client tokens from PostgreSQL.
- The runbook and README refer to the dashboard port as `WEB_PORT` (8080 by default) because the deployment moved to 18080; the documentation no longer contradicts the running configuration.
- The opencode MCP configuration moved to `~/.config/opencode/opencode.jsonc`; the repository root `opencode.json` is ignored because it carried a per-machine endpoint and home path.

### Fixed

- Search and context results now use deterministic hybrid ranking with token-aware lexical matching, BM25/IDF, phrase and proximity bonuses, local semantic fusion, thresholds and stable tie-breaking.
- PostgreSQL search uses the existing full-text index with bounded scope-aware candidate retrieval; the in-memory backend keeps the same ranking contract.
- Retrieval evaluation now uses graded, order-sensitive cases and fails under the legacy ordering baseline.
- The scheduled PostgreSQL backup could never succeed against a real deployment: the backup command runs `docker compose` with `--env-file /dev/null`, and compose interpolates every service, so the run failed on an unrelated service. `run-backup.sh` now sources the deployment environment and drops the provider key.
- The host keep-alive scripts no longer block on a wedged container runtime: every docker call is bounded with a timeout, the daemon is probed with `docker version` instead of trusting the socket file, and the runtime is recycled at most once per run.

### Changed

- The dashboard graph uses a lightweight native canvas renderer with separated clusters, stable hover behavior, no hover tooltip and persistent clicked-node highlighting.
- MCP uses the local deterministic embedding provider and PostgreSQL semantic index by default; OpenRouter remains disabled.

## [0.1.0] - 2026-09-25

### Added

- Binding del profilo autenticato alle sessioni MCP Streamable HTTP.
- Backup PostgreSQL con verifica dell’archivio, confronto dei conteggi del restore, manifest SHA-256 e retention controllata.
- Cifratura autenticata opzionale dei backup con AES-256-GCM e chiave derivata tramite scrypt.
- Restore PostgreSQL in un database target esplicito, con checksum, manifest e conferma obbligatoria.
- Audit locale delle licenze npm e gate CI per secret scan, licenze, immagini Docker, E2E e release taggata.
- Documentazione operativa per threat model, privacy, rilascio, migrazioni e disaster recovery.
- Benchmark offline di retrieval con precision, recall, nDCG, budget e latenza.
- SBOM CycloneDX e attestazioni provenance/SBOM nel flusso di release.
- Scan locale dei secret in aggiunta al gate Gitleaks della CI.
- Dashboard con grafo memoria/ambiti/conflitti e layout ispirato al pannello PMB.

### Changed

- Il dump viene verificato prima della pubblicazione definitiva.
- I file temporanei e i manifest sono protetti da permessi restrictivi e cleanup.
- La CI esegue anche il controllo delle licenze e lo scenario E2E sintetico.

### Fixed

- Il forget elimina anche i conflitti che referenziano la memoria dimenticata.
- Il lock PostgreSQL per i conflitti non usa più una stringa contenente il carattere NUL.

### Security

- Le sessioni MCP HTTP non possono essere riutilizzate con un token appartenente a un ruolo diverso.
- I backup cifrati non richiedono passphrase sulla command line e vengono verificati prima della pubblicazione.

## Release notes

La versione `0.1.0` è il primo rilascio candidato. Il tag firmato `v0.1.0` viene creato solo dopo il verde della CI e la verifica manuale della firma.
