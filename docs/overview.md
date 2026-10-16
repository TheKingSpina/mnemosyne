# Mnemosyne — panoramica di progetto

Servizio di memoria governata e persistente per assistenti AI: conserva contesto utile
attraverso sessioni e progetti senza trasformare la cronologia in un flusso di istruzioni
non attendibile. Il modello propone, il servizio decide.

Stato: ramo `feat/v2-graph-model` (locale, mai pushato) con il modello a grafo completo;
`main` (`a5d357c`) resta il deployment. Dettagli di stato in `docs/v2-handoff.md`, disegno
in `docs/v2-graph-model-plan.md`, specifica in `docs/assistante-memoriale-spec.md`.

## 1. Infrastruttura

Tutto gira in Docker Compose sul laptop, tutto in loopback (`127.0.0.1`), sette container.

### Dati

| Servizio   | Immagine                 | Porta host  | Volume          | Ruolo                                                                              |
| ---------- | ------------------------ | ----------- | --------------- | ---------------------------------------------------------------------------------- |
| `postgres` | `pgvector/pgvector:pg17` | 5432        | `postgres_data` | Autoritativo: memorie, revisioni, progetti, aree, archi, outbox, ledger, embedding |
| `redis`    | `redis:7.4-alpine`       | 6379        | nessuno         | Solo cache del corpus, con validazione su revisione; perderlo non perde dati       |
| `neo4j`    | `neo4j:5.26-community`   | 7474 (HTTP) | `neo4j_data`    | Proiezione derivata del grafo, ricostruibile da PostgreSQL                         |

Bolt 7687 non è pubblicato: lo raggiunge solo il worker dentro la rete compose
(`bolt://neo4j:7687`). Heap 512 MB, pagecache 256 MB.

### Processi (buildati dal `Dockerfile` multi-target su `node:22-alpine`)

| Servizio | Porta host | Dipende da      | Fa                                                                                                                                |
| -------- | ---------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `api`    | 3000       | postgres, redis | REST, unico punto d'ingresso esterno                                                                                              |
| `worker` | nessuna    | postgres, neo4j | Estrazione, consolidation, retention schedulata, heartbeat capacità (60 s), proiezione Neo4j via outbox. Unico con `neo4j-driver` |
| `mcp`    | 3333       | postgres, redis | Server MCP (stdio o Streamable HTTP), stessa policy dell'API, cache propria                                                       |
| `web`    | 8080       | api             | Dashboard statica con proxy verso l'API                                                                                           |

Flussi: client → `api:3000` o `mcp:3333` → PostgreSQL (+ Redis come cache) → outbox →
worker → Neo4j. Mai il contrario: niente legge Neo4j come verità, niente tranne il
worker lo scrive. Restart `unless-stopped` ovunque, healthcheck su tutti tranne
mcp/worker.

## 2. Modello dati (v2)

- **Progetti** (`projects`): radici vere del grafo, tabella con nome unico
  case-insensitive. `memories.project_id` e `sessions.project_id` sono chiavi esterne
  reali; il progetto di una memoria è immutabile per trigger (`RESTRICT`, mai `CASCADE`,
  per non cancellare memorie senza riga nel forget ledger).
- **Aree** (`areas`): radici opzionali di sottografi, entità dichiarate da chi le crea,
  mai autovivificate. `memory_revisions.area_id` le referenzia con trigger che impone
  l'appartenenza allo stesso progetto della memoria (errore `23503`, mappato a 409).
- **Memorie e revisioni**: record logico + revisioni immutabili. Il progetto `personal`
  riservato è visibile e scrivibile da ogni sessione come policy, non come tipo di scope.
- **Scope**: tre tipi, `session | project | area`, **derivati alla lettura** (mai
  memorizzati): revisione con sessione → scope sessione, con area → scope area, altrimenti
  scope del progetto. `global` è ritirato.
- **Archi pesati**, righe governate con lo stesso ciclo di vita delle memorie:
  `memory_arcs` (anche fra progetti diversi) e `project_arcs`, `type` aperto e `weight`
  opzionale 0..1. I cicli sono legittimi; solo i tipi dichiarati gerarchici in
  `hierarchical_relation` devono restare aciclici (trigger con walk ricorsivo
  `UNION` + lock advisory). Solo gli archi `accepted` raggiungono il grafo.
- **Lifecycle memorie**: `pending_approval → accepted | rejected`; poi `superseded`,
  `expired`, `retracted`, `forgotten` (tombstone + ledger, contenuto rimosso). Solo
  `accepted` entra nel contesto.

## 3. Governance

- Client (harness) propone → `pending_approval`; percorso owner → `accepted`; solo
  l'owner revisiona (`proposal.review`). Policy deterministica e indipendente dal provider.
- **Conflitti** espliciti, oggi solo `direct_contradiction` (stessa frase, una negazione,
  qualunque ambito). Si rileva confrontando la nuova proposta con le memorie accettate.
- **Forget** in due fasi (`prepare` con payload firmato HMAC, poi esecuzione) con ledger;
  si propaga a PostgreSQL, pgvector, Neo4j e Redis.
- **Idempotenza**: ogni POST di scrittura richiede `Idempotency-Key`; stessa chiave +
  stesso payload = replay, payload diverso = conflitto. Replay persistente su PostgreSQL.
- **Auth**: token owner/harness distinti, token per-client revocabili (`owner` role),
  profilo anonimo opzionale dietro perimetro esterno; ogni `Authorization` è sempre
  verificata (401, mai downgrade silenzioso). Permessi per path (`memory.propose`,
  `proposal.review`, `memory.read`, …).

## 4. Retrieval

Ibrido deterministico: match lessicale token-aware con stemming minimo it/en, stopword,
pesi BM25/IDF sul candidate set, bonus frase/prossimità, fusione semantica locale
(hashed bag-of-words), soglie e tie-break deterministico. PostgreSQL usa l'indice GIN
esistente con query full-text spinta in CTE `MATERIALIZED` su `memory_revisions`
(il join con `memories` costava 29x misurato). Cache Redis decisiva sui repeat
(~59x) al prezzo di ~3% sul miss; il percorso semantico costa ~1 ms. Telemetria di
retrieval solo conteggi, senza testo né id (privacy per forma dello schema).

## 5. API REST (contratto OpenAPI 3.1 generato, `/v1/openapi.json`)

Sessioni ed eventi: `POST /v1/sessions`, `POST /v1/sessions/{id}/events`,
`POST /v1/sessions/{id}/close`. Proposte: `POST /v1/proposals`,
`GET /v1/proposals`, `POST /v1/proposals/{id}/decision`. Archi:
`POST+GET /v1/arcs`, `POST+GET /v1/project-arcs`,
`POST /v1/admin/arcs/{arc_id}/review`, `GET /v1/admin/arcs`.
Memorie e contesto: `POST /v1/context/resolve`, `GET /v1/memories`,
`GET /v1/memories/{id}`, correzioni, retrazioni, `forget/prepare` + `forget`,
`feedback`, `GET /v1/jobs/{id}`. Admin (owner): overview, client-tokens,
capabilities, telemetry, embeddings health/reindex, memories, **projects**,
conflicts (+resolution), arcs, sessions, jobs, retention (+run), exports/corpus,
restore/corpus.

## 6. MCP

Due profili. **harness**: `memory_open_session`, `memory_record_events`,
`memory_context`, `memory_search`, `memory_propose`, `memory_propose_arc`,
`memory_close_session`, `memory_get_job`. **owner**: review e governance
(`memory_review_decision`, `memory_review_arc`, `memory_propose_owner`,
`memory_correct`, `memory_retract`, `memory_prepare_forget`, `memory_forget`,
`memory_pending_review`, conflitti), export/restore, retention, jobs, stato
(admin/overview/capabilities/telemetry/embeddings/memories/sessions). La policy è
verificata nel callback, mai solo dalla visibilità dei tool.

## 7. Dashboard owner

Console locale: overview, ricerca, review, storia, conflitti, preview del contesto e
**vista Grafo** (canvas nativo a cluster per scope): nodi memoria/ambito/progetto,
archi di scope, conflitti tratteggiati, archi fra memorie ciano con peso nello spessore
(ambra tratteggiati se pending), archi fra progetti viola, inspector con tipo/peso/stato,
filtri, zoom/pan, stat e legenda.

## 8. Worker

Estrazione locale (comandi "ricorda…" + marcatori di scope, inclusa risoluzione
"in tutte le sessioni" → progetto `personal`), consolidation a chiusura sessione
(senza auto-accept), retention schedulata ogni 24 h (forzabile dall'owner),
proiezione Neo4j incrementale da outbox con `rebuild()` completo:
nodi `:Project`/`:Area`/`:Memory`, `IN_PROJECT`, `IN_AREA`, `(Area)-[:PART_OF]->(Project)`,
`:LINK` per gli archi accettati.

## 9. Export, restore, backup

Export canonico del corpus (sessioni, progetti, aree, eventi, memorie, revisioni,
conflitti, job, ledger, archi) con download no-store; restore su database vuoto che
riapplica ledger e salta gli archi con endpoint dimenticati. Il restore **non**
ricostruisce gli embedding: serve `reindex` esplicito (health lo segnala). Backup
PostgreSQL cifrato con restore verificato e retention, su disco del mini.

## 10. Potatura (balanced retention)

| Cosa                              | Finestra                                       |
| --------------------------------- | ---------------------------------------------- |
| Eventi di sessioni chiuse         | 30 g                                           |
| Candidate pending mai revisionate | 30 g                                           |
| Candidate rejected                | 7 g                                            |
| Revisioni superseded              | 90 g                                           |
| Memorie retracted                 | 30 g                                           |
| Outbox `processed`                | 3 g (senza bump di revisione: è feed derivato) |

Run giornaliero + trigger owner, report `deleted.*` per categoria. Fuori: job terminali,
chiavi idempotency, tombstone del ledger (per design), TTL Redis, retention backup.
Le prime due sono l'unica crescita illimitata rimasta.

## 11. Verifica

- `npm run verify`: build + 206 test (1 skipped) + lint + format.
- `npm run eval:all`: governance 9/9, retrieval 11/11 a nDCG 1.0 (hash dataset `fe1369c0cd5e`).
- `npm run e2e:synthetic`: flusso completo su container isolati usa-e-getta
  (PostgreSQL+pgvector, Redis, Neo4j), con asserzioni psql sui vincoli, ciclo di vita
  a tre memorie, grafo live (`IN_PROJECT`/`IN_AREA`/`PART_OF`), export/restore,
  reindex embedding. Solo il grafo live controlla il Cypher.
- Load test dedicato con 10.000 memorie sintetiche (query discriminative ~2 ms).

## 12. Rami e documenti

Branch `feat/v2-graph-model`, tutto locale, mai pushato; `main` intatta per il
deployment del Mac mini (Tailscale privato, mai Funnel). Documenti: questa panoramica,
`docs/v2-handoff.md` (stato e decisioni), `docs/v2-graph-model-plan.md` (disegno),
`docs/assistante-memoriale-spec.md` (specifica), `docs/retrieval-ranking.md`,
`docs/privacy.md`, `docs/threat-model.md`, `docs/backup-restore.md`, `docs/migration.md`,
`docs/macos-mini-tailscale.md`, `docs/adr/`.
