# Handoff di sessione — v2 + potatura semantica (16 ottobre 2026)

Passaggio di consegne completo per riprendere in una nuova chat senza perdere contesto.
Branch `feat/v2-graph-model`, tutto locale, mai pushato. `main` ferma a `a5d357c`.
Working tree pulita, 38 commit sopra `main`.

## 1. Stato verificato (ultimo giro verde)

- `npm run verify`: 239 test (1 skipped), build + lint + format puliti.
- `npm run e2e:synthetic`: OK (ciclo a tre memorie, vincoli psql, grafo live, export/restore, pruning).
- `npm run eval:all`: governance 9/9, retrieval 11/11 a nDCG 1.0 (hash `fe1369c0cd5e`).
- Stack locale tutto `running` ma con immagini miste: **api/web ricostruiti dopo il fix canvas,
  worker fermo al codice PART_OF** (manca il rebuild con analyzer schedule + handler
  `arc.deleted`). Al prossimo giro: `docker compose up --build -d api worker web`.

## 2. Cosa contiene il corpus locale (database di sviluppo, non produzione)

Il mini non è mai stato toccato. Sul laptop, nel DB locale ci sono dati demo creati via
API per vedere il grafo: progetti `casa` e `lavoro`, aree `sviluppo`/`riunioni`/`cucina`,
10 memorie (9 accepted + 1 pending "Preferisco risposte concise"), 5 archi memoria
(4 accepted + 1 pending, inclusa una coppia in ciclo `influenza` nei due sensi), 1 arco
progetto `casa → lavoro`, 1 conflitto `direct_contradiction` ("Chiudiamo alle diciotto").
Righe di test precedenti (`dashboard check`, `dash-beta`, scratch) già cancellate via SQL.
Token owner in `~/.mnemosyne/local-owner.token`, harness via `MNEMOSYNE_HARNESS_TOKEN`.
Dashboard: `http://127.0.0.1:8080`, vista Grafo col token incollato.

## 3. Lavoro fatto, in ordine

**Modello v2** (dettagli in `docs/v2-handoff.md`, disegno in `docs/v2-graph-model-plan.md`):
progetti/aree come tabelle con FK reali e trigger (`fe27cce`→`de31e63`), archi pesati
governati con cicli liberi tranne tipi gerarchici (`0434e88`), dashboard con archi e
layer progetti (`6ce82f7`, `b72ec97`), ritiro scope `global` come rename fedele
(`ead27be`), radici Project/Area + `IN_PROJECT`/`IN_AREA`/`PART_OF` in proiezione
(`4056448`, `7485661`), aree e nomi progetto in export/restore (`5afc21b`, `8561371`),
endpoint `GET /v1/admin/arcs` e `GET /v1/admin/projects`, spec/README/CHANGELOG/AGENTS
allineati, E2E esteso con terza memoria area-scoped e asserzioni grafo.

**Potatura semantica fase (a)** (disegno in `docs/potatura-semantica.md`): scorer puro
(recency + peso + kind, niente accessi), tabelle `pruning_proposals` + `pruning_ledger`
nei due backend, job deterministico nella retention (expire + potatura archi + ledger +
stale strutturale), handler `arc.deleted`, report esteso. Commit `69a3f3d`, `8a5f398`,
`09fe8e9`.

**Privacy + analyzer** (stadio c sbloccato a metà): marking manuale progetti/nodi
(`local_only` default, endpoint owner + CLI, export lo conserva), compositore batch
same-flag con LOCAL_ONLY scartati prima di ogni chiamata, client Gemma OpenAI-compatibile
con prompt hashato, proposte `llm` decise col veto deterministico, endpoint
`POST /v1/admin/pruning/analyze` (disabled senza analyzer), schedule worker settimanale.
Commit `d980c13`, `94a7a8b`, `03144b1`.

**Decisioni modelli** (solo documento, niente download — esplicito): runtime **solo
llama.cpp** (niente Ollama, niente sidecar Python), proponente Gemma 3 4B GGUF,
giudizio via `/v1/rerank` + verdetti con JSON-schema forzato, finestra notturna dopo il
backup 02:00 con rientranza, probing su ~30 coppie prima di accendere. Gemma 4 via BYOK
resta alternativa remota. Commit doc `157f4df`, `d783adc`, `b0c0ae5`.

## 4. Decisioni che non si vedono dal codice

- Ritirare `global` è stato un rename, non una risemantizzazione: il `personal` resta
  scrivibile da ogni sessione o "ricorda globalmente" si rompeva dentro una rename.
- `UNION` (non ALL) nel walk anti-cicli: termina anche su dati già ciclici; lock advisory
  contro inserimenti concorrenti delle due metà.
- Export porta progetti, aree e archi perché ogni buco si è annunciato allo stesso modo:
  restore rotto con 500 dal trigger aree alla prima memoria area-scoped.
- Solo il grafo live controlla il Cypher (mancava `WITH` fra `SET` e `MATCH`: batch mai
  marcati, Area mai apparsa). Solo il browser controlla il JS inline (const droppata,
  ogni draw moriva sul primo arco di conflitto: nodi mai dipinti, drag appeso).
- Score senza accessi per scelta dichiarata; coefficienti nei dati (policy), mai nel codice.
- Il decay esegue `expired` (stato esistente mai scritto prima), non tombstone: esce dal
  contesto restando ispezionabile. Le proposte LLM concordanti eseguono, il resto è
  rejected con motivo in attesa del giudice.
- Service e repository con orologi diversi = record che non invecchiano mai: nei test
  l'orologio è condiviso.

## 5. Bug trovati e fixati in sessione

`resolved` droppata nel canvas (console l'ha inchiodata in una riga); `WITH` mancante nel
Cypher aree; conteggio archi incidenti mai incrementato; doppio orologio nei test;
assert E2E su `GET` di memoria expired (404 per design: solo `accepted` si legge);
import orfano che rompeva il lint; enum scope nei dataset di eval dopo il ritiro global.

## 6. Aperto (con proprietario)

- **Tu**: marcature reali PUBLIC/ANONYMIZED (atto tuo, non codice); eventuale chiave BYOK
  se mai servirà il remoto; download effettivo dei pesi GGUF e avvio `llama-server` sul Mac mini;
  merge verso `main` (tocca il mini, decisione tua).
- **Fatto dopo l'handoff iniziale** (`ad583f1`): finestra notturna
  `WORKER_ANALYZER_WINDOW` nel worker (default spento; apertura parcheggiata sull'apertura
  della finestra), rientranza per costruzione (batch id da membri, skip dei batch già
  analizzati anche dopo decisione, memorie pending escluse, contatori `skipped` nel
  report), probing harness del proponente. Verificato: unit 249, E2E OK, eval invariato.
- **Fatto in data odierna (17 ottobre 2026)**:
  1. Potatura automatica dei job terminali (`succeeded`, `failed`, `quarantined`, `cancelled` e cascata su `job_attempts`) e delle chiavi di idempotenza scadute (finestra 30g, senza bump di revisione corpus); OpenAPI e test allineati (`dc7cce0`).
  2. Giudice calibrato `LlamaCppPruningJudge` (`/v1/rerank` + verdetti JSON-schema vincolati su `/v1/chat/completions` con rifiuto di ID inventati) e fusione esplicita `fusePruningScores` (tie-break deterministico), integrati in `CoreMemoryService.judgeLlmProposal` e cablati nel worker dietro `PRUNING_JUDGE_ENABLED=true` (`bcda2bf`).
  3. Golden set di 30 coppie etichettate (`scripts/pruning-golden-set.json`), aggiornamento di `scripts/probe-analyzer.mjs` e nuovo `scripts/probe-judge.mjs` (check deterministico offline + probing live sul giudice), più template launchd `ops/host/launchd/com.mnemosyne.llama.plist` per l'esecuzione nativa Metal su macOS.
- **Debito noto minore**: layer progetti solo per progetti con archi; E2E con immagini
  orfane (~350 MB reali + 2,3 GB build cache recuperabili con prune).

## 7. Come lavorare (disciplina di sessione)

Build dopo ogni modifica logica, `vitest` sul singolo file, mai funzioni senza chiamarle,
DDL su PostgreSQL scratch usa-e-getta, E2E per qualunque Cypher, script di patch in
`/tmp` (l'`edit` su alcuni file è inaffidabile), mai stampare/committare segreti o `.env`,
mai `down -v` sui volumi dati. Commit piccoli con messaggi che spiegano il perché.

## 8. Integrazione Antigravity (17 ottobre 2026)

`.agents/mcp_config.json` nel repo collega l'IDE all'MCP di sviluppo su
`http://127.0.0.1:3333/mcp`, senza segreti nel file. Il `.env` del laptop ora gira
`MCP_TRANSPORT=http` (era `stdio`) e `MCP_HOST=0.0.0.0` nel container (il mapping di
Compose resta `127.0.0.1:3333`: è quello il perimetro), con
`MNEMOSYNE_MCP_REQUIRE_TOKEN=false` e anonymous profile `harness` — due righe aggiunte in
coda, preesistenti mai toccate, `chmod 600` preservato. Verificato live: initialize
anonimo 200 con session id, `tools/list` in nucleo harness (8 tool) senza i tool
owner-only, che restano non registrati per design. Antigravity supporta nativamente
`AGENTS.md` a livello di workspace; nei suoi file di config **non esiste
interpolazione d'ambiente** (solo valori letterali): ecco perché la scelta è HTTP anonimo
solo-loopback e non un header col token. Il token owner da `~/.mnemosyne/local-owner.token`
resta fuori dalla configurazione: l'agent via MCP non arriva mai ai tool owner.
