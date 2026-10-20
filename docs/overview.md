# Mnemosyne — panoramica di progetto

Servizio di memoria governata e persistente per assistenti AI: conserva contesto utile
attraverso sessioni e progetti senza trasformare la cronologia in un flusso di istruzioni
non attendibile. Il principio è uno solo e attraversa tutto il sistema: **il modello
propone, il servizio decide**. Niente entra nel corpus senza passare dalla policy, niente
entra nel contesto senza essere `accepted`, niente viene dimenticato senza lasciare traccia
nel ledger.

Stato: ramo `feat/v2-graph-model` (versione v2 a grafo completo, permanentemente separata da `main`);
`main` (`a5d357c`) resta il deployment v1 stabile sul Mac mini (nessun merge previsto tra le due versioni).
Dettagli di stato in `docs/v2-handoff.md`, disegno in `docs/v2-graph-model-plan.md`, specifica in `docs/assistante-memoriale-spec.md`.

## 1. Infrastruttura

Tutto gira in Docker Compose sul laptop, tutto in loopback (`127.0.0.1`), sette container
con `restart: unless-stopped`.

### 1.1 Dati

| Servizio   | Immagine                 | Porta host  | Volume          | Ruolo                                                                                                                                                      |
| ---------- | ------------------------ | ----------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres` | `pgvector/pgvector:pg17` | 5432        | `postgres_data` | **Autoritativo.** Memorie, revisioni, progetti, aree, archi, sessioni, eventi, conflitti, job, outbox, ledger, embedding pgvector                          |
| `redis`    | `redis:7.4-alpine`       | 6379        | nessuno         | **Solo cache** del corpus (API e MCP), con validazione su revisione e revalidazione riga per riga. Perderlo non perde dati: si ricostituisce da PostgreSQL |
| `neo4j`    | `neo4j:5.26-community`   | 7474 (HTTP) | `neo4j_data`    | **Proiezione derivata** del grafo. Ricostruibile in qualsiasi momento da PostgreSQL con un rebuild                                                         |

Dettagli che contano:

- Bolt 7687 **non è pubblicato**: lo raggiunge solo il worker dentro la rete compose
  (`bolt://neo4j:7687`). Dall'host si vede solo l'HTTP 7474. Heap 512 MB, pagecache 256 MB.
- Se PostgreSQL non è raggiungibile, il servizio **non** restituisce un contesto vuoto come
  se fosse privo di memorie: degrada esplicitamente (stato `degraded`, mai silenzio).
- Se Redis è irraggiungibile o `REDIS_URL` non è impostato, l'avvio **non fallisce**:
  si lavora senza cache e il degrado è visibile solo in `projections.redis` nel report
  capacità. Per questo quel campo va letto insieme a `reporter`.
- Se Neo4j è giù, il worker non proietta e la capacità risulta gap: il corpus non ne
  risente, il grafo sì.

### 1.2 Processi (buildati dal `Dockerfile` multi-target su `node:22-alpine`)

| Servizio | Porta host | Dipende da (sani) | Fa                                                                                                                                       |
| -------- | ---------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `api`    | 3000       | postgres, redis   | REST. Unico punto d'ingresso esterno. Health su `/health/ready`                                                                          |
| `worker` | nessuna    | postgres, neo4j   | Estrazione, consolidation, retention schedulata, heartbeat capacità ogni 60 s, proiezione Neo4j via outbox. **Unico con `neo4j-driver`** |
| `mcp`    | 3333       | postgres, redis   | Server MCP (stdio o Streamable HTTP), stessa policy dell'API, cache propria. Fino a 1000 sessioni, idle 30 min, body max 1 MB            |
| `web`    | 8080       | api               | Dashboard statica con proxy verso `http://api:3000`                                                                                      |

Le configurazioni chiave passano da env con default sensati: poll outbox 1 s, lease 30 s,
3 tentativi con backoff 1 s, retention giornaliera, batch Neo4j 100, estrazione `local`
(OpenRouter spento salvo richiesta esplicita).

### 1.3 Flussi

```text
harness/client → api:3000 o mcp:3333 → PostgreSQL (+ Redis come cache)
                                              ↓ outbox
                                            worker → Neo4j
```

Mai il contrario: niente legge Neo4j come verità, niente tranne il worker lo scrive.
La web non tocca mai il database: parla solo con l'API.

### 1.4 Locale contro mini

Sul laptop le porte sono quelle sopra. Sul Mac mini la dashboard sta sulla 18080 (la 8080
è occupata da un altro processo da non toccare) e l'accesso remoto passa da Tailscale
Serve privato, mai Funnel. Tre agent launchd tengono in piedi runtime, health check ogni
5 minuti e backup cifrato alle 02:00. Vedi `docs/macos-mini-tailscale.md`.

## 2. Modello dati (v2)

### 2.1 Progetti: radici vere

`projects` è una tabella con nome unico case-insensitive. `memories.project_id` e
`sessions.project_id` sono chiavi esterne reali, e il progetto di una memoria è
**identità, non contenuto**: immutabile per trigger. `ON DELETE RESTRICT`, mai `CASCADE`:
una cascata cancellerebbe memorie senza scrivere riga nel forget ledger, e il ledger è
il documento che una memoria è mai stata rimossa. Cancellare un progetto che contiene
memorie deve essere un atto esplicito e governato, non un effetto collaterale.

Il progetto riservato `personal` (seeded, id stabile) sostituisce il vecchio scope
`global`: è una riga come le altre, e l'essere leggibile e scrivibile da ogni sessione
è policy attaccata al progetto, non un quarto tipo di scope. Ritirarlo è stato un rename
fedele, non un cambio di semantica.

### 2.2 Aree: sottografi facoltativi e dichiarati

`areas` è una tabella di entità **dichiarate da chi le crea, mai autovivificate**.
`memory_revisions.area_id` le referenzia, e la regola "l'area di una memoria appartiene
al progetto della memoria" attraversa due tabelle, quindi non può essere una foreign key:
è un trigger che alza `23503` (lo stesso SQLSTATE di una FK), mappato a 409 dal percorso
esistente. Una sessione può riferire solo aree dichiarate del proprio progetto
(404 se l'area non esiste, 409 se è di un altro progetto).

### 2.3 Memorie, revisioni, scope derivato

Record logico + revisioni immutabili. Lo scope **non è memorizzato come testo**: è
derivato alla lettura — revisione con sessione → scope sessione, con area → scope area,
altrimenti scope del progetto. I tipi sono tre: `session | project | area`.
Riclassificare una memoria dentro la sua radice è una revisione; spostarla in un'altra
radice non è permesso. Le relazioni fra progetti si esprimono con archi, mai spostando
memorie.

Per non pagare il join a ogni ricerca, `project_id` vive anche come copia di sola
lettura su `memory_revisions`, scritta dal trigger (sovrascrive qualunque valore fornito,
quindi non può divergere): il filtro full-text lavora sulla sola tabella delle revisioni
e l'indice GIN fa il suo lavoro (il join costava 29x misurato).

Esempio: una memoria con `area_id = sviluppo` nel progetto `lavoro` si legge come
`{type:'area', id:'sviluppo'}`; togliendo l'area dalla revisione successiva torna
`{type:'project', id:'lavoro'}` senza aver mai mosso la memoria.

### 2.4 Archi pesati fra nodi

Due tabelle, non una coppia polimorfica (un `from_id`/`to_id` polimorfo non porta chiavi
estere e il forget lascerebbe archi penzolanti): `memory_arcs` (anche fra progetti
diversi) e `project_arcs`. Ogni arco ha `type` aperto e `weight` opzionale 0..1, con
unicità sulla tripla `(from, to, type)` così riprovare una proposta è idempotente. Sono
righe governate con lo stesso ciclo di vita delle memorie: un client propone e atterra
`pending_approval`, il percorso owner inserisce accettato, solo gli accettati raggiungono
il grafo (come `:LINK`).

I cicli sono legittimi: due memorie che si influenzano a vicenda sono la norma. Non lo è
una gerarchia con un ciclo, quindi `hierarchical_relation` nomina i tipi che devono
restare aciclici e un trigger rifiuta l'arco che chiuderebbe il ciclo. Il walk è
ricorsivo con `UNION` (non `UNION ALL`) così termina anche su dati che contengono già un
ciclo, e usa un lock advisory perché senza due transazioni che inseriscono le due metà
opposte passerebbero entrambe leggendo lo stato pre-commit. Solo gli archi `accepted`
partecipano: una proposta non ancora approvata non può chiudere un ciclo.

### 2.5 Ciclo di vita

```text
pending_approval → accepted | rejected
accepted → superseded (nuova revisione) | expired | retracted | forgotten
```

Solo `accepted` entra nel contesto; `pending` non filtra mai nel contesto (garantito da
test di governance). `retracted` dichiara falso senza cancellare; `forgotten` rimuove
contenuto e derivazioni lasciando tombstone + ledger.

## 3. Governance

### 3.1 Proporre e revisionare

- **Harness**: `POST /v1/proposals` (o tool `memory_propose`) con `sessionId`, contenuto,
  `kind`, scope, basi epistemiche, confidenza, sensitività. Il servizio valida, cerca
  duplicati (una riproposta aggancia le sorgenti invece di duplicare) e applica la policy:
  quasi tutto atterra `pending_approval`. Per disegnare un arco serve la sessione aperta
  (`POST /v1/arcs`, `POST /v1/project-arcs`, permesso `memory.propose`).
- **Owner**: stesso endpoint con token owner atterra `accepted`; le review passano da
  `POST /v1/proposals/{id}/decision` (e `/v1/admin/arcs/{id}/review` per gli archi) con
  `expectedVersion` — una modifica concorrente dà 409, niente sovrascritture silenziose.
- **Correggere** crea una nuova revisione e invalida la precedente (`SUPERSEDES` logico);
  **revocare** dichiara errato; **dimenticare** è in due fasi (`prepare` con payload firmato
  HMAC, poi esecuzione) e si propaga a PostgreSQL, pgvector, Neo4j e Redis.

### 3.2 Conflitti

Record espliciti, non risultati di ranking. Oggi solo `direct_contradiction`: stesso tipo,
stessa frase parola per parola, esattamente una negazione, **qualunque sia l'ambito**.
Si rileva confrontando ogni nuova proposta con le memorie accettate (per questo l'ordine
conta: prima si accetta A, poi si propone non-A). Risoluzione owner dedicata.

### 3.3 Idempotenza e auth

Ogni POST di scrittura richiede `Idempotency-Key`: stessa chiave + stesso payload =
replay del risultato, payload diverso = conflitto. Il replay è persistente su PostgreSQL.
Auth su tre livelli: token owner/harness distinti, token per-client revocabili (ruolo
owner), profilo anonimo opzionale dietro perimetro esterno. Ogni header `Authorization`
presente è sempre verificato: token valido = il suo profilo, non valido o revocato = 401,
mai downgrade silenzioso. I permessi sono per path (`memory.propose`, `proposal.review`,
`memory.read`, `memory.correct`, `memory.retract`, `memory.forget`, `session.manage`,
`context.resolve`, …) e per gli archi valgono le stesse regole delle memorie.

## 4. Retrieval

Pipeline: analisi query → candidati lessicali (max 1000, almeno 200 o 20x il limite) →
filtro scope esatto → boost semantici sopra soglia → reintegro per id → ranking e budget
token. Il ranking è deterministico: match lessicale token-aware con stemming minimo
it/en, stopword, pesi BM25/IDF sul candidate set, bonus frase/prossimità, fusione
semantica locale, soglie e tie-break su `memoryId`. Misure su 10.000 memorie sintetiche:
query discriminative ~2 ms; la cache su repeat fa ~59x al prezzo di ~3% sul miss; il
percorso semantico costa ~1 ms (ottimizzarlo non sposta nulla, misurato). La telemetria
di retrieval riporta solo conteggi e bande di punteggio: per forma dello schema non può
contenere testo, id, scope o contenuto.

## 5. API REST

Contratto OpenAPI 3.1 generato dai contratti Zod condivisi, servito a `/v1/openapi.json`
(il test ne confronta l'elenco ordinato dei path: aggiungere una rotta senza aggiornare
la lista rompe il gate).

- **Sessioni ed eventi**: `POST /v1/sessions` (provisiona il progetto al primo uso),
  `POST /v1/sessions/{id}/events` (idempotenti per `session+event_id`),
  `POST /v1/sessions/{id}/close` (consolidation).
- **Proposte**: `POST /v1/proposals`, `GET /v1/proposals` (pending),
  `POST /v1/proposals/{id}/decision`.
- **Archi**: `POST`+`GET /v1/arcs?memoryId=`, `POST`+`GET /v1/project-arcs?projectId=`,
  `POST /v1/admin/arcs/{arc_id}/review`, `GET /v1/admin/arcs` (tutti in una chiamata).
- **Memorie e contesto**: `POST /v1/context/resolve` (budget token),
  `GET /v1/memories` (ricerca+filtri), `GET /v1/memories/{id}`, correzioni, retrazioni,
  `forget/prepare` + `forget`, `feedback`, `GET /v1/jobs/{id}`.
- **Esplorazione**: `GET /v1/projects` (l'elenco dei progetti con la loro dimensione:
  conteggi di memorie per stato, conflitti aperti, aree, sessioni, archi),
  `GET /v1/projects/{id}` (profilo del progetto: aree, ripartizione per tipo/stato/scope,
  memorie più recenti, conflitti aperti, relazioni fra progetti),
  `GET /v1/projects/{id}/memories` (memorie del progetto con filtri e paginazione).
  Il profilo harness passa `sessionId`: è la sessione che determina gli scope visibili,
  e vede solo le memorie accepted che raggiunge. I conteggi sono aggregati di corpus e
  non contengono contenuto, quindi entrambi i profili leggono gli stessi numeri. La
  parte coperta dalla revisione del corpus è in cache Redis; progetti, aree e sessioni
  sono riletti freschi a ogni chiamata, perché creare un progetto o una sessione non
  sposta la revisione e una directory cacheata sotto la sola revisione nasconderebbe
  il progetto appena creato. Gli aggregati sono calcolati in SQL (`GROUP BY`), non
  idratando il corpus in memoria: a 10.000 memorie in un unico progetto la directory
  passa da 39,7 ms a 1,8 ms senza cache e a 0,3 ms con cache, il profilo del progetto
  da 49,3 ms a 4,9 ms e la prima pagina dell'elenco memorie da 45,5 ms a 3,0 ms.
- **Admin (owner)**: overview, client-tokens (+revoke), capabilities (process-scoped:
  leggere sempre `reporter`), telemetry retrieval, embeddings health/reindex, memories,
  projects (+ `POST /v1/admin/projects/{id}/privacy`: marking manuale, mai inferito),
  conflicts (+resolution), arcs, sessions, jobs, retention (+run), `pruning/analyze`
  (risponde `disabled` senza analyzer: spento è lo stato sicuro, non un errore),
  exports/corpus, restore/corpus.

## 6. MCP

Stessa policy dell'API, due profili. Trasporti: stdio in locale, Streamable HTTP in
remoto. **harness** (proporre, mai decidere): `memory_open_session`,
`memory_record_events`, `memory_context`, `memory_search`, `memory_propose`,
`memory_propose_arc`, `memory_close_session`, `memory_get_job`. **Esplorazione, in
entrambi i profili**: `memory_list_projects` (l'elenco dei progetti con la loro
dimensione: è la chiamata che un agente fa per orientarsi, perché l'id di progetto è
quello che `memory_open_session` richiede), `memory_get_project` (aree, ripartizione per
tipo/stato/scope, memorie più recenti, conflitti aperti, relazioni fra progetti),
`memory_list_project_memories` (memorie di un progetto, con filtri e paginazione),
`memory_get_memory` (una memoria con archi e conflitti). Nel profilo harness questi
tool richiedono `sessionId`: è la sessione che determina gli scope visibili, e
l'unica memoria accettata che l'agente raggiunge. L'owner legge il corpus com'è.
**owner**: review e
governance (`memory_review_decision`, `memory_review_arc`, `memory_propose_owner`,
`memory_correct`, `memory_retract`, `memory_prepare_forget`, `memory_forget`,
`memory_pending_review`), conflitti (`memory_list_conflicts`, `memory_resolve_conflict`),
export/restore, retention (`memory_retention_status`, `memory_run_retention`), job, e
amministrazione (`memory_admin_overview`, `memory_admin_capabilities`,
`memory_admin_retrieval_telemetry`, `memory_admin_embedding_health`,
`memory_admin_reindex_embeddings`, `memory_admin_memories`, `memory_admin_sessions`,
`memory_admin_jobs`). La policy è verificata nel callback di ogni tool: la visibilità
dei tool è ergonomia, non sicurezza. DNS-rebinding protetto su hostname Tailscale.

## 7. Dashboard owner

Console locale (token nel campo apposito, tenuto in `sessionStorage`): overview, ricerca
con filtri (stato, tipo, scope), review con approva/rifiuta inline, storia, conflitti,
preview contesto e **vista Grafo** su canvas nativo. Il grafo raggruppa per scope con
layout statico: hub viola per gli ambiti, pallini colorati per tipo/stato per le memorie,
nodi viola grandi per i progetti in una banda sopra i cluster. Archi: scope tenue,
conflitti rosa tratteggiati, archi fra memorie ciano con peso nello spessore (ambra
tratteggiati se pending), archi fra progetti viola. Inspector con tipo/peso/stato di ogni
relazione, filtri per stato/ambito/testo, etichette, zoom/pan, click persistente, stat e
legenda. Carica fino a 2000 memorie (20 pagine) più conflitti, archi e progetti.

## 8. Worker

- **Estrazione locale** (default; OpenRouter spento): comandi espliciti "ricorda…" con
  marcatori di scope (`per questa sessione`, `area X`, `globalmente/in tutte le sessioni`
  → progetto `personal`), più estrattore da provider come fallback. Le candidate passano
  comunque da `proposeMemory`: l'estrazione non auto-accetta mai.
- **Consolidation** a chiusura sessione: fonde pending duplicate senza accettarle.
- **Retention** schedulata ogni 24 h (vedi §10), forzabile dall'owner.
- **Analyzer di potatura** (stadio 1, spento senza flag esplicito): batch same-flag di
  memorie marcate manualmente (`local_only` scartato prima di ogni chiamata,
  `anonymized` senza contenuto), proposte `llm` firmate con `model_version` +
  `prompt_hash`, decisione nella retention col veto. Finestra notturna opzionale
  `WORKER_ANALYZER_WINDOW` (es. `03:30-06:00` dopo il backup 02:00) e rientranza per
  costruzione: batch id dai membri, già-analizzato mai rispedito, pending esclusi,
  contatori `skipped` nel report. Probing: `node scripts/probe-analyzer.mjs`.
- **Proiezione Neo4j** incrementale da outbox (batch 100, lease 30 s) con `rebuild()`
  completo: `:Project` per ogni progetto governato, `:Area` per ogni area dichiarata,
  ogni memoria legata con `IN_PROJECT`, le area-scoped anche con `IN_AREA`, le aree con
  `(Area)-[:PART_OF]->(Project)`, `:LINK` per gli archi accettati. Solo il grafo live
  controlla il Cypher: è stringa per ogni altro gate.
- **Heartbeat capacità** ogni 60 s su tabella dedicata (fidato per 300 s): API e MCP non
  vedono estrattore/Neo4j/retention, li attestano tramite lui.

## 9. Export, restore, backup

Export canonico (schema `CorpusExport`): sessioni, **progetti con righe complete**,
**aree**, eventi, memorie, revisioni, conflitti, job, ledger, **archi**. Restore su
database vuoto (`restore_requires_empty_corpus`): progetti in upsert (l'export fa fede
anche sul `personal` seedato), poi aree, sessioni e resto; un arco con endpoint
dimenticato viene saltato invece di far fallire tutto. Il restore **non** ricostruisce
gli embedding: serve `reindex` esplicito e `embeddings/health` lo segnala
(`indexedForActiveProfile`, `missingCount`, `needsReindex`; 409 se nessun provider).
Backup PostgreSQL cifrato con restore verificato e retention, sui dischi del mini
(decisione dell'operatore: disco e backup condividono il destino).

## 10. Potatura (balanced retention)

| Cosa                              | Finestra    | Note                                                                                                    |
| --------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| Eventi di sessioni chiuse         | 30 g        |                                                                                                         |
| Candidate pending mai revisionate | 30 g        |                                                                                                         |
| Candidate rejected                | 7 g         |                                                                                                         |
| Revisioni superseded              | 90 g        |                                                                                                         |
| Memorie retracted                 | 30 g        |                                                                                                         |
| Outbox `processed`                | 3 g         | Senza bump di revisione: è feed derivato, invalidare la cache per righe invisibili sarebbe puro costo   |
| Tombstone forget ledger           | mai         | Per design                                                                                              |
| Job terminali                     | 30 g        | Senza bump di revisione: pulizia operativa automatica di `succeeded`/`failed`/`quarantined`/`cancelled` |
| Chiavi idempotency                | 30 g        | Senza bump di revisione: pulizia delle chiavi oltre la finestra di in-flight                            |
| Cache Redis                       | TTL proprio | Si auto-guarisce                                                                                        |

Run giornaliero + trigger owner, report `deleted.*` per categoria con cutoffs. Il backend
in-memory applica le stesse regole del Postgres: è così che il leak outbox restava
invisibile ai test che non usano PostgreSQL.

### Potatura semantica (nella stessa run)

Lo scorer deterministico punteggia con recency + peso archi incidenti + kind (accessi deliberatamente
fuori), su memorie e archi **accettati**; ogni finding diventa riga governata in
`pruning_proposals` (fuori export), e la run decide solo su rilettura fresca: ciò che si è
mosso va `stale`, il resto esegue o viene rifiutato con motivo. Il decay porta a
`expired` (stato preesistente, mai scritto prima) dove esce dal contesto restando
ispezionabile; gli archi deboli non gerarchici vengono cancellati; kind esenti e relazioni
gerarchiche non sono mai auto-potabili; ogni esecuzione finisce in `pruning_ledger`.
Lo score che propone è anche la confidence registrata. L'analizzatore LLM (quando è
abilitato) scrive proposte `proposer='llm'` e il veto deterministico decide: vedi
[`potatura-semantica.md`](potatura-semantica.md) per il disegno completo (due stadi,
privacy marking, giudice encoder su llama.cpp).

## 11. Verifica

- `npm run verify`: build + 249 test (1 skipped) + lint + format. Regola: build dopo
  ogni modifica logica, `vitest` sul singolo file toccato.
- `npm run eval:all`: governance 9/9 (inclusi i guard cross-scope), retrieval 11/11 a
  nDCG 1.0 con giudizi rivisti (hash dataset `fe1369c0cd5e`, riportato non pinnato).
- `npm run e2e:synthetic`: flusso completo su container isolati usa-e-getta
  (PostgreSQL+pgvector, Redis, Neo4j): ciclo di vita a tre memorie (una area-scoped),
  asserzioni psql sui vincoli (immutabilità, unicità area, RESTRICT, cicli gerarchici
  rifiutati e influenze consentite), grafo live (`IN_PROJECT`/`IN_AREA`/`PART_OF`),
  export/restore con nomi preservati, marking privacy via endpoint owner e flag in export,
  risposta `disabled` dell'analisi senza analyzer, reindex embedding.
- Load test su 10.000 memorie sintetiche: governato ~212/s, bulk ~545/s, reindex 17 s;
  query discriminative ~2 ms, caso patologico full-match ~91 ms (proprietà della query,
  non dell'indice).

## 12. Rami, documenti, glossario

Branch `feat/v2-graph-model`, tutto locale, mai pushato; `main` intatta per il mini.
Documenti: questa panoramica, `docs/v2-handoff.md` (stato, decisioni, gap futuri),
`docs/v2-graph-model-plan.md` (disegno con DDL validato), `docs/assistante-memoriale-spec.md`
(specifica §§7/8.7/9.2/10.4/12.1/13.2 aggiornati), `docs/retrieval-ranking.md`,
`docs/privacy.md`, `docs/threat-model.md`, `docs/backup-restore.md`, `docs/migration.md`,
`docs/macos-mini-tailscale.md`, `docs/adr/`, `docs/openapi.yaml` (rigenerato, non scritto
a mano), `README.md`, `CHANGELOG.md`.

Glossario minimo: **corpus** = l'insieme governato; **harness** = client non privilegiato
che propone; **owner** = chi revisiona e amministra; **scope** = ambito derivato di una
revisione; **root** = progetto (sempre) o area (se dichiarata); **arco** = relazione
pesata e governata fra nodi; **proiezione** = Neo4j, derivata e ricostruibile;
**outbox** = feed degli eventi da proiettare; **ledger** = registro indelebile dei forget;
**consolidation** = fusione delle pending a chiusura sessione; **retention** = potatura
schedulata secondo policy.
