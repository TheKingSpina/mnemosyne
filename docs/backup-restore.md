# Backup e restore PostgreSQL

## Creare un backup verificato

Il comando produce un dump custom-format, un manifest con checksum SHA-256 e, se richiesto, un archivio cifrato AES-256-GCM:

```bash
printf '%s\n' 'una passphrase lunga e unica' > /secure/mnemosyne-backup.pass
chmod 600 /secure/mnemosyne-backup.pass

POSTGRES_DB=mnemosyne \
POSTGRES_USER=mnemosyne \
POSTGRES_PASSWORD='...' \
npm run backup:postgres -- \
  --output /secure/backups/mnemosyne-$(date -u +%Y%m%dT%H%M%SZ).dump \
  --verify-restore \
  --encrypt \
  --passphrase-file /secure/mnemosyne-backup.pass \
  --keep-last 14 \
  --keep-days 30
```

Il file viene verificato prima del rename definitivo. Il manifest viene pubblicato solo dopo il completamento della verifica e registra anche l’eventuale differenza dei conteggi causata da scritture concorrenti. La passphrase non va mai passata come argomento o scritta nei log.

Il comando accetta anche `--compose-env-file /secure/mnemosyne-compose.env`, `--postgres-user`, `--postgres-database` e `--force`. Il file di ambiente deve essere esterno al repository e protetto come un secret.

## Restore

Il restore non modifica il database live. Crea un database target esplicito, che l’operatore potrà usare per uno switch controllato:

```bash
POSTGRES_DB=mnemosyne \
POSTGRES_USER=mnemosyne \
POSTGRES_PASSWORD='...' \
npm run restore:postgres -- \
  --input /secure/backups/mnemosyne-20260924.dump \
  --target-database mnemosyne_restored \
  --confirm
```

Per un backup cifrato aggiungere `--passphrase-file /secure/mnemosyne-backup.pass`. Il comando verifica manifest, checksum, formato, archivio e conteggi prima di dichiarare completato il restore.

## Scheduling locale

Il backup deve essere schedulato dall’host, non dal worker applicativo. I modelli pronti per macOS `launchd` e Linux `systemd` sono in [`ops/backup`](../ops/backup/README.md). Su macOS usare `launchd`; su Linux usare `systemd timer` con `Persistent=true`. Il comando schedulato deve usare percorsi assoluti, un ambiente protetto e `npm run backup:postgres` con `--verify-restore` e cifratura.

Una copia locale non è sufficiente per il disaster recovery. copiare il manifest e l’artifact su storage esterno protetto, con encryption e retention coerenti.

## RPO e RTO

Un dump completo non soddisfa automaticamente il RPO di 15 minuti indicato nella specifica. Per tale obiettivo usare WAL o uno strumento fisico dedicato e misurare il RPO/RTO reale. Il restore periodico in un ambiente isolato è parte del gate operativo.

## Differenza rispetto al restore del corpus

`POST /v1/admin/restore/corpus` importa un export canonico in un corpus vuoto e fa scattare il forget ledger. `restore:postgres` ripristina il database PostgreSQL completo. I due percorsi non sono intercambiabili.
