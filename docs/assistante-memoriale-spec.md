# Mnemosyne — Specifica tecnica del sistema di memoria per un assistente memoriale

**Stato:** specifica consolidata della progettazione
**Versione:** 0.4
**Ambito:** software open source per un assistente personale monoutente, riutilizzabile tra progetti
**Licenza:** AGPL-3.0

## 1. Sintesi

Il sistema è un livello di memoria persistente per harness e assistenti LLM. Non appartiene a un singolo repository: conserva informazioni utili a più progetti, con ambiti separati e sovrapposti.

La memoria ha tre proprietà fondamentali:

1. **È centralizzata** su un servizio sempre raggiungibile dal Mac mini M1.
2. **È governata**: il modello propone, mentre il servizio valida e applica le policy.
3. **È ispezionabile e correggibile**: l'utente può capire perché una memoria esiste, modificarla, revocarla o dimenticarla.

Il flusso principale è:

```text
conversazione
  → eventi incrementali
  → proposte candidate
  → validazione, deduplicazione e conflitti
  → policy ibrida
  → memorie approvate
  → contesto per le sessioni successive
```

Il sistema può essere utilizzato come:

- server **MCP** per l'harness;
- API REST versionata;
- CLI per l'owner;
- base per una futura UI locale.

Tutte le interfacce usano lo stesso Memory Core e le stesse policy.

## 2. Obiettivi

- Conservare preferenze, convenzioni, decisioni, fatti, ipotesi ed eventi utili.
- Rendere la memoria disponibile tra progetti senza duplicare le informazioni personali.
- Separare chiaramente informazioni di sessione, progetto, area e ambito personale globale.
- Non inserire nel contesto candidate non approvate.
- Rilevare e mostrare conflitti, ambiguità e informazioni obsolete.
- Consentire revisione, correzione, revoca e dimenticanza.
- Recuperare il contesto in modo ibrido: lessicale, semantico e relazionale.
- Supportare più provider LLM, con OpenRouter come prima rotta configurabile.
- Funzionare come servizio remoto privato, senza esporre database o porte amministrative.
- Consentire ricostruzione delle proiezioni e ripristino del servizio.
- Essere valutabile con dataset annotati e test deterministici.
- Rendere il software riproducibile, verificabile e disponibile pubblicamente, senza includere dati personali nel repository.

## 3. Non obiettivi della prima versione

La prima versione non include:

- multiutente e ACL condivise;
- workspace condivisi;
- pubblicazione automatica su Internet;
- crawling generale del Web;
- indicizzazione indiscriminata del filesystem;
- importazione silenziosa della cronologia del browser;
- apprendimento automatico di preferenze senza policy esplicita;
- UI grafica elaborata;
- sincronizzazione distribuita tra più host come alta disponibilità;
- provider locali come requisito obbligatorio;
- orchestrazione Kubernetes.

## 4. Ruoli e confini

### 4.1 Owner

L'utente proprietario può:

- aprire e gestire la configurazione;
- revisionare candidate;
- accettare, modificare, rifiutare o rinviare;
- correggere e revocare memorie;
- avviare la dimenticanza;
- esportare l'archivio;
- configurare retention e provider ammessi;
- controllare proiezioni, backup e stato del servizio.

### 4.2 Harness

L'harness può:

- aprire e chiudere sessioni;
- inviare eventi incrementali;
- richiedere il contesto;
- cercare memorie approvate;
- leggere memorie utilizzabili e fonti autorizzate;
- proporre candidate e correzioni;
- inviare feedback non distruttivo;
- controllare i propri job.

L'harness non può approvare, dimenticare, esportare o modificare direttamente una memoria attiva.

### 4.3 Worker e provider

Il worker esegue estrazione, classificazione, consolidamento e aggiornamento delle proiezioni. I provider LLM sono strumenti esterni al Memory Core: possono proporre o classificare, ma non possono aggirare le policy.

## 5. Decisioni architetturali confermate

| Area | Decisione |
|---|---|
| Utente | Monoutente |
| Host principale | Mac mini M1 |
| Orchestrazione | Docker Compose |
| Fonte autorevole | PostgreSQL |
| Ricerca semantica | PostgreSQL con `pgvector` |
| Grafo | Modello relazionale canonico in PostgreSQL; Neo4j come proiezione derivata |
| Cache | Redis, volatile e ricostruibile |
| Trasporto per l'harness | MCP `stdio` o Streamable HTTP |
| Accesso remoto | Canale privato e autenticato; Tailscale prima implementazione |
| Protezione del traffico | HTTPS |
| API | REST `/v1`, documentata con OpenAPI |
| Amministrazione | CLI iniziale, UI successiva opzionale |
| Provider principale | OpenRouter, con adapter multiprovider |
| Estrazione | Incrementale, con consolidamento a fine sessione |
| Promozione | Ibrida: automatica conservativa e revisione esplicita |
| Contesto | Esclusivamente memorie approvate e compatibili con scope e sensibilità |
| Modalità distruttive | Esclusivamente owner, con conferma esplicita |

## 6. Architettura complessiva

```text
                 ┌──────────────────────┐
                 │  Harness / Client    │
                 │  MCP, REST o CLI     │
                 └──────────┬───────────┘
                            │
                 canale privato + HTTPS
                            │
        ┌───────────────────▼───────────────────┐
        │             Memory Core               │
        │                                       │
        │ API · policy · sessioni · retrieval   │
        │ worker · review · proiezioni          │
        └───┬──────────────┬──────────────┬─────┘
            │              │              │
       ┌────▼────┐   ┌─────▼─────┐   ┌────▼────┐
       │PostgreSQL│   │  Neo4j    │   │ Redis   │
       │+pgvector │   │  derivato │   │ cache   │
       └────┬─────┘   └───────────┘   └─────────┘
            │
       WAL e backup esterno
```

### 6.1 Ruolo dei componenti

- **PostgreSQL:** contenuto canonico, scope, stati, versioni, fonti, conflitti, audit, outbox e vettori.
- **Neo4j:** relazioni tipizzate per navigazione e percorsi; non è fonte di verità.
- **Redis:** working set e cache di composizioni del contesto; non decide nulla.
- **Memory Core:** applica policy, coordina le operazioni e controlla le proiezioni.
- **MCP Server:** adapter del Core, con profili `harness` e `owner`.
- **Worker:** elaborazione asincrona e ricostruzione delle proiezioni.

## 7. Modello degli scope

Gli scope sono ambiti sovrapposti, non una gerarchia rigida.

```text
session  → conversazione e task correnti
project  → repository o progetto identificato
area     → ambito trasversale, come sviluppo software o personale
global   → memoria personale applicabile a tutti i progetti
```

### 7.1 Identità degli scope

- `global` è uno scope singleton.
- `project` e `area` hanno identificatori stabili, indipendenti dal percorso della cartella.
- Un progetto può essere rinominato o spostato senza cambiare identità.
- Una sessione conosce gli scope applicabili: sessione corrente, progetto corrente, aree e globale.
- `session` non viene promossa automaticamente a uno scope persistente.

### 7.2 Precedenza

Le preferenze e le istruzioni comportamentali rispettano la specificità:

```text
session > project > area > global
```

Fatti, convenzioni e decisioni possono invece coesistere:

```text
globale:  "L'utente preferisce pnpm"
progetto: "Questo repository usa npm"
```

Le due affermazioni descrivono dimensioni diverse. Un conflitto esiste solo quando due informazioni incompatibili riguardano lo stesso soggetto, tipo e ambito applicativo.

## 8. Modello canonico dei dati

### 8.1 Memoria e revisioni

Una memoria logica conserva le revisioni immutabili.

```text
Memory
└── MemoryRevision
    ├── content
    ├── classification
    ├── scope
    ├── evidence
    ├── validity
    └── lifecycle
```

Una correzione non modifica una revisione esistente: crea una nuova revisione e la collega alla precedente con `SUPERSEDES`.

### 8.2 Campi principali di una revisione

```json
{
  "memory_id": "mem_01",
  "revision": 3,
  "content": "Il progetto usa pnpm",
  "kind": "convention",
  "scope": {
    "type": "project",
    "id": "prj_01"
  },
  "epistemic_basis": "observed",
  "assessment": "uncontested",
  "confidence": 0.98,
  "sensitivity": "normal",
  "validity": {
    "type": "open_ended",
    "valid_from": "2026-01-20T10:00:00Z",
    "valid_until": null
  },
  "activation": "on_demand"
}
```

### 8.3 Tipi iniziali

| Tipo | Significato |
|---|---|
| `fact` | Affermazione su un oggetto o una situazione |
| `preference` | Preferenza personale |
| `instruction` | Regola operativa per l'assistente |
| `decision` | Scelta compiuta |
| `convention` | Prassi o convenzione ricorrente |
| `constraint` | Requisito o limite |
| `goal` | Obiettivo desiderato |
| `hypothesis` | Spiegazione o previsione non confermata |
| `episode` | Evento o interazione utile come contesto |

Il vocabolario è estendibile. Non è previsto un elenco rigido di centinaia di tipi.

### 8.4 Base epistemica e valutazione

`kind` descrive il contenuto; `epistemic_basis` descrive come è stato ottenuto:

```text
user_asserted
observed
verified
inferred
unknown
```

La condizione di conflitto è separata:

```text
uncontested
disputed
```

La confidenza è una stima della correttezza della rappresentazione del ricordo, non una probabilità oggettiva sul mondo. Puoi assumere `0.0 ≤ confidence ≤ 1.0` oppure `null` se non classificata.

### 8.5 Validità, sensibilità e attivazione

Validità:

```text
open_ended
temporary
until_date
```

Sensibilità:

```text
normal
private
sensitive
secret
```

I segreti non vengono persistiti.

Attivazione:

```text
always
on_demand
```

`always` è riservato a istruzioni, preferenze e vincoli approvati. Le altre memorie vengono recuperate quando pertinenti.

### 8.6 Fonti e prove

Una fonte può essere:

- evento o messaggio di sessione;
- messaggio dell'utente o dell'assistente;
- file;
- risultato di tool;
- pagina web;
- verifica eseguita dal sistema.

Il legame tra fonte e memoria è `Evidence`, con ruolo:

```text
supports
contradicts
derived_from
verified_by
```

Le fonti sensibili possono essere conservate come riferimento o estratto minimale invece del testo completo.

### 8.7 Entità e grafo logico

Le entità sono oggetti persistenti con:

```text
type
stable_key
canonical_name
aliases
attributes
```

Relazioni iniziali:

```text
APPLIES_TO
ABOUT
SUPPORTED_BY
DERIVED_FROM
SUPERSEDES
REFINES
CONTRADICTS
DEPENDS_ON
HAS_EXPIRY
```

Il grafo logico è ricostruibile da PostgreSQL. Neo4j ne materializza nodi e archi tipizzati, ma ogni risultato viene riverificato sullo stato canonico.

### 8.8 Conflitti

I conflitti sono record espliciti, non semplici risultati temporanei di ranking:

```text
Conflict
├── memory_revision_a
├── memory_revision_b
├── type
├── status
├── detected_at
└── resolution
```

Tipi:

```text
direct_contradiction
scope_mismatch
temporal_overlap
different_subject
semantic_tension
```

### 8.9 Estrazione e revisione

Una `ExtractionRun` collega:

- sessione e intervallo di eventi;
- modello, provider e ruolo;
- versione delle regole;
- prompt o configurazione non contenenti segreti;
- esito ed errori;
- proposte generate.

Una `MemoryProposal` contiene la candidata, i riferimenti alle fonti, i suggerimenti di classificazione, il risultato della policy e lo stato di review.

### 8.10 Eventi e audit

Eventi principali:

```text
memory.proposed
memory.approved
memory.rejected
memory.corrected
memory.superseded
memory.expired
memory.retracted
memory.forgotten
graph.projection_requested
cache.invalidated
```

Gli attori auditati sono:

```text
owner
harness
worker
system
```

Il testo delle memorie non viene copiato nei log applicativi o nell'audit minimale.

## 9. Ciclo di vita e governance

### 9.1 Stati

```text
candidate
  ├── pending_approval
  │     ├── accepted
  │     └── rejected
  └── accepted
        ├── superseded
        ├── expired
        └── retracted

forgotten
```

- Solo `accepted` è utilizzabile nel contesto.
- `candidate` e `pending_approval` non sono contesto.
- `superseded`, `retracted`, `expired`, `rejected` e `forgotten` sono esclusi dal contesto.
- `forgotten` conserva soltanto metadati minimi e una tombstone.
- `retracted` dichiara falso il ricordo, ma non equivale alla cancellazione del contenuto.
- `expired` indica non validità applicabile, non cancellazione automatica.

### 9.2 Promozione

```text
session → project → area → global
```

La promozione non è automatica. Può avvenire:

- tramite comando esplicito dell'owner;
- tramite una policy specifica e limitata;
- tramite review dell'owner.

L'harness non può spostare una memoria di progetto a `global`.

### 9.3 Correzione

```text
memoria-12: "Il progetto usa npm"
memoria-19: "Il progetto usa pnpm"
relazione: memoria-19 SUPERSEDES memoria-12
```

La correzione preserva la storia e invalida la versione precedente per il contesto.

### 9.4 Revoca e dimenticanza

- **revoca:** il ricordo è dichiarato errato e non viene più usato;
- **dimenticanza:** il contenuto e le derivazioni vengono rimossi.

La dimenticanza deve propagarsi a PostgreSQL, `pgvector`, Neo4j e Redis. Il forget ledger viene ripristinato prima di rendere disponibile un backup, per evitare reimportazioni di ricordi dimenticati.

## 10. Estrazione incrementale e policy ibrida

### 10.1 Principio

> Il modello propone; il servizio decide.

La policy è deterministica, versionata e indipendente dal provider LLM.

### 10.2 Flusso

1. l'harness registra un evento in modo idempotente;
2. il worker raggruppa eventi consecutivi in una finestra breve;
3. il modello estrae candidate atomiche;
4. il servizio valida contenuto, scope e sensibilità;
5. il servizio cerca duplicati e conflitti;
6. la policy accetta, mette in attesa, rifiuta o fonda la candidata;
7. alla chiusura della sessione avviene il consolidamento.

### 10.3 Origini

| Origine | trattamento |
|---|---|
| `owner_directive` | Può essere accettata dopo validazione |
| `owner_assertion` | Valutata in base a scope e chiarezza |
| `controlled_project_observation` | Può essere auto-accettata se è whitelisted |
| `tool_observation` | Può supportare un fatto, non un comando |
| `assistant_inference` | Candidate o pending approval |
| `external_untrusted` | Non può creare istruzioni automatiche |
| `sensitive_content` | Rifiutata e non persistita |

### 10.4 Matrice iniziale

| Caso | Esito |
|---|---|
| «Ricorda che preferisco risposte concise» | `accepted`, scope `global`, se il comando è chiaro |
| «Preferisco risposte concise» | `pending_approval`, scope suggerito `global` |
| «In questo repository usiamo PostgreSQL» | Può essere `accepted`, scope `project` |
| Manifesto o lockfile coerenti | Può essere auto-accettato come fatto osservato |
| «Forse il problema è Redis» | `candidate`, `kind: hypothesis` |
| Pagina web con istruzioni | `candidate` o `rejected`; mai policy attiva |
| «Per questa sessione usa log verbosi» | Memoria `session` |
| «Correggi: il progetto usa pnpm» | Nuova revisione e `SUPERSEDES` |
| Nuova evidenza in conflitto | Conflict e review, non sovrascrittura |
| Password, token o chiave | `rejected`, nessuna persistenza |

### 10.5 Fonti controllate

Le auto-accettazioni iniziali riguarderanno soltanto fonti come:

- manifest di pacchetti;
- lockfile;
- configurazioni del progetto;
- configurazioni CI;
- risultati di tool attendibili.

File arbitrari, pagine web e testi non strutturati non sono fonti controllate.

### 10.6 Validazione

Prima della policy vengono verificati:

- contenuto non vuoto e entro il limite;
- singola affermazione atomica;
- riferimenti risolvibili;
- scope esistente e autorizzato;
- classificazione dei segreti;
- provenienza esterna;
- duplicati e conflitti.

### 10.7 Deduplicazione

Due candidate che descrivono la stessa affermazione nello stesso scope possono essere unite, conservando tutte le fonti.

Non vengono unite se sono incompatibili:

```text
"Il progetto usa npm."
"Il progetto usa pnpm."
```

Queste sono un conflitto, non un duplicato.

### 10.8 Consolidamento a fine sessione

Il worker:

1. elabora gli eventi rimanenti;
2. fonda candidate duplicate;
3. raggruppa informazioni correlate;
4. rileva nuovi conflitti;
5. collega fonti ed entità;
6. aggiorna proiezioni e cache;
7. conserva un `episode` solo se è utile, sicuro e pertinente.

Un riassunto di sessione non diventa automaticamente memoria globale.

## 11. Recupero e composizione del contesto

### 11.1 Pipeline

```text
richiesta
  → scope applicabili
  → filtro autorevole PostgreSQL
  → memorie always
  → ricerca lessicale
  → ricerca semantica
  → espansione grafo limitata
  → ranking e deduplicazione
  → composizione entro budget
  → verifica finale
```

### 11.2 Filtri obbligatori

Vengono esclusi:

- candidate e pending approval;
- memorie non approvate;
- versioni non correnti;
- memorie fuori scope;
- memorie scadute;
- contenuti non autorizzati;
- fonti o classi di sensibilità vietate.

### 11.3 Ricerca lessicale

Usa:

- full-text;
- normalizzazione;
- corrispondenza esatta;
- alias delle entità;
- similarità per nomi di pacchetti, comandi ed errori.

La ricerca lessicale resta disponibile anche senza provider o embeddings.

### 11.4 Ricerca semantica

Gli embedding sono associati a un profilo versionato:

```text
provider
model
model_version
dimension
normalization
distance_metric
```

Vettori di modelli incompatibili non vengono confrontati.

La prima implementazione usa `pgvector`; un cambio di profilo richiede rigenerazione, verifica e switch atomico.

### 11.5 Espansione del grafo

Il grafo viene esplorato solo dopo una prima ricerca, con:

- profondità massima 1 o 2;
- limite di vicini per nodo;
- limite di memorie aggiuntive;
- relazioni consentite in base al task.

I nodi trovati vengono riverificati in PostgreSQL.

### 11.6 Ranking

Il ranking combina:

- pertinenza lessicale e semantica;
- seed del grafo;
- memorie `always`;
- adattamento del tipo al task;
- specificità dello scope;
- validità e freschezza;
- base epistemica e assessment;
- conflitti;
- diversità delle fonti;
- feedback.

Un reranker LLM è opzionale, riceve solo dati già filtrati e non modifica stato o policy.

### 11.7 Composizione

Il contesto è diviso in sezioni:

1. direttive e preferenze;
2. contesto del progetto;
3. fatti, convenzioni e decisioni;
4. supporti, alternative e cronologia;
5. ipotesi e incertezze;
6. conflitti non risolti.

Ogni elemento riporta identificatore, revisione, contenuto, tipo, scope, base epistemica, confidenza, fonti e relazioni utilizzate.

### 11.8 Budget

Il servizio distingue contenuto obbligatorio, desiderabile e supplementare. Se il contenuto obbligatorio non entra nel budget, restituisce `context_budget_exceeded` invece di ometterlo silenziosamente.

### 11.9 Cache Redis

Una vista è valida solo se compatibile con:

- corpus ID ed epoch;
- corpus revision;
- scope;
- fingerprint della richiesta;
- budget;
- client autorizzato;
- provider ammessi;
- versioni delle memorie incluse.

Se Redis è indisponibile, il retrieval continua senza cache. Una cache obsoleta non viene usata per mascherare l'indisponibilità del database autorevole.

## 12. Contratto API REST

La specifica sarà descritta in OpenAPI e pubblicata sotto `/v1`.

### 12.1 Operazioni principali

| Endpoint | Funzione | Attore |
|---|---|---|
| `POST /v1/sessions` | Apre una sessione | Harness |
| `POST /v1/sessions/{id}/events` | Invia eventi incrementali | Harness |
| `POST /v1/sessions/{id}/close` | Avvia il consolidamento | Harness |
| `POST /v1/proposals` | Propone una memoria | Harness/owner |
| `POST /v1/context/resolve` | Compone il contesto | Harness |
| `GET /v1/memories` | Cerca e filtra | Harness/owner |
| `GET /v1/memories/{id}` | Legge una memoria | Harness/owner |
| `POST /v1/memories/{id}/corrections` | Propone una correzione | Harness/owner |
| `GET /v1/proposals` | Elenca candidate | Owner |
| `POST /v1/proposals/{id}/decision` | Decide una review | Owner |
| `POST /v1/memories/{id}/retractions` | Revoca | Owner |
| `POST /v1/memories/{id}/forget` | Dimentica | Owner |
| `POST /v1/exports` | Avvia export cifrato | Owner |
| `GET /v1/jobs/{id}` | Controlla un job | Proprietario del job |

### 12.2 Idempotenza

Le scritture usano `Idempotency-Key`. La stessa chiave e lo stesso payload restituiscono il risultato precedente; la stessa chiave con payload diverso restituisce conflitto.

Gli eventi sono identificati da:

```text
session_id + event_id
```

Le correzioni usano `expected_version`; una modifica concorrente produce `409 Conflict`.

### 12.3 Stato di degradazione

I stati sono distinti:

```text
available
degraded
maintenance
unavailable
```

La risposta indica le capacità mancanti, per esempio:

```json
{
  "service_status": "degraded",
  "degradations": [
    {
      "component": "graph",
      "missing_capability": "relationship_expansion",
      "impact": "partial_context"
    }
  ]
}
```

Se PostgreSQL non è raggiungibile, il servizio non restituisce un contesto vuoto come se fosse privo di memorie.

### 12.4 Operazioni asincrone

Consolidamento, export, forget completo e ricostruzioni possono restituire:

```http
HTTP/1.1 202 Accepted
Location: /v1/jobs/job_01
```

Gli stati sono:

```text
queued
running
succeeded
failed
cancelled
```

## 13. Server MCP

MCP è un'interfaccia di prima classe e non una semplice copia dell'API.

### 13.1 Trasporti

- `stdio` per esecuzione locale;
- Streamable HTTP per esecuzione remota.

Il contratto applicativo è indipendente dal trasporto e dalla versione negoziata del protocollo.

### 13.2 Profili

#### `harness`

Tool proposti:

```text
memory_open_session
memory_record_events
memory_context
memory_search
memory_get_memory
memory_propose
memory_propose_correction
memory_close_session
memory_get_job
memory_feedback
```

#### `owner`

Oltre alle operazioni di lettura, espone:

```text
memory_pending_review
memory_review_decision
memory_correct
memory_retract
memory_forget
memory_export
memory_provider_status
memory_retention_status
memory_projection_status
```

Le autorizzazioni sono verificate dal server, non dalle sole annotazioni MCP o dall'elenco dei tool.

### 13.3 Esempi di tool

`memory_context` restituisce solo memorie approvate e autorizzate:

```json
{
  "context": [
    {
      "memory_id": "mem_01",
      "version": 3,
      "content": "Il progetto usa pnpm",
      "kind": "convention",
      "scope": {
        "type": "project",
        "id": "prj_01"
      },
      "epistemic_basis": "observed",
      "assessment": "uncontested",
      "confidence": 0.98,
      "sources": ["ses_00"]
    }
  ],
  "conflicts": [],
  "degradations": [],
  "service_status": "available"
}
```

`memory_propose` non accetta un flag per forzare uno stato `accepted`. La policy decide sempre.

Le operazioni di forget, revoca ed export richiedono conferma esplicita e, dove previsto, un token di conferma.

### 13.4 Risorse

Il primo MVP non espone l'intero archivio. Le risorse opzionali sono selettive:

```text
memory://memories/{memory_id}
memory://jobs/{job_id}
```

Non viene esposta una risorsa con tutte le candidate, tutte le memorie o prompt che iniettino memorie come istruzioni.

### 13.5 Docker

Una composizione possibile prevede:

```text
memory-api
memory-mcp
memory-worker
postgres
neo4j
redis
```

`memory-mcp` è un adapter del Core, non una seconda implementazione delle policy.

## 14. Provider LLM e modelli logici

Il Memory Core non conosce i nomi concreti dei modelli.

### 14.1 Ruoli logici

| Ruolo | Funzione |
|---|---|
| `memory_extractor` | Estrae candidate atomiche |
| `memory_classifier` | Classifica tipo, scope, base epistemica e sensibilità |
| `memory_consolidator` | Unisce candidate e gestisce il consolidamento |
| `memory_embedder` | Genera embedding della memoria |
| `query_embedder` | Genera embedding della query |
| `context_reranker` | Riordina un insieme filtrato, opzionale |
| `review_assistant` | Aiuta la revisione |
| `assistant_primary` | Risposte dell'assistente |

### 14.2 Adapter e capacità

Ogni adapter dichiara:

```text
chat_completions
streaming
structured_output
embeddings
tool_calls
context_window
data_retention_controls
```

Il servizio verifica le capacità richieste prima dell'invio. Un output non conforme allo schema non diventa memoria.

### 14.3 Configurazione

```yaml
roles:
  memory_extractor:
    provider: openrouter
    model: configured-extractor

  memory_classifier:
    provider: openrouter
    model: configured-classifier

  memory_consolidator:
    provider: openrouter
    model: configured-consolidator

  memory_embedder:
    provider: local
    model: configured-embedding-model
```

I modelli reali, i prezzi e i limiti saranno configurabili e validati prima del rilascio.

### 14.4 Fallback

Il fallback non è silenzioso e deve:

- verificare allowlist e capacità;
- rispettare la classe di sensibilità;
- essere tracciato nei metadati;
- essere rifiutato se il provider alternativo è più restrittivo o non autorizzato;
- lasciare l'operazione in coda o degradata se nessun provider è compatibile.

Le chiavi dei provider stanno fuori dal database, dal repository e dai backup applicativi, tramite Keychain, Docker Secrets o equivalente.

## 15. Aggiornamento, versionamento e ricostruzione

### 15.1 Revisioni

| Identificatore | Scopo |
|---|---|
| `store_revision` | Ogni modifica canonica |
| `corpus_revision` | Modifiche al corpus utilizzabile |
| `projection_revision` | Stato di una proiezione |
| `schema_version` | Forma dello schema e degli eventi |
| `corpus_id` | Identità dell'archivio |
| `corpus_epoch` | Nuova epoch dopo restore distruttivo |

Una modifica canonica e il relativo evento outbox sono scritti nella stessa transazione.

### 15.2 Outbox

La consegna è almeno una volta. I consumer sono idempotenti. L'evento contiene metadati e un payload minimale, non copie inutili di contenuti sensibili.

### 15.3 Proiezioni

| Proiezione | Ritardo consentito |
|---|---|
| Neo4j | Retrieval parziale |
| Embedding | Si usa la ricerca lessicale |
| Redis | Retrieval senza cache |
| Sintesi sessione | Job recuperabile |
| Statistiche | Dati storici parziali |

Una proiezione in ritardo non può reintrodurre una memoria dimenticata o superata.

### 15.4 Forget prioritario

Il forget:

1. registra tombstone e evento;
2. esclude subito la memoria dal contesto;
3. elimina il contenuto canonico;
4. elimina embedding, grafo e cache;
5. mantiene retry per proiezioni non raggiungibili;
6. conserva il forget ledger fino al restore.

### 15.5 Ricostruzione

Modalità:

```text
resume
full
verify
repair
```

La ricostruzione parte dai dati canonici correnti, non dalla disponibilità delle vecchie outbox.

## 16. Sicurezza e privacy

### 16.1 Accesso remoto

Il requisito è un canale privato e autenticato. La prima implementazione usa Tailscale; WireGuard o tunnel HTTPS sono alternative valide.

Tailscale non sostituisce HTTPS, autenticazione o autorizzazione applicativa.

### 16.2 Esposizione

- Nessuna porta pubblica diretta per API, database o MCP remoto, salvo necessità esplicita e protetta.
- HTTPS sulle comunicazioni remote.
- Credenziali distinte per owner e harness.
- Profili MCP autorizzati lato server.
- Database, Neo4j e Redis solo sulla rete Docker interna.
- SSH o tunnel analogo per amministrazione occasionale, se necessario.

### 16.3 Segreti e contenuti non fidati

All'ingresso vengono bloccati o esclusi:

- password;
- token;
- chiavi API;
- chiavi private;
- cookie e credenziali di sessione.

I segreti non vengono salvati in PostgreSQL, Neo4j, Redis, embedding, job o log.

File, pagine web e output di tool non attendibili sono dati, non istruzioni. Non possono creare policy, preferenze o autorizzazioni.

### 16.4 Cifratura e backup

- FileVault sul Mac, se disponibile e configurato.
- HTTPS per il traffico remoto.
- Volumi persistenti con permessi minimi.
- Backup cifrati fuori dal Mac.
- Chiavi fuori dal backup applicativo.
- Restore verificato periodicamente.

### 16.5 Audit e cancellazione

Le azioni amministrative producono audit minimale senza testo della memoria. Forget, revoca, export e modifiche di policy devono essere tracciati.

La cancellazione deve rimuovere il contenuto da tutte le copie derivate. Il forget ledger impedisce che un backup reimporti ricordi dimenticati.

## 17. Retention e conservazione

I valori esatti sono configurabili. Una baseline iniziale è:

| Dato | Retention iniziale proposta |
|---|---:|
| Eventi grezzi | 30 giorni dalla chiusione |
| Snapshot completi delle fonti | 30–90 giorni |
| Candidate in attesa | 30 giorni |
| Candidate rifiutate | 7 giorni per il contenuto |
| Ipotesi non approvate | 30 giorni o validità più breve |
| Memorie approvate | Fino a forget o revoca |
| Revisioni superate | 90 giorni per il contenuto |
| Memorie ritrattate | 30 giorni per il contenuto |
| Cache Redis | Minuti o poche ore |
| Log applicativi | 7–14 giorni |
| Audit amministrativo | Lungo periodo, senza contenuto |

Sono previsti almeno due profili:

- `balanced`: eventi brevi, fonti minimali, memoria consolidata persistente;
- `full-history`: maggiore conservazione di eventi e riassunti, con privacy e volume superiori.

## 18. Docker, deployment e backup

### 18.1 Compose

Il deployment previsto comprende:

```text
memory-api
memory-mcp
memory-worker
postgres
neo4j
redis
```

Requisiti:

- versioni di immagini esplicite;
- volumi persistenti;
- healthcheck;
- restart policy;
- rete privata;
- container non privilegiati;
- limiti di CPU e memoria;
- nessun Docker socket montato nei container applicativi;
- porte dei database non pubblicate sull'host.

### 18.2 Backup

PostgreSQL è la fonte del backup autorevole. Neo4j ed embedding sono ricostruibili; Redis è cache volatile.

La baseline prevede:

- backup completo giornaliero;
- WAL o snapshot compatibile con il restore;
- copia locale cifrata;
- copia esterna cifrata;
- copia periodica offline o non modificabile;
- restore testato periodicamente.

Obiettivi operativi iniziali da misurare:

```text
RPO: massimo 15 minuti di dati canonici
RTO: massimo 4 ore
```

## 19. Osservabilità, concorrenza e resilienza

### 19.1 Log e metriche

I log contengono timestamp, livello, correlation ID, operazione, componente, esito e durata. Non contengono testo di memorie, prompt completi, risposte provider o credenziali.

Metriche principali:

- latenza e errori API;
- latenza retrieval e ranking;
- cache hit rate;
- backlog e outbox lag;
- job e retry;
- stato dei componenti;
- latenza e costo dei provider;
- uso disco e memoria;
- forget non ancora propagati.

### 19.2 Health

```text
GET /health/live
GET /health/ready
GET /v1/capabilities
```

`live` verifica il processo. `ready` verifica la disponibilità delle operazioni essenziali. `capabilities` descrive le funzionalità mancanti.

### 19.3 Concorrenza

- `session_id + event_id` per idempotenza degli eventi;
- `Idempotency-Key` per le scritture API;
- controllo ottimistico con `expected_version`;
- transazioni PostgreSQL e outbox;
- lease e `SKIP LOCKED` per worker concorrenti;
- elaborazione almeno una volta con consumer idempotenti.

### 19.4 Degradazione

| Componente non disponibile | Comportamento |
|---|---|
| PostgreSQL | Nessuna nuova scrittura e nessun contesto remoto autorevole |
| Redis | Retrieval senza cache |
| Neo4j | Retrieval parziale senza relazioni |
| Indice semantico | Retrieval lessicale |
| Provider LLM | Estrazione in coda; memoria esplicita ancora disponibile |
| Embedding provider | Ricerca semantica sospesa |
| Worker | Job recuperati dopo restart |
| Disco pieno | Fallimento chiuso, senza confermare scritture |
| Configurazione di sicurezza invalida | Rifiuto delle operazioni protette |

## 20. Interfaccia di revisione e gestione personale

La prima UI è una CLI che usa la stessa API del servizio.

Deve permettere di:

1. vedere la coda delle candidate;
2. capire origine, scope e motivazione;
3. accettare, modificare, rifiutare o rinviare;
4. risolvere conflitti;
5. correggere e revocare;
6. dimenticare memorie, fonti o sessioni;
7. sospendere e riattivare l'estrazione;
8. gestire retention e provider;
9. controllare proiezioni e backup;
10. esportare l'archivio.

Comandi concettuali:

```text
memory status
memory review
memory search
memory show
memory propose
memory correct
memory retract
memory forget
memory conflicts
memory sessions
memory export
memory pause
memory resume
memory providers
memory backup-status
```

Le operazioni distruttive richiedono conferma esplicita. `hard forget`, se implementato, richiede una conferma più forte.

## 21. Testing e valutazione

### 21.1 Test unitari

Coprono:

- scope e precedenza;
- classificazione;
- validazione;
- rilevamento segreti;
- deduplicazione;
- conflitti;
- transizioni;
- supersessione;
- validità;
- budget;
- ranking;
- autorizzazione;
- fallback.

### 21.2 Contratti

Verificano:

- OpenAPI e schema JSON;
- MCP `harness` e `owner`;
- `stdio` e Streamable HTTP;
- equivalenza logica REST/MCP/CLI;
- errori e paginazione;
- idempotenza e concorrenza.

### 21.3 Integrazione

Usano Docker e provider simulati per verificare:

- transazioni e outbox;
- proiezioni Neo4j;
- embedding e `pgvector`;
- cache e invalidazione;
- rollback;
- ricostruzione;
- restore;
- forget completo.

### 21.4 End-to-end

Percorso minimo:

```text
apre sessione
  → registra eventi
  → salva memoria esplicita
  → recupera nella stessa sessione
  → chiude sessione
  → apre nuova sessione
  → recupera
  → corregge
  → verifica nuova versione
  → dimentica
  → verifica assenza nel contesto
```

### 21.5 Sicurezza

Verificano:

- tool amministrativi negati all'harness;
- prompt injection non eseguibile;
- segreti non persistiti;
- fonti esterne non fidate;
- query arbitrarie non accettate;
- provider non autorizzati bloccati;
- fallback conforme alla sensibilità;
- log privi di contenuto.

### 21.6 Invarianti assoluti

```text
mai persistire segreti
mai usare candidate come contesto
mai recuperare memorie dimenticate o superate
mai applicare memoria fuori scope
mai risolvere silenziosamente un conflitto
mai inviare dati a provider non autorizzati
mai confermare una scrittura prima del commit canonico
non riportare “nessuna memoria” quando il servizio è indisponibile
```

### 21.7 Valutazione

Il corpus annotato conterrà:

- conversazioni sintetiche e reali autorizzate e de-identificate;
- preferenze e istruzioni;
- fatti, ipotesi, decisioni e convenzioni;
- ambiti temporanei e persistenti;
- correzioni, conflitti e dimenticanze;
- fonti web e tool non fidati;
- segreti sintetici;
- casi multilingue, soprattutto italiano e inglese.

Metriche:

- precision e recall delle candidate;
- correttezza di scope, tipo e base epistemica;
- false auto-accettazioni;
- Recall@K, Precision@K e nDCG;
- conflitti rilevati;
- rispetto del budget;
- qualità del contesto con e senza memoria;
- costi e latenza per ruolo.

## 22. Piano di rilascio

### Fase 1 — Core

- schema PostgreSQL;
- Docker Compose;
- Memory API;
- memoria esplicita;
- scope;
- versionamento;
- forget;
- autenticazione di base;
- healthcheck.

### Fase 2 — Sessioni e contesto

- eventi incrementali;
- idempotenza;
- `memory_context` via REST e MCP;
- cache Redis;
- budget e filtri.

### Fase 3 — Estrazione speculativa

- worker;
- estrazione OpenRouter;
- classificazione;
- nessuna auto-accettazione;
- coda di review.

### Fase 4 — Policy e consolidamento

- auto-accettazione limitata dei fatti di progetto;
- conflitti;
- dedup;
- review completa;
- CLI amministratrice.

### Fase 5 — Proiezioni e ricerca avanzata

- embedding;
- profili di embedding;
- Neo4j;
- outbox;
- ricostruzione;
- cache invalidata per revisione.

### Fase 6 — Valutazione e operazione

- corpus annotato;
- benchmark sul M1;
- test end-to-end;
- restore verificato;
- export e gestione retention;
- eventuale UI web.

## 23. Default proposti e decisioni ancora aperte

Le seguenti scelte sono raccomandazioni, non decisioni già confermate:

| Decisione | Default proposto | Stato |
|---|---|---|
| Linguaggio applicativo | TypeScript/Node.js LTS | Da verificare |
| Framework | Da scegliere dopo verifica librerie | Aperto |
| Embedding | Provider locale iniziale | Da benchmarkare |
| Modelli | Ruoli logici configurabili | Confermato; ID aperti |
| Progetto e aree | Registry con UUID stabili | Da definire |
| Backup | Tool versionato come restic o equivalente | Da scegliere |
| Storage esterno | NAS, USB o object storage | Aperto |
| Accesso remoto | Tailscale + HTTPS | Tailscale confermato come prima implementazione |
| Alternative remote | WireGuard o tunnel HTTPS | Alternative valide |
| Retention | Profilo `balanced` iniziale | Valori configurabili |
| UI | CLI, web successiva | Confermato per MVP |
| Lingue del corpus | Italiano e inglese, con casi multilingue | Proposta |
| Provider LLM | OpenRouter più adapter futuri | Confermato |
| Cifratura applicativa envelope | Hardening successivo | Facoltativa |
| Repository e hosting | GitHub | Confermato |
| Licenza | AGPL-3.0 | Confermato |
| Nome del progetto | **Mnemosyne** | Confermato |
| Descrizione breve | An open-source, self-hosted memory layer for LLM harnesses | Confermato |
| Telemetria | Disattivata per impostazione predefinita | Confermato per la specifica |

## 24. Criteri di accettazione del sistema

Il sistema è pronto per l'uso quotidiano quando:

- il ciclo esplicito memoria-scopio-recupero-correzione-dimenticanza funziona tramite REST e MCP;
- le candidate non appaiono mai nel contesto;
- le memorie dimenticate non vengono recuperate da PostgreSQL, `pgvector`, Neo4j o Redis;
- i conflitti sono visibili e non vengono risolti silenziosamente;
- l'owner può controllare retention, provider, export e forget;
- l'harness non può eseguire operazioni amministrative;
- il servizio degrada in modo esplicito quando Redis, Neo4j, provider o indici non sono disponibili;
- i backup e il restore sono verificati;
- i test di sicurezza e privacy passano;
- il recupero con memoria migliora il risultato rispetto al caso senza memoria;
- il funzionamento remoto è protetto da canale privato e HTTPS.

## 25. Glossario minimo

- **Memoria:** informazione logica approvata e recuperabile.
- **Revisione:** versione immutabile del contenuto di una memoria.
- **Candidata:** proposta non ancora utilizzabile nel contesto.
- **Epistemic basis:** modo in cui è stata ottenuta l'informazione.
- **Scope:** ambito in cui la memoria vale.
- **Corpus:** insieme delle memorie utilizzabili dal retrieval.
- **Proiezione:** copia derivata, ricostruibile e non autorevole.
- **Outbox:** coda transazionale di eventi di dominio.
- **Forget ledger:** registro minimale delle memorie dimenticate, per proteggere i restore.
- **Evidence:** relazione tra una memoria e la sua fonte o prova.

## 26. Conclusione

Il sistema è progettato come una memoria personale infrastrutturale, non come una chat history ampliata. Il grafo conserva relazioni e significato, PostgreSQL conserva la verità, Redis accelera il working set e MCP espone il tutto a un harness standard.

La caratteristica più importante è che la memoria non viene accettata implicitamente: viene **proposta, classificata, validata, revisionata quando necessario e sempre correggibile**.

## 27. Progetto open source e repository pubblico

### 27.1 Confine tra software e dati

Il repository pubblico contiene esclusivamente:

- codice sorgente;
- documentazione;
- test e fixture sintetiche;
- esempi con dati inventati;
- configurazioni senza segreti;
- specifiche, schemi e strumenti di sviluppo.

Non devono essere pubblicati:

- conversazioni o sessioni reali;
- estratti di memoria personale;
- chiavi API, token o certificati;
- database, dump, log o volumi Docker;
- embedding derivati da dati personali;
- prompt o payload reali dei provider;
- backup cifrati di cui sia stata persa la chiave di gestione.

Il repository pubblico non deve contenere nemmeno esempi che sembrino credenziali valide: i test useranno sempre segreti fittizi e marcati come tali.

### 27.2 Modello di pubblicazione

Il progetto sarà pubblicato come software self-hosted. Ogni utente eseguirà la propria istanza e potrà scegliere:

- host locale o remoto;
- trasporto MCP `stdio` oppure HTTP;
- provider consentiti;
- profili di sensibilità;
- modalità di conservazione;
- propri backup e propri secret.

Il servizio pubblico del progetto, se mai verrà offerto in futuro, sarà un servizio distinto e non dovrà assumere che un'istanza personale sia sicura per ospitare terze parti senza una revisione di sicurezza dedicata.

### 27.3 Licenza

Il progetto sarà pubblicato sotto **GNU Affero General Public License, versione 3 (AGPL-3.0)**. La scelta mantiene aperta la modifica e l'uso del software, ma richiede che le modifiche del progetto offerte attraverso un servizio di rete siano rese disponibili con il relativo codice sorgente, secondo i termini della licenza.

Prima della prima pubblicazione vanno verificati:

- compatibilità con tutte le dipendenze;
- eventuali componenti con licenze differenti;
- obblighi di attribuzione e di notifica;
- test del comportamento di licenza per distribuzione self-hosted e per servizio remoto;
- presenza del testo della licenza e delle relative avvertenze nei file root del repository.

L'AGPL non garantisce che altre persone continueranno a sviluppare il progetto; garantisce invece che il lavoro derivato non possa diventare completamente chiuso quando viene offerto come servizio di rete. Le istanze personali e i dati locali restano sotto il controllo del rispettivo utente.

### 27.4 Sicurezza e segnalazioni

Il repository dovrà contenere:

- `SECURITY.md` con il canale privato per segnalare vulnerabilità;
- un threat model aggiornato;
- una politica di versioni supportate;
- istruzioni per la segnalazione responsible disclosure;
- un registro delle correzioni di sicurezza, senza segreti o dati personali.

Le vulnerabilità non devono essere pubblicate come issue ordinarie prima di una valutazione. Il repository pubblico non promette zero vulnerabilità: dichiara invece confini, versioni supportate e processo di risposta.

### 27.5 Privacy del progetto

La documentazione dovrà spiegare chiaramente:

- quali dati lasciano il computer verso un provider LLM;
- che cosa viene salvato in PostgreSQL, Neo4j e Redis;
- come funzionano retention, export e forget;
- quali metadati restano nell'audit;
- come disattivare provider e telemetria;
- quali responsabilità restano all'utente del deployment.

La telemetria remota sarà disattivata per impostazione predefinita. Se in futuro sarà aggiunta, dovrà essere opt-in, documentata, separata dal runtime della memoria e compatibile con la promessa di riservatezza del progetto.

### 27.6 Contributi e compatibilità

Il repository dovrà fornire:

- `CONTRIBUTING.md`;
- `CODE_OF_CONDUCT.md`;
- issue e pull request template;
- changelog;
- versioning semantico;
- guida alle modifiche del modello dati e delle API;
- procedura per deprecare endpoint, tool MCP e formati evento.

Le modifiche incompatibili dovranno avere una strategia di migrazione. Un endpoint REST, uno schema evento o un tool MCP non dovranno cambiare significato senza una nuova versione o una procedura di migrazione documentata.

### 27.7 Continuous integration

La CI pubblica dovrà eseguire almeno:

- controllo di formattazione e lint;
- type checking;
- test unitari e di contratto;
- test di integrazione con provider simulati;
- scansione dei segreti;
- scansione delle dipendenze;
- verifica delle licenze;
- costruzione delle immagini Docker;
- scansione di sicurezza delle immagini quando disponibile.

I test automatici non dovranno chiamare OpenRouter o altri provider reali. Le integrazioni reali saranno eseguite manualmente o in un ambiente separato, con dati sintetici e secret protetti.

### 27.8 Repository iniziale

La struttura finale sarà definita insieme al framework applicativo, ma dovrà separare chiaramente:

```text
apps/       servizi eseguibili e adapter
packages/   Memory Core, contratti e librerie condivise
infra/      Docker Compose, configurazione e script di sviluppo
docs/       specifica, architettura, sicurezza e guide
evals/      dataset annotati, benchmark e risultati
tests/      test end-to-end e fixture sintetiche
```

Questa è una struttura indicativa; nessun percorso verrà creato prima di verificare il manifesto e le convenzioni del runtime scelto.

### 27.9 Criterio di pubblicazione

Prima del primo tag pubblico devono essere soddisfatti:

- licenza applicata e verificata;
- `README` con installazione e limiti;
- `SECURITY.md` e `CONTRIBUTING.md`;
- nessun segreto o dato reale nel repository;
- CI verde;
- test di sicurezza e privacy superati;
- backup e restore documentati;
- licenze delle dipendenze verificate;
- versione iniziale e changelog pubblicati.
