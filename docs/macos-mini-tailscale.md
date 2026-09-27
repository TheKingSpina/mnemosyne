# Mnemosyne — Mac mini M1 + Tailscale

Questa guida porta un Mnemosyne locale su un Mac mini Apple M1 con 8 GB di RAM e lo rende raggiungibile dal tailnet tramite Tailscale Serve.

## 1. Prerequisiti

- macOS aggiornato e almeno 15–20 GB liberi su SSD.
- Docker Desktop oppure OrbStack con Compose v2.
- Tailscale installato e autenticato sul Mac mini.
- Un account Tailscale con il mini aggiunto al tailnet corretto.
- Nessun servizio Mnemosyne già in esecuzione su porte 3000, 3333, 5432, 6379, 7474 o 8080, salvo verifica.

Il browser del Mac è fuori dal container: usa sempre le porte pubblicate da Compose o Tailscale Serve.

## 2. Inizializzazione sicura

Dal repository:

```bash
npm run env:init
```

Il comando crea `.env` con permessi `0600` e secret casuali solo se il file non esiste. Non inviare token o password in chat. Se `.env` esiste, non sovrascriverlo: controlla solo nomi delle variabili e permessi del file.

Per il solo dashboard/API sono sufficienti:

```bash
docker compose up --build -d postgres redis api web
```

Per estrazione, code e proiezione Neo4j usa lo stack completo:

```bash
docker compose up --build -d postgres redis neo4j api worker web
```

Per un worker locale senza provider remoto, svuota le variabili OpenRouter che potrebbero provenire dalla shell:

```bash
env -u OPENROUTER_API_KEY -u OPENROUTER_MODEL docker compose up -d --build postgres redis neo4j api worker web
```

Non usare `docker compose down -v` su un’istanza con dati: rimuove i volumi PostgreSQL e Neo4j.

## 3. Accesso dal tailnet

La dashboard resta su loopback e viene pubblicata solo tramite Tailscale Serve:

```bash
tailscale status
tailscale serve --bg --https=443 http://127.0.0.1:8080
tailscale serve status
```

Usa l’URL HTTPS mostrato da `tailscale serve status`. Non usare `tailscale funnel` per Mnemosyne. Restringi l’ACL Tailscale al solo utente e ai dispositivi autorizzati.

Apri la dashboard; il proxy interno `/api/backend` è implicito e non richiede alcun inserimento. Inserisci il valore di `MNEMOSYNE_OWNER_TOKEN` letto dal file `.env` sul mini. Il token resta nel browser solo per la sessione.

## 4. Verifica

```bash
docker compose ps --all
curl -fsS http://127.0.0.1:3000/health/ready
curl -fsS http://127.0.0.1:8080/ >/dev/null
```

Per verificare il proxy senza mostrare il token:

```bash
set -a; . ./.env; set +a
curl -fsS -H "authorization: Bearer $MNEMOSYNE_OWNER_TOKEN" \
  http://127.0.0.1:8080/api/backend/v1/admin/overview
```

Per l’MCP remoto, imposta `MCP_TRANSPORT=http` e `MCP_HOST=0.0.0.0` nel container, pubblica `127.0.0.1:3333` con Tailscale Serve e configura `MCP_ALLOWED_HOSTS`/`MCP_ALLOWED_ORIGINS`. Non esporre direttamente API, PostgreSQL, Redis o Neo4j.

### Client MCP su un’altra macchina

L’endpoint è quello mostrato da `tailscale serve status` e include porta e percorso, per esempio `https://mac-mini-di-alessandro-2.tail82e37f.ts.net:8443/mcp`. La protezione DNS rebinding accetta solo gli host in `MCP_ALLOWED_HOSTS`, quindi il client deve usare esattamente quel nome: l’IP del tailnet e il nome breve vengono rifiutati.

Sul mini l’autenticazione MCP è disattivata di proposito con `MNEMOSYNE_MCP_REQUIRE_TOKEN=false` e `MNEMOSYNE_MCP_ANONYMOUS_PROFILE=harness`: il perimetro è l’ACL del tailnet e il client non deve gestire segreti. Il client si configura con la sola URL:

```json
{
  "mcp": {
    "mnemosyne": {
      "type": "remote",
      "url": "https://mac-mini-di-alessandro-2.tail82e37f.ts.net:8443/mcp",
      "enabled": true
    }
  }
}
```

Verifica con `opencode mcp list` o con l’equivalente del client usato.

**Cosa comporta** il profilo anonimo `harness` non registra nemmeno i tool owner-only: `memory_forget`, `memory_export`, `memory_correct`, `memory_retract`, le review e `memory_admin_*` non compaiono in `tools/list` e ogni tentativo di chiamarli risponde che il tool non esiste. Restano disponibili sessioni, eventi, `memory_context`, `memory_propose`, letture e job, che è tutto ciò che serve a un agente. Dashboard e API `/v1/admin/*` restano protette da `MNEMOSYNE_OWNER_TOKEN`.

Con `MNEMOSYNE_MCP_ANONYMOUS_PROFILE=owner` ogni chiamante anonimo diventa owner: comodo per un usopersonale, ma `memory_forget` diventa irreversibile e raggiungibile da qualunque dispositivo del tailnet. Per tornare alla protezione completa: `MNEMOSYNE_MCP_REQUIRE_TOKEN=true` nel `.env` del mini e `docker compose up -d mcp`. I client dovranno allora mandare `Authorization: Bearer` con il token **del mini**, non quello di un altro `.env`, perché ogni `npm run env:init` genera segreti nuovi.

## 5. Risorse M1 8 GB

Neo4j è il servizio più pesante. Il Compose imposta già heap e page cache contenuti. Assegna a Docker/OrbStack circa 4–6 GB, lascia memoria al sistema e non eseguire build TypeScript pesanti sul mini mentre il servizio è attivo. Se Neo4j non serve, avvia solo `postgres redis api web`; l’assenza di Neo4j non influisce sul dashboard.

## 6. Backup

Il dump PostgreSQL deve essere cifrato e copiato fuori dal mini. I modelli `ops/backup/` sono pronti per `launchd` o `systemd`; il workflow raccomandato è:

```bash
npm run backup:postgres -- \
  --output /Volumes/Backup/mnemosyne-$(date -u +%Y%m%dT%H%M%SZ).dump \
  --verify-restore \
  --encrypt \
  --passphrase-file /Volumes/Backup/mnemosyne-backup.pass
```

Usa una passphrase file con permessi `0600`, conservata fuori dal repository. Verifica periodicamente il restore con `npm run restore:postgres` in un database target vuoto.

Il comando di backup richiede `MNEMOSYNE_DEPLOY_ENV_FILE` nell'ambiente: `docker compose` interpola tutti i servizi di `compose.yaml` anche per un `exec postgres`, quindi senza i valori di deployment il dump fallisce su `neo4j` o `worker`. I template in `ops/backup/` lo caricano da `run-backup.sh`; vedi [`ops/backup/README.md`](../ops/backup/README.md).

Un backup sul disco del mini non è un backup: copia il `.dump` e il suo `.manifest.json` fuori dal mini, su storage cifrato.

## 7. Persistenza dopo reboot

I servizi Compose hanno già `restart: unless-stopped`, quindi i container tornano da soli quando il daemon riparte. Restano due casi che il daemon non copre: un runtime mai avviato e uno stack lasciato indietro da un crash. `ops/host/` copre entrambi.

```bash
cat ~/Mnemosyne/ops/host/README.md   # render dei template + bootstrap launchd
```

In sintesi, sull'host devono esserci tre LaunchAgent in `~/Library/LaunchAgents`:

| Label                   | Effetto                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `com.mnemosyne.runtime` | Al login avvia OrbStack se il socket manca e lancia `docker compose up -d`.                            |
| `com.mnemosyne.health`  | Ogni 5 minuti sonda `/health/ready` e la dashboard; dopo 2 fallimenti consecutivi riconcilia lo stack. |
| `com.mnemosyne.backup`  | Ogni notte alle 02:00 dump cifrato con verifica restore e retention.                                   |

I log stanno in `~/Library/Logs/mnemosyne/`. Per lo stato:

```bash
launchctl list | grep mnemosyne
tail -f ~/Library/Logs/mnemosyne/mnemosyne-health.log
```

Abilita anche l'opzione "start at login" di OrbStack: il LaunchAgent è la rete di sicurezza, non il sostituto. L'auto-login deve restare attivo, altrimenti nessun agente parte dopo un riavvio. L'unica verifica completa è un riavvio reale: dopo il rientro controlla `docker compose ps --all`, `/health/ready` e la dashboard via tailnet.

## 8. Aggiornamenti e rollback

Prima di un aggiornamento esegui un backup verificato e annota il commit corrente. Dopo `git pull`:

```bash
docker compose up --build -d postgres redis neo4j api worker web
docker compose ps --all
```

Se un servizio non parte, leggi `docker compose logs --tail=200 <servizio>`. Non cancellare volumi come primo tentativo. Un rollback del database usa soltanto un dump verificato e un database target separato.
