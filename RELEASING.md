# Releasing Mnemosyne

## Prerequisiti

- working tree pulito e commit firmati secondo la policy del repository;
- Node.js `22.12` o successivo e npm;
- Docker Compose disponibile per E2E e build delle immagini;
- credenziali di scansione e publishing configurate dall’ambiente GitHub;
- nessun dato reale nel repository o negli artifact.

## Checklist pre-release

1. Aggiornare la versione nei manifest interessati e la sezione del changelog.
2. Eseguire `npm ci` e `npm run verify`.
3. Eseguire `npm run openapi:check`.
4. Eseguire `npm run e2e:synthetic`.
5. Eseguire `npm run license:check` e `npm audit --audit-level=high`.
6. Verificare la CI per secret scan, build e scansione delle quattro immagini Docker.
7. Eseguire un backup cifrato e `--verify-restore` su dati sintetici.
8. Verificare threat model, privacy, backup/restore e procedura di migrazione.
9. Preparare le note di rilascio senza includere segreti o dati del corpus.

## Tag e pubblicazione

Il tag deve essere firmato e annotato prima del push. La CI verifica il formato semver e che il tag sia annotato; la firma viene verificata dal maintainer con la chiave pubblicata dal repository.

```bash
git tag -s -a v0.1.0 -m "Mnemosyne v0.1.0"
git push origin v0.1.0
```

La workflow `CI` crea la GitHub Release per i tag `v*` dopo i gate `verify`, `security`, `containers` ed `e2e`. Genera anche SBOM CycloneDX, source tarball e attestazioni provenance/SBOM prima del tag GitHub.

## Immagini e dipendenze

Le immagini applicative vengono costruite per `api`, `mcp`, `web` e `worker`. La CI le scansiona prima di una pubblicazione. La pubblicazione in un registry richiede un workflow separato con permessi minimi, firma e attestazioni; non va eseguita automaticamente da una pull request.

## Rollback

1. Fermare API e worker.
2. Conservare il database sostitutivo prima di qualsiasi operazione distruttiva.
3. Ripristinare il dump PostgreSQL verificato in un database target con `npm run restore:postgres`.
4. Ricostruire Redis e Neo4j, che sono derivati.
5. Avviare API e worker e verificare `/health/ready` e `/v1/admin/capabilities`.
6. Eseguire un export canonico e una prova diForget prima di dichiarare completato il rollback.

## Deprecazioni

Un endpoint, un tool MCP o un formato di export deve mantenere la compatibilità oppure dichiarare una procedura di migrazione. Le modifiche incompatibili richiedono una nuova versione del contratto e una nota nel changelog.
