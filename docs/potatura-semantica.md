# POTATURA_SEMANTICA.md

## Mnemosyne V2 — Sistema di potatura a due stadi (LLM free)

> Principio fondante: **«il modello propone, il servizio decide»**.
> Nessun LLM tocca mai i dati. Il colpo di forbice finale è sempre del job deterministico.

Stato: **fase (a) in implementazione** — score deterministico con segnali esistenti,
decay e potatura archi sul macchinario attuale (balanced retention estesa, non tabelle
parallele), ledger e stale detection da subito. Fase (b) (tracking accessi) rinviata:
solo se serve davvero. Fase (c) (stadio LLM) **bloccata su due decisioni esplicite**:
quale provider remoto autorizzare, e come marcare i dati PUBLIC/ANONYMIZED.

Deviazioni decise rispetto alla prima stesura (motivate sotto, non unilaterali):

- La formula dichiara esplicitamente i segnali che esistono — recency, peso archi, kind.
  `access_frequency` non esiste nel sistema e non viene promesso (fase (b), eventuale).
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

- **Stadio 1 (asincrono, worker, fase (c)):** invia al modello remoto FREE batch di memorie e riceve **proposte**: ridondanze, contraddizioni, fusioni. Il modello firma la proposta, non la esegue.
- **Stadio 2 (job deterministico, fase (a)):** in (a) il proponente è lo scorer deterministico stesso: scrive proposte, le decide rileggendo stato fresco, esegue. Se lo score smentisce una futura proposta LLM, **vince lo score**. Sempre.

---

### 2. Privacy (da decidere PRIMA di mandare anything in rete — fase (c), bloccato)

- Flag `privacy` a livello di **progetto** con override più fine a livello di **nodo**: `PUBLIC` / `ANONYMIZED` / `LOCAL_ONLY`.
- Il worker compone i batch rispettando il flag: `LOCAL_ONLY` non esce mai dal perimetro; `ANONYMIZED` esce solo come riassunto senza identificatori; `PUBLIC` può uscire intero.
- **Default sicuro: `LOCAL_ONLY`** per tutto ciò che non è esplicitamente marcato altrimenti.

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
