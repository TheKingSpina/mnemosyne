# Mnemosyne V2 — Architecture & Operations Reference Manual

**Mnemosyne** è un server di memoria persistente e governata per agenti e harness LLM (Large Language Model), progettato per operare ad alte prestazioni, con minime risorse computazionali e nel rispetto rigoroso della privacy locale.

Il presente documento descrive l'architettura consolidata, i modelli operativi, le strategie di gestione dei conflitti e delle ridondanze, nonché le procedure di esercizio e deployment per **Apple Silicon M1/M3 (macOS + OrbStack + Tailscale)**.

---

## 1. Architettura di Sistema a Livelli

Mnemosyne adotta un'architettura **CQRS / Hexagonal Core** in cui la fonte di verità canonica (_Source of Truth_) risiede su **PostgreSQL 17**, mentre proiezioni specializzate e modelli on-demand garantiscono retrieval istantaneo e integrità semantica.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        CLIENTI & AGENTI LLM                            │
│           (OpenCode, Claude Code, Cursor, Antigravity, REST)           │
└───────────────────┬────────────────────────────────┬───────────────────┘
                    │                                │
            (MCP Privato via TS)                 (Dashboard Web)
                    │                                │
                    ▼                                ▼
       ┌────────────────────────┐      ┌────────────────────────┐
       │   Mnemosyne MCP App    │      │   Mnemosyne Web App    │
       │     (Porta 3333)       │      │     (Porta 18080)      │
       └────────────┬───────────┘      └────────────┬───────────┘
                    │                               │
                    └───────────────┬───────────────┘
                                    │
                                    ▼
       ┌────────────────────────────────────────────────────────┐
       │                   Mnemosyne API Core                   │
       │                      (Porta 3000)                      │
       └───────┬────────────────────┬────────────────────┬──────┘
               │                    │                    │
     (Transazioni Atomiche)   (Cache In-Memory)   (Embedding HNSW)
               │                    │                    │
               ▼                    ▼                    ▼
     ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
     │  PostgreSQL 17   │ │    Redis 7.4     │ │ pgvector (IVF)   │
     │  (Canonica SoT)  │ │ (Corpus Cache L1)│ │(Semantic Search) │
     └─────────┬────────┘ └──────────────────┘ └──────────────────┘
               │
          (Outbox CDC)
               │
               ▼
     ┌───────────────────────────────────────┐
     │           Extraction Worker           │
     │    (Sincronizzazione & Proiezioni)    │
     └─────────┬─────────────────────────────┘
               │
     (Protocollo Bolt)
               │
               ▼
     ┌────────────────────────────────────────────────────────┐
     │                  Memgraph (C++ Engine)                 │
     │         (Porta 7687 · Footprint RAM: ~50-80 MB)         │
     │     • Nodi: Project, Area, Memory                      │
     │     • Archi: IN_PROJECT, IN_AREA, LINK, CONFLICTS      │
     └────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│               HOST LLAMA.CPP LAZY ACTIVATION MANAGER                   │
│                    (ops/host/llama-lazy-manager.mjs)                   │
│                                                                        │
│   • Porta 8082: BGE Reranker v2 M3 (Anti-ridondanza simmetrica)        │
│   • Porta 8081: Gemma 3 4B Instruct (Giudice semantico e potatura)     │
│   • Modalità Idle: 0 MB RAM/VRAM occupati a riposo                     │
│   • Risveglio On-Demand: Invocazione via GPU Metal in ~1.5 secondi     │
│   • Auto-spegnimento: Rilascio totale delle risorse dopo 5 min idle    │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Il Grafo di Conoscenza a Due Livelli (V2 Graph Model)

La versione 2 supera il vecchio modello a scope piatto (`project:nome` o `global`) introducendo una gerarchia di appartenenza deterministica:

### 2.1 Entità Fondamentali

1. **`Project` (Radice del Grafo)**:
   - Ogni memoria appartiene in modo **immutabile** a un unico progetto (`memories.project_id`).
   - La modifica del `project_id` di una memoria esistente è vietata a livello di trigger PostgreSQL (`trg_memoria_progetto_immutabile`).
   - Il namespace speciale `personal` funge da contenitore universale per memorie trasversali a tutte le sessioni.
2. **`Area` (Sottografo tematico opzionale)**:
   - Sottosezione esplicita all'interno di un progetto (relazione `[:PART_OF]->(:Project)`).
   - Una memoria può opzionalmente essere collegata a un'area (`[:IN_AREA]`).
3. **`Memory` & `MemoryRevision`**:
   - Istanze immutabili e versionate (`version: 1, 2, ...`).
   - Ciascuna revisione porta stato epistemico, assessment (`uncontested` o `disputed`), livello di confidenza e vettore di embedding.

### 2.2 Sostituzione di Neo4j con Memgraph (C++)

Neo4j (JVM Java) è stato rimosso in favore di **Memgraph**, un database a grafo ad altissime prestazioni scritto in **C++ nativo**:

- **Consumo RAM**: crollato da **~600 MiB a soli ~50-80 MiB** (-90% di footprint).
- **Compatibilità**: implementa nativamente il protocollo Bolt e Cypher, dialogando in modo trasparente con `neo4j-driver`.
- **Latenza di Graph Traversal**: **0.35 ms** in mediana (p50) per attraversamenti multi-hop.

---

## 3. Rilevamento Conflitti e Gestione delle Dispute

Mnemosyne adotta un approccio rigido e difensivo per impedire che memorie contraddittorie inquinino il contesto dell'agente LLM.

### 3.1 Rilevatore Deterministico Universale vs Qualificato

Il rilevatore analizza le memorie proposte verificando la polarità e la qualificazione grammaticale:

- **Asserzioni Qualificate**: es. _"Per i nuovi progetti usiamo pnpm"_.
- **Negazioni Universali**: es. _"Non usiamo pnpm"_.
- **Regola di Conflitto**: Il detector riconosce che una negazione categorica annulla qualsiasi qualificazione contestuale dello stesso predicato, sollevando un record formale di conflitto (`direct_contradiction`).

### 3.2 In-Band Disputed Marking & Quarantine Policy

1. **Marcatura in-band (`assessment: 'disputed'`)**:
   - Sia in fase di ricerca (`searchMemories`) che di risoluzione del contesto (`resolveContext`), se una memoria è coinvolta in un conflitto attivo non risolto, il suo assessment viene dinamicamente arricchito come `'disputed'`.
2. **Politica di Quarantena (`conflictPolicy`)**:
   - `include_disputed` (default): le memorie contestate vengono incluse ma marchiate esplicitamente.
   - `quarantine_conflicts`: entrambe le memorie in conflitto vengono **escluse fisicamente dal prompt**, impedendo all'LLM di ricevere istruzioni contraddittorie.
3. **Formattatore di Prompt ([`formatContextForPrompt`](file:///Users/spina/Mnemosyne/packages/core/src/format-context.ts))**:
   - Pre-elabora i blocchi di testo per l'LLM anteponendo un avviso esplicito:
     ```text
     [DISPUTED / CONTRADICTS mem_abc123] Per i nuovi progetti usiamo pnpm
     ```

---

## 4. Pipeline di Potatura Semantica e Lazy Activation

La manutenzione del database a lungo termine è affidata a due micro-modelli gestiti a chiamata:

### 4.1 BGE Reranker v2 M3 (`POST :8082/v1/rerank`)

- **Scudo Anti-Ridondanza**: analizza la similarità simmetrica incrociata fra la nuova memoria e le candidate nel DB.
- Se lo score di rilevanza supera la soglia di calibrazione, la proposta viene rigettata come duplicato semantico, evitando di accumulare parafrasi inutili.

### 4.2 Gemma 3 4B Instruct (`POST :8081/v1/chat/completions`)

- **Giudice Semantico Vincolato**: invocato nei casi ambigui o di aggiornamento temporale.
- Grazie al vincolo grammaticale **JSON-Schema token-level** di `llama-server`, produce output strutturati garantiti al 100% senza allucinazioni di sintassi (`verdict: 'redundant' | 'contradictory' | 'compatible'`).

### 4.3 Host Lazy Manager ([`ops/host/llama-lazy-manager.mjs`](file:///Users/spina/Mnemosyne/ops/host/llama-lazy-manager.mjs))

- Daemon host leggerissimo (~15 MB di RAM) registrato come LaunchAgent macOS (`com.mnemosyne.llama.plist`).
- Risponde passivamente alle verifiche di salute `/health` senza risvegliare i modelli.
- All'arrivo di una richiesta, avvia `llama-server` via Metal in **1.5 secondi**.
- Dopo 5 minuti di inattività (`LLAMA_IDLE_TIMEOUT_SECONDS=300`), termina il processo liberando **3 GB di memoria RAM/VRAM**.

---

## 5. Rete e Sicurezza con Private Tailscale Serve

Mnemosyne è configurato per il deployment privato su Mac mini tramite Tailscale:

- **Nessun Funnel Pubblico**: I servizi non sono mai esposti su Internet aperta.
- **Dashboard Web**: Pubblicata su loopback sicuro:
  ```text
  https://mac-mini-di-alessandro-2.tail82e37f.ts.net/ (tailnet only) -> http://127.0.0.1:18080
  ```
- **Endpoint MCP Remoto**:
  ```text
  https://mac-mini-di-alessandro-2.tail82e37f.ts.net:8443/mcp (tailnet only) -> http://127.0.0.1:3333
  ```
  - Autenticazione con profilo anonimo ristretto (`harness`), dove i comandi distruttivi (`forget`, `export`, `admin`) sono fisicamente rimossi dal catalogo dei tool.
  - DNS rebinding protection vincolata all'host Tailscale.

---

## 6. Metriche di Esercizio e Benchmark Convalidati

| Metrica / Componente                  | Risultato Misurato        | Note                                                     |
| :------------------------------------ | :------------------------ | :------------------------------------------------------- |
| **RAM Stack Docker (Totale)**         | **~245 MiB**              | Con Memgraph C++, Postgres, Redis, API, Worker, Web, MCP |
| **RAM Modelli LLM a Riposo**          | **0 MiB**                 | Gestito da `llama-lazy-manager.mjs`                      |
| **Throughput Inserimento Memgraph**   | **4.050 nodi/sec**        | 1.000 nodi transazionali inseriti in 246 ms              |
| **Latenza Traversamento Grafo (p50)** | **0.35 ms**               | Mediana su 100 esecuzioni multi-hop                      |
| **Test Suite (`npm run verify`)**     | **269 superati / 1 skip** | 100% conformità di lint, contratti e tipi                |
| **Governance Gates (`eval:all`)**     | **9/9 superati**          | Precisione e recall candidati = 1.0                      |
| **Retrieval Gates (`eval:all`)**      | **11/11 superati**        | nDCG@K = 1.0, latenza p50 = 0.349 ms                     |
| **Synthetic E2E (`e2e-synthetic`)**   | **OK (100%)**             | Ciclo completo: ingest, outbox, backup e restore         |
