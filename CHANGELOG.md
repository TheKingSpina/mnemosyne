# Changelog

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
