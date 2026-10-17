#!/usr/bin/env node
// Probing harness for the pruning proposer (stage 1): it never starts from
// memory. It builds same-flag batches of generated Italian probes, sends them
// to an OpenAI-compatible endpoint (set the PRUNING_ANALYZER_API_KEY /
// PRUNING_ANALYZER_MODEL / PRUNING_ANALYZER_BASE_URL / PRUNING_ANALYZER_ENABLED
// environment variables), and prints the evidence to trust the model with:
// attempts made, transport/parse failures, valid percentage, candidate type
// distribution, invented identifiers filtered. It writes nothing anywhere:
// these are reusable proposals, no matter how poor the result.
// The probing gate is measurement, not vibes.

const apiKey = process.env.PRUNING_ANALYZER_API_KEY;
const model = process.env.PRUNING_ANALYZER_MODEL;
const baseUrl = process.env.PRUNING_ANALYZER_BASE_URL ?? 'https://openrouter.ai/api/v1';
if (!apiKey || !model) {
  console.error('Serve PRUNING_ANALYZER_API_KEY e PRUNING_ANALYZER_MODEL (solo env, mai repo).');
  process.exit(2);
}
if (process.env.PRUNING_ANALYZER_ENABLED !== 'true') {
  console.error('Imposta PRUNING_ANALYZER_ENABLED=true: il probing è un atto esplicito.');
  process.exit(2);
}

const BATCH_SIZE = 10;
const BATCHES = Math.max(1, Number(process.argv[2] ?? '3'));

const RIDONDANZE = [
  'il progetto usa pnpm come gestore di pacchetti',
  'pnpm è quello che il progetto usa per gestire i pacchetti',
  'le riunioni di squadra si tengono il lunedì mattina',
  'il lunedì mattina sono le riunioni di squadra',
  'la password di test è memorizzata nel file di configurazione locale',
  'il file di configurazione locale contiene la password di test',
  'il deploy avviene tramite docker compose sul server interno',
  'docker compose è la via con cui il deploy raggiunge il server interno',
  'aggiornare sempre la documentazione prima del merge',
  'prima del merge la documentazione va sempre aggiornata',
];

const CONTRADDIZIONI = [
  'la scadenza del ticket è venerdì 17',
  'la scadenza del ticket NON è venerdì 17',
  'la riunione si dice alle 15',
  'la riunione NON si dice alle 15',
  'il modulo di fatturazione è ancora in beta',
  'il modulo di fatturazione NON è più in beta',
  'il backup parte alle 02:00',
  'il backup NON parte alle 02:00',
];

const RUMORE = [
  'il gazebino in giardino ha le tele al suolo',
  'la nonna difendeva i basilichi come giardinieri puntuali',
  'il caffè bestinutto si beve a 92 gradi',
  'la finestra del bagno si apre guardando a ovest',
  'il vecchio fienile ospita tre cassettoni di libri',
  'la raccolta del vetro cade il giovedì',
  'il pittore sannita lasciò quindici domande formulate male',
  'le coperteeltasana procured a bordo Pia',
  'la serra usa un timer meccanico con due prese',
  'il generatore di corrente parte se le temperature vanno sotto 4 gradi',
];

const CONTENTS = [
  ...Array.from(
    { length: BATCH_SIZE },
    (_, i) => RIDONDANZE[i % RIDONDANZE.length] ?? 'fatto generico',
  ),
  ...Array.from({ length: BATCH_SIZE }, (_, i) => CONTRADDIZIONI[i % CONTRADDIZIONI.length]),
  ...RUMORE,
];

let idCounter = 0;
const items = CONTENTS.map((content) => {
  idCounter += 1;
  return {
    memoryId: `probe_${idCounter}`,
    kind: 'fact',
    scopeKind: 'project',
    ageBucket: '<30d',
    incidentArcTypes: [],
    content,
  };
});

const batches = [];
for (let i = 0; i < Math.min(BATCHES * BATCH_SIZE, items.length); i += BATCH_SIZE) {
  batches.push({ privacy: 'public', items: items.slice(i, i + BATCH_SIZE) });
}

const SYSTEM = [
  'You propose pruning candidates for a governed memory service. Return JSON only with a candidates array.',
  'Each candidate must contain proposalType (decay, edge, redundancy, contradiction or merge),',
  'sourceIds (memory ids from the batch, never invented), rationale, and confidence between 0 and 1.',
  'You sign proposals; a deterministic job decides them. Prefer no candidate over an uncertain one.',
].join(' ');

let batchesFailed = 0;
let candidatesParsed = 0;
const types = {};
let confidenceSum = 0;
let hallucinated = 0;

console.log(
  `Probing proponente: ${batches.length} batch, ${batches.reduce((a, b) => a + b.items.length, 0)} nodi, modello ${model}`,
);
console.log('');

for (const batch of batches) {
  const ids = new Set(batch.items.map((item) => item.memoryId));
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: JSON.stringify(batch) },
        ],
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) {
      batchesFailed += 1;
      console.error(`batch fallito: HTTP ${response.status}`);
      continue;
    }
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    const known =
      typeof content === 'string'
        ? (() => {
            try {
              const parsed = JSON.parse(content);
              return Array.isArray(parsed?.candidates) ? parsed.candidates : null;
            } catch {
              return null;
            }
          })()
        : null;
    if (!known) {
      batchesFailed += 1;
      console.error('batch fallito: risposta non JSON sullo schema atteso');
      continue;
    }
    candidatesParsed += known.length;
    for (const candidate of known) {
      types[candidate.proposalType ?? '?'] = (types[candidate.proposalType ?? '?'] ?? 0) + 1;
      if (typeof candidate.confidence === 'number') {
        confidenceSum += candidate.confidence;
      }
      if (Array.isArray(candidate.sourceIds)) {
        hallucinated += candidate.sourceIds.filter((id) => !ids.has(id)).length;
      }
    }
  } catch (error) {
    batchesFailed += 1;
    console.error(`batch fallito: ${error?.message ?? error}`);
  }
}

const sent = batches.length;
const ok = sent - batchesFailed;
console.log('');
console.log('=== Resa dichiarata del probing (propone, non decide) ===');
console.log(`batch inviati: ${sent}, falliti: ${batchesFailed}, parse ok: ${ok}`);
if (ok > 0) {
  console.log(
    `candidati totali: ${candidatesParsed} (${(candidatesParsed / ok).toFixed(1)} per batch ok)`,
  );
  console.log(`tipi: ${JSON.stringify(types)}`);
  console.log(`id inventati filtrati: ${hallucinated}`);
  if (candidatesParsed > 0) {
    console.log(`confidenza media: ${(confidenceSum / candidatesParsed).toFixed(3)}`);
  }
}
if (batchesFailed > 0 || ok === 0) {
  console.error('');
  console.error('Probing NON passato (batchesFailed > 0): il modello non è pronto.');
  process.exit(1);
}
console.log('');
console.log('Probing passato: misurato, non fidato. I candidato restano proposte da decidere.');
