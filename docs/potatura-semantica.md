# POTATURA_SEMANTICA.md

## Mnemosyne V2 — Sistema di potatura a due stadi (LLM free)

> Principio fondante: **«il modello propone, il servizio decide»**.
> Nessun LLM tocca mai i dati. Il colpo di forbice finale è sempre del job deterministico.

Stato: **fase (a) implementata e verificata; privacy e analyzer implementati**.
Decisione modelli (locale, niente download ancora — solo valutazione): proponente
**Gemma 3** in locale (classe 4B, `gemma3:4B` su Ollama; il 12B non entra nel mini
con lo stack acceso), giudice **encoder** (NLI multilingua + coseno sugli embedding
esistenti). Gemma 4 via BYOK resta l'alternativa remota se la resa locale delude.
Finestra notturna (dopo il backup delle 02:00) con rientranza per batch.
Marking manuale su progetti e nodi (endpoint owner + CLI, default `local_only`, nessuna
inferenza), export/restore lo conservano. Analyzer Gemma via BYOK con flag OFF default:
compone batch same-flag, filtra id allucinati prima della tabella, scrive proposte
`llm` pending; la retention le decide col veto (concordanti eseguite, il resto
rifiutato con motivo in attesa del giudice). Probing differito su golden set di ~30
coppie etichettate, per entrambi i modelli prima di accenderli: resa delle proposte
(Gemma 3) e calibrazione dei verdetti (encoder). **Resta aperto: il giudice encoder**
(servizio di scoring + fusione esplicita) e le marcature reali sui dati (atto del
proprietario, non codice). — score deterministico con segnali
esistenti, decay a `expired` e potatura archi dentro la retention run, ledger e stale
detection strutturale. Gate: unit + service test con clock condiviso, E2E sintetico con
scenario dedicato (memoria invecchiata via psql, arco debole, LINK rimosso
verificato sul grafo live), eval invariato. Fase (b) (tracking accessi):
**implementazione futura** — il segnale che manca allo score, da aggiungere solo quando
il suo valore supera il costo (scrittura a ogni lettura sul percorso hot + estensione
della postura "telemetria sono solo conteggi"). Ambito quando si farà: contatore letture,
quarto addendo con pesi ribilanciati, formula sempre dichiarata. Fase (c) (stadio LLM)
**bloccata su due decisioni esplicite**: quale
provider remoto autorizzare, e come marcare i dati PUBLIC/ANONYMIZED.

Deviazioni decise rispetto alla prima stesura (motivate sotto, non unilaterali):

- La formula dichiara esplicitamente i segnali che esistono — recency, peso archi, kind.
  `access_frequency` non esiste nel sistema e non viene promesso (fase (b),
  implementazione futura).
- I coefficienti vivono nella policy esistente estesa, non in tabelle `node_retention` /
  `edge_retention` parallele: una sola fonte di verità su "cosa si cancella quando".
- L'esecuzione del decay su memorie usa il lifecycle `expired` esistente (mai scritto da
  nessuno finora: è il suo primo scrittore), non una tombstone immediata. `expired`
  significa "non più applicabile" ed esce dal contesto restando ispezionabile.
- Il flag `protected` è rinviato: senza superficie per impostarlo sarebbe scrittura morta.
- Gli id sono UUID in `text`, per convenzione del resto dello schema (mai serial).
- `prompt_hash` dà **audit**, non ripetibilità: i modelli free cambiano sotto i piedi.

---

### 1. Architettura

```
[Batch memorie] → [Stadio 1: LLM free — ANALISI] → pruning_proposals
                                                        ↓
[Stadio 2: Job deterministico — DECISIONE] → tombstone / RESTRICT / supersede / expire
                                                        ↓
                                            [Ledger (indelebile)]
```

- **Stadio 1 (asincrono, worker, fase (c)):** Gemma 3 locale via Ollama (stesso endpoint OpenAI-compatibile del resto del plumbing: cambia `baseUrl`, dal container via host gateway) oppure, in alternativa remota, Gemma 4 (default 26B A4B MoE per velocità e 256K di contesto, 31B dense dove serve qualità) via BYOK Google AI Studio sull'endpoint OpenAI-compatibile (`.../v1beta/openai/` + `chat/completions`): lo stesso plumbing dell'estrattore esistente, con `baseUrl` e chiave propri, mai committati. Riceve batch di memorie e restituisce **proposte** (ridondanze, contraddizioni, fusioni) con rationale. Il modello firma la proposta, non la esegue. Vincoli invariati: niente tabelle di retention parallele (si estende `balancedRetentionPolicy`), il detector `direct_contradiction` deterministico vince sempre sull'LLM, supersede resta stato finché il merge cross-sessione non è progettato per bene.
- **Fase (b), il giudice encoder (deciso, non scaricato):** niente modello generativo per giudicare — un encoder multilingua piccolo (classe 100-500M parametri, CPU-friendly, deterministico per costruzione: stesso input, stesso output, niente JSON, niente id inventati). Due teste, una per domanda: similarità coseno per la ridondanza (riusando gli embedding che l'indice semantico già calcola: costo quasi zero) e NLI multilingua (XNLI include l'italiano) per entailment/neutro/contraddizione con probabilità softmax come score calibrato. Runtime: micro-servizio Python (FastAPI + sentence-transformers/onnx) in compose chiamato dal worker via HTTP, oppure onnxruntime-node senza Python. La `confidence` a ledger diventa una probabilità calibrata vera. Mercury Decide resta l'alternativa remota con la stessa forma (scelta/punteggio/sì-no, endpoint System One).
- **Stadio 2 (job deterministico, fase (a)):** scrive proposte, le decide rileggendo stato fresco, esegue. Con due punteggi in campo (deterministico + calibrato) la fusione è policy esplicita da definire all'implementazione; in parità vince lo score deterministico. Sempre.

---

### 2. Privacy marking (deciso — la pipeline parte da qui)

- Flag `privacy` a livello di **progetto**, tre valori: `LOCAL_ONLY` (default) |
  `ANONYMIZED` | `PUBLIC`. Colonne dedicate su `projects` e, come override, su `memories`
  (null = si eredita dal progetto; l'override vince sempre sul progetto).
- **La pipeline resta inerte per design** finché non c'è marking esplicito: con tutto a
  `LOCAL_ONLY` il compositore produce zero batch e l'analyzer non parte. È voluto, non
  un bug. Nessun default permissivo, mai.
- `ANONYMIZED`: al modello remoto esce SOLO riassunto deterministico + categoria —
  kind, tipo di scope (non gli id), fascia d'età, tipi di arco incidenti. Mai contenuto
  grezzo, mai identificatori: niente persone, path, credenziali, date precise. Il
  riassunto è volutamente lossy: la sicurezza sta nel non mandare, non nel mascherare.
- `PUBLIC`: il nodo può uscire intero (contenuto + metadati).
- I batch contengono solo nodi con lo **stesso flag effettivo**: mai mescolare PUBLIC e
  ANONYMIZED nella stessa richiesta — il formato del payload dipende dal flag.
- Marking **manuale del proprietario alla creazione**: endpoint admin per il progetto
  (`POST /v1/admin/projects/{id}/privacy`), comando CLI (`project-privacy`), override
  del nodo in proposta. **NESSUNA inferenza automatica del flag**: indovinare la
  privacy è il modo più veloce per violarla.

---

### 3. Stadio 1 — Tabella `pruning_proposals`

Output del modello = righe in tabella. Il modello NON ha credenziali di scrittura sulle memorie.
In fase (a) la stessa tabella ospita le proposte dello scorer deterministico (`proposer` lo
dichiara): forma uguale, audit uguale, lo stadio LLM si innesta dopo senza migrazioni.

```sql
CREATE TABLE pruning_proposals (
    id              TEXT PRIMARY KEY,   -- UUID in text, per convenzione dello schema
    batch_id        TEXT NOT NULL,
    proposer        TEXT NOT NULL,      -- 'deterministic' | 'llm' (fase c)
    proposal_type   TEXT NOT NULL,      -- 'decay' | 'edge' | 'redundancy' | 'contradiction' | 'merge'
    source_ids      TEXT[] NOT NULL,    -- nodi (o archi) coinvolti
    source_versions JSONB NOT NULL,     -- versioni/pesi letti alla proposta, per lo stale check
    target_id       TEXT,               -- per merge: nodo sintesi proposto
    rationale       TEXT NOT NULL,
    confidence      NUMERIC(3,2) NOT NULL,  -- deterministico: lo score normalizzato 0..1
    score_snapshot  JSONB NOT NULL,     -- componenti dello score alla decisione
    model_version   TEXT,               -- solo LLM: es. 'free-llm/xyz'
    prompt_hash     TEXT,               -- solo LLM: audit, NON ripetibilità
    status          TEXT NOT NULL DEFAULT 'pending',
        -- 'pending' | 'accepted' | 'rejected' | 'stale'
    decided_at      TIMESTAMPTZ,
    decision_reason TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Stale detection:** prima di decidere, il job rilegge lo stato fresco. Se una memoria
sorgente ha cambiato versione o lifecycle, o un arco ha cambiato peso (o non esiste più),
la proposta va in `stale` — mai potare su fotografie vecchie del grafo. Vale anche fra
scrittura e decisione dello stesso run: la finestra è piccola ma reale con review
concorrenti.

---

### 4. Stadio 2 — Score composito e decisione (fase (a): solo segnali esistenti)

Score per nodo, ricalcolato dal job a ogni run:

```
score = w_r · recency + w_e · avg_edge_weight + w_t · kind_factor
```

- `recency` in 0..1 da `updated_at` (decadimento temporale, parametrico).
- `avg_edge_weight` in 0..1: media dei pesi non nulli degli archi accettati incidenti;
  0.5 neutro quando non ce ne sono. Dichiarato, non nascosto.
- `kind_factor` in 0..1 dalla tabella dei coefficienti (dati, non codice).
- Pesi `w_r + w_e + w_t = 1`: lo score resta in 0..1 e `confidence` lo riusa.

Regole di decisione, in ordine:

1. **Whitelist:** kind mai in scadenza (`fact`, `decision`) filtrati via in `WHERE` prima del calcolo. Non entrano nel gioco.
2. **Campo `protected`:** rinviato (vedi sopra) — quando esisterà, freezing manuale che vince su tutto.
3. Proposta + score concordanti → esecuzione.
4. Proposta (futura LLM) + score contrari → `rejected` con motivo (auditabile).
5. Score sotto soglia da scorer deterministico → proposta `decay` decisa nello stesso run.
6. Archi gerarchici (`hierarchical_relation`) **mai** potati per peso: togliere un arco non crea cicli, ma ristrutturerebbe silenziosamente la gerarchia. Solo review esplicita.

**Regola di conflitto esplicita: in parità vince lo score.**

Esecuzione in fase (a):

- Arco sotto soglia → riga cancellata + ledger `edge_pruned`. Solo archi accettati e non gerarchici.
- Memoria sotto soglia → lifecycle a `expired` + ledger `expired` + potatura degli archi incidenti (un arco verso un nodo non visibile è rumore; la potatura li registra uno a uno).
- `expired` esce dal contesto (solo `accepted` vi entra) ma resta ispezionabile: il decay è a due tempi per costruzione, non una cancellazione travestita.

---

### 5. Retention differenziale per tipo di NODO

Facts immutabili: **mai potate**. Quando obsolete vengono **superseded** — il meccanismo
di correction esistente conserva la storia epistemica, senza archi inventati.

| categoria  | decadimento    | potabile            | note                                    |
| ---------- | -------------- | ------------------- | --------------------------------------- |
| fact       | 0 (immutabile) | mai, solo supersede | correction esistente conserva la storia |
| decision   | lentissimo     | solo con supersede  | whitelist di default                    |
| preference | lentissimo     | sì (→ expired)      | decadimento per disuso                  |
| goal       | lento          | sì (→ expired)      | expire quando riformulato               |
| episodic   | medio          | sì (→ expired)      | candidato tipico del decay              |
| detail     | veloce         | sì (→ expired)      | la prima a sparire                      |

Implementazione su macchinario attuale: i coefficienti estendono `balancedRetentionPolicy`
(pesi, soglie, fattori per kind, kind mai in scadenza), riportati nel report del run.
Niente tabelle parallele.

---

### 6. Retention differenziale per tipo di ARCO

The link dies before the memory: an edge below threshold gets pruned even if both nodes stay.

| tipo arco   | decadimento | note                                 |
| ----------- | ----------- | ------------------------------------ |
| gerarchici  | mai auto    | solo review esplicita (vedi §4.6)    |
| causale     | lento       | consolidata dall'uso ripetuto        |
| associativa | medio       | decade col disuso                    |
| contestuale | veloce      | la più volatile, tipo sinapsi deboli |

Implementazione su macchinario attuale: soglia di peso nel report del run (`edgeWeight`
sotto soglia → prune). Il tipo guida la soglia futura, non tabelle separate oggi.

---

### 7. Ledger (indelebile)

Every cut — deterministico, futuro LLM-proposed, o decay ordinario — leaves a trace in
`pruning_ledger` (tabella dedicata: il forget ledger resta per i forget, chiave su
`memory_id`, e non si mischiano i registri):

- subject (`memory` | `arc`) + id, reason (`decay` | `edge_weight` | `llm_proposal` | `manual`), proposal_id (nullable),
- score e componenti alla decisione, model_version + prompt_hash se coinvolti,
- outcome: `expired` | `edge_pruned`.

RESTRICT al posto del CASCADE: a cascade would delete memories without a trace. Il trigger
con errore finto-23503 resta il livello di enforcement, come nel resto del sistema.

---

### 8. Flusso operativo riassunto

1. Retention run (schedulato o owner) → scorer deterministico su memorie accettate e archi accettati.
2. Proposte in `pruning_proposals` con versioni/pesi letti (pending).
3. Job: rilettura fresca → whitelist → score → decisione (`accepted`/`rejected`/`stale`) → esecuzione con ledger.
4. Esecuzione: archi sotto soglia cancellati, memorie sotto soglia a `expired` con archi incidenti potati.
5. Fase (c), quando sbloccata: worker offline → batch secondo privacy flag → LLM free → stesse righe, `proposer='llm'` → stesso job decide, e in parità vince lo score.
6. Neo4j: solo il worker scrive la proiezione ricostruita, nessuno legge il grafo come verità.
