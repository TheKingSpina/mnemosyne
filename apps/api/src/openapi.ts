import {
  adminCapabilitiesOutputSchema,
  adminJobsOutputSchema,
  adminMemoriesOutputSchema,
  adminOverviewOutputSchema,
  adminSessionDetailOutputSchema,
  adminSessionsOutputSchema,
  conflictListOutputSchema,
  conflictViewSchema,
  contextInputSchema,
  contextOutputSchema,
  correctMemoryInputSchema,
  correctMemoryOutputSchema,
  corpusExportSchema,
  corpusRestoreResultSchema,
  forgetMemoryInputSchema,
  jobViewSchema,
  listJobAttemptsOutputSchema,
  listMemoryFeedbackOutputSchema,
  memoryAdminViewSchema,
  memoryFeedbackSchema,
  memoryFeedbackOutputSchema,
  memoryKindSchema,
  memoryLifecycleSchema,
  memoryRevisionSchema,
  memoryViewSchema,
  openSessionInputSchema,
  openSessionOutputSchema,
  pendingProposalsOutputSchema,
  prepareForgetOutputSchema,
  proposeMemoryInputSchema,
  proposalResultSchema,
  recordEventsInputSchema,
  recordEventsOutputSchema,
  reviewProposalInputSchema,
  reviewProposalOutputSchema,
  retentionRunOutputSchema,
  retentionStatusOutputSchema,
  retractMemoryInputSchema,
  scopeTypeSchema,
} from '@mnemosyne/contracts';
import type {
  Oas3_1Definition,
  Oas3_1Schema,
  Oas3Operation,
  Oas3Parameter,
  Oas3Response,
} from '@redocly/openapi-core';
import { z } from 'zod';

const maxRequestBodyBytes = 1_048_576;
const emptyRequestSchema = z.object({});
const closeSessionOutputSchema = z.object({ jobId: z.string().min(1) });
const searchMemoriesOutputSchema = z.object({ items: z.array(memoryRevisionSchema) });
const apiProblemSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  code: z.string().min(1),
});
const apiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});
const liveHealthSchema = z.object({ status: z.literal('ok') });
const readyHealthSchema = z.object({ status: z.literal('ready') });
const idParameterSchema = z.string().min(1);

const errorDescriptions: Record<number, string> = {
  400: 'Richiesta non valida, JSON non valido o Idempotency-Key mancante.',
  401: 'Bearer token assente o non valido.',
  403: 'Il profilo autenticato non ha il permesso richiesto.',
  404: 'Risorsa o rotta non trovata.',
  405: 'Metodo HTTP non consentito.',
  409: 'Conflitto di stato, versione, idempotenza o precondizione.',
  413: 'Il corpo della richiesta supera il limite di 1.048.576 byte.',
  500: 'Errore interno non esposto nei dettagli.',
};

const inputSchemas = {
  correction: correctMemoryInputSchema.omit({ memoryId: true }),
  proposalDecision: reviewProposalInputSchema.omit({ memoryId: true }),
  event: recordEventsInputSchema.omit({ sessionId: true }),
  retraction: retractMemoryInputSchema.omit({ memoryId: true }),
  forget: forgetMemoryInputSchema.omit({ memoryId: true }),
} as const;

const emptyRequest = schemaFor(emptyRequestSchema, 'input');

export const openApiDocument: Oas3_1Definition = {
  openapi: '3.1.0',
  info: {
    title: 'Mnemosyne REST API',
    version: '0.0.0',
    description: [
      'API monoutente per il Mnemosyne. PostgreSQL è la fonte autorevole; Redis, pgvector e Neo4j sono proiezioni derivate.',
      'I corpi JSON sono limitati a 1.048.576 byte. Nel deployment API ogni operazione POST che modifica lo stato richiede `Idempotency-Key`; `POST /v1/context/resolve` e `POST /v1/memories/{id}/forget/prepare` sono esenti perché non scrivono il corpus.',
      'I token `owner` e `harness` sono scambiati tramite lo stesso schema Bearer ma hanno autorizzazioni diverse, descritte per operazione.',
      'Il documento pubblico `/v1/openapi.json` non contiene dati del corpus ed è servito senza autenticazione con cache `no-store`.',
    ].join('\n\n'),
    license: {
      name: 'GNU Affero General Public License v3.0 only',
      url: 'https://www.gnu.org/licenses/agpl-3.0.html',
    },
  },
  externalDocs: {
    description: 'Specifica tecnica e limiti del progetto',
    url: 'https://github.com/TheKingSpina/mnemosyne/blob/main/docs/assistante-memoriale-spec.md',
  },
  servers: [
    {
      url: 'http://127.0.0.1:3000',
      description:
        'Deployment locale di sviluppo; non esporre questa porta direttamente a Internet.',
    },
  ],
  tags: [
    { name: 'Discovery', description: 'Salute e contratto API.' },
    { name: 'Sessions', description: 'Ciclo di vita ed eventi delle sessioni.' },
    { name: 'Memories', description: 'Proposal, retrieval e lifecycle delle memorie.' },
    { name: 'Context', description: 'Composizione del contesto approvato.' },
    { name: 'Jobs', description: 'Stato dei job asincroni.' },
    { name: 'Administration', description: 'Operazioni riservate al profilo owner.' },
  ],
  security: [{ bearerAuth: [] }],
  paths: {
    '/v1/openapi.json': {
      get: operation({
        tags: ['Discovery'],
        operationId: 'getOpenApiDocument',
        summary: 'Restituisce il contratto OpenAPI corrente',
        description:
          'Operazione pubblica. Il documento contiene soltanto metadati API e non richiede credenziali.',
        requiredProfile: 'public',
        security: [],
        responses: {
          200: jsonResponse('Contratto OpenAPI 3.1.', openApiDocumentSchema()),
          405: errorResponse(405),
        },
      }),
    },
    '/health/live': {
      get: operation({
        tags: ['Discovery'],
        operationId: 'getLiveness',
        summary: 'Verifica che il processo API sia attivo',
        description: 'Endpoint pubblico che non verifica PostgreSQL.',
        requiredProfile: 'public',
        security: [],
        responses: {
          200: jsonResponse('Processo attivo.', schemaFor(liveHealthSchema)),
          405: errorResponse(405),
        },
      }),
    },
    '/health/ready': {
      get: operation({
        tags: ['Discovery'],
        operationId: 'getReadiness',
        summary: 'Verifica che la fonte autorevole sia raggiungibile',
        description:
          'Endpoint pubblico. Restituisce errore se PostgreSQL non può fornire la revisione del corpus.',
        requiredProfile: 'public',
        security: [],
        responses: {
          200: jsonResponse('Fonte autorevole raggiungibile.', schemaFor(readyHealthSchema)),
          405: errorResponse(405),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/sessions': {
      post: operation({
        tags: ['Sessions'],
        operationId: 'openSession',
        summary: 'Apre una sessione di lavoro',
        requiredProfile: 'harness_or_owner',
        idempotent: true,
        requestBody: requestBody(schemaRef('OpenSessionInput')),
        responses: {
          201: jsonResponse('Sessione creata.', schemaRef('OpenSessionOutput')),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          409: errorResponse(409),
          413: errorResponse(413),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/sessions/{id}/events': {
      post: operation({
        tags: ['Sessions'],
        operationId: 'recordSessionEvents',
        summary: 'Registra eventi idempotenti per una sessione',
        description:
          'Gli eventi sono unici per `sessionId + eventId`. Ogni batch con almeno un nuovo evento accoduta un job di estrazione.',
        requiredProfile: 'harness_or_owner',
        idempotent: true,
        parameters: [pathIdParameter()],
        requestBody: requestBody(schemaRef('RecordEventsRequest')),
        responses: {
          202: jsonResponse('Eventi accettati e job enqueued.', schemaRef('RecordEventsOutput')),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          404: errorResponse(404),
          409: errorResponse(409),
          413: errorResponse(413),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/sessions/{id}/close': {
      post: operation({
        tags: ['Sessions'],
        operationId: 'closeSession',
        summary: 'Chiude la sessione e avvia il consolidamento',
        requiredProfile: 'harness_or_owner',
        idempotent: true,
        parameters: [pathIdParameter()],
        requestBody: optionalRequestBody(emptyRequest),
        responses: {
          202: jsonResponse(
            'Sessione chiusa e job di consolidamento enqueued.',
            schemaRef('CloseSessionOutput'),
          ),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          404: errorResponse(404),
          409: errorResponse(409),
          413: errorResponse(413),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/proposals': {
      post: operation({
        tags: ['Memories'],
        operationId: 'proposeMemory',
        summary: 'Propone una memoria governata dalla policy',
        description:
          'Le proposal del profilo harness restano pending finché il owner non le revisiona. Il servizio valida sempre il risultato, anche per un token owner.',
        requiredProfile: 'harness_or_owner',
        idempotent: true,
        requestBody: requestBody(schemaRef('ProposeMemoryInput')),
        responses: {
          201: jsonResponse(
            'Proposta creata, accettata, unita o respinta.',
            schemaRef('ProposalResult'),
          ),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          409: errorResponse(409),
          413: errorResponse(413),
          500: errorResponse(500),
        },
      }),
      get: operation({
        tags: ['Memories'],
        operationId: 'listPendingProposals',
        summary: 'Elenca le candidate pending accessibili alla sessione',
        requiredProfile: 'owner',
        parameters: [
          queryParameter(
            'sessionId',
            schemaFor(idParameterSchema),
            true,
            'Sessione da cui leggere le candidate.',
          ),
          limitParameter(100, 20),
          offsetParameter(),
        ],
        responses: {
          200: jsonResponse('Candidate pending.', schemaRef('PendingProposalsOutput')),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          404: errorResponse(404),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/proposals/{id}/decision': {
      post: operation({
        tags: ['Memories'],
        operationId: 'reviewMemoryProposal',
        summary: 'Accetta o respinge una proposal pending',
        requiredProfile: 'owner',
        idempotent: true,
        parameters: [pathIdParameter()],
        requestBody: requestBody(schemaRef('ReviewProposalRequest')),
        responses: {
          200: jsonResponse('Decisione applicata.', schemaRef('ReviewProposalOutput')),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          404: errorResponse(404),
          409: errorResponse(409),
          413: errorResponse(413),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/context/resolve': {
      post: operation({
        tags: ['Context'],
        operationId: 'resolveMemoryContext',
        summary: 'Compone contesto strutturato entro un budget di token',
        description:
          'Operazione di lettura modellata come POST perché il budget e la query sono un body validato. Non richiede Idempotency-Key.',
        requiredProfile: 'harness_or_owner',
        requestBody: requestBody(schemaRef('ContextInput')),
        responses: {
          200: jsonResponse('Contesto approvato e stato del servizio.', schemaRef('ContextOutput')),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          409: errorResponse(409),
          413: errorResponse(413),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/memories': {
      get: operation({
        tags: ['Memories'],
        operationId: 'searchMemories',
        summary: 'Cerca memorie approvate visibili alla sessione',
        requiredProfile: 'harness_or_owner',
        parameters: [
          queryParameter(
            'sessionId',
            schemaFor(idParameterSchema),
            true,
            'Sessione che determina gli scope visibili.',
          ),
          queryParameter(
            'q',
            schemaFor(z.string().min(1).max(2_000)),
            true,
            'Query lessicale e semantica.',
          ),
          queryParameter(
            'scopeType',
            schemaFor(scopeTypeSchema),
            false,
            'Filtro opzionale; deve essere accompagnato da scopeId.',
          ),
          queryParameter(
            'scopeId',
            schemaFor(idParameterSchema),
            false,
            'Identificatore esatto dello scope.',
          ),
          limitParameter(50, 20),
          offsetParameter(),
        ],
        responses: {
          200: jsonResponse('Memorie recuperate.', schemaRef('SearchMemoriesOutput')),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          404: errorResponse(404),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/memories/{id}': {
      get: operation({
        tags: ['Memories'],
        operationId: 'getMemory',
        summary: 'Legge una memoria',
        description:
          'Il profilo harness riceve la revisione corrente solo se è accepted. Il profilo owner riceve anche record, revisioni e conflitti.',
        requiredProfile: 'harness_or_owner',
        parameters: [pathIdParameter()],
        responses: {
          200: jsonResponse('Memoria o vista amministrativa.', {
            oneOf: [schemaRef('MemoryView'), schemaRef('MemoryAdminView')],
          }),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          404: errorResponse(404),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/memories/{id}/corrections': {
      post: operation({
        tags: ['Memories'],
        operationId: 'correctMemory',
        summary: 'Crea una nuova revisione di una memoria accepted',
        requiredProfile: 'owner',
        idempotent: true,
        parameters: [pathIdParameter()],
        requestBody: requestBody(schemaRef('CorrectMemoryRequest')),
        responses: {
          200: jsonResponse('Correzione applicata.', schemaRef('CorrectMemoryOutput')),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          404: errorResponse(404),
          409: errorResponse(409),
          413: errorResponse(413),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/memories/{id}/retractions': {
      post: operation({
        tags: ['Memories'],
        operationId: 'retractMemory',
        summary: 'Revoca una memoria senza eliminarne la provenienza',
        requiredProfile: 'owner',
        idempotent: true,
        parameters: [pathIdParameter()],
        requestBody: requestBody(schemaRef('RetractionRequest')),
        responses: {
          200: jsonResponse('Memoria revocata.', schemaRef('MemoryView')),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          404: errorResponse(404),
          409: errorResponse(409),
          413: errorResponse(413),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/memories/{id}/forget/prepare': {
      post: operation({
        tags: ['Memories'],
        operationId: 'prepareForgetMemory',
        summary: 'Prepara una conferma forget a breve scadenza',
        description:
          'L’endpoint genera un token HMAC non persistente e non modifica il corpus; non richiede Idempotency-Key.',
        requiredProfile: 'owner',
        parameters: [pathIdParameter()],
        requestBody: optionalRequestBody(emptyRequest),
        responses: {
          200: jsonResponse('Token di conferma emesso.', schemaRef('PrepareForgetOutput')),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          404: errorResponse(404),
          413: errorResponse(413),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/memories/{id}/forget': {
      post: operation({
        tags: ['Memories'],
        operationId: 'forgetMemory',
        summary: 'Dimentica definitivamente una memoria con conferma esplicita',
        description:
          'La rimozione autorevole viene seguita dalla cancellazione delle proiezioni derivate. Il forget ledger non viene rimosso.',
        requiredProfile: 'owner',
        idempotent: true,
        parameters: [pathIdParameter()],
        requestBody: requestBody(schemaRef('ForgetRequest')),
        responses: {
          204: emptyResponse('Memoria dimenticata.'),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          404: errorResponse(404),
          409: errorResponse(409),
          413: errorResponse(413),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/memories/feedback': {
      post: operation({
        tags: ['Memories'],
        operationId: 'submitMemoryFeedback',
        summary: 'Registra feedback non distruttivo su una memoria',
        requiredProfile: 'owner',
        idempotent: true,
        requestBody: requestBody(schemaRef('MemoryFeedbackInput')),
        responses: {
          201: jsonResponse('Feedback registrato.', schemaRef('MemoryFeedbackOutput')),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          404: errorResponse(404),
          413: errorResponse(413),
          500: errorResponse(500),
        },
      }),
      get: operation({
        tags: ['Memories'],
        operationId: 'listMemoryFeedback',
        summary: 'Elenca il feedback registrato per una memoria',
        requiredProfile: 'owner',
        parameters: [
          queryParameter(
            'memoryId',
            schemaFor(idParameterSchema),
            true,
            'Identificatore della memoria.',
          ),
        ],
        responses: {
          200: jsonResponse('Feedback della memoria.', schemaRef('ListMemoryFeedbackOutput')),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/jobs/{id}': {
      get: operation({
        tags: ['Jobs'],
        operationId: 'getJob',
        summary: 'Legge lo stato di un job',
        requiredProfile: 'harness_or_owner',
        parameters: [pathIdParameter()],
        responses: {
          200: jsonResponse('Job trovato.', schemaRef('JobView')),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          404: errorResponse(404),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/admin/overview': {
      get: operation({
        tags: ['Administration'],
        operationId: 'getAdminOverview',
        summary: 'Restituisce gli aggregati di amministrazione',
        requiredProfile: 'owner',
        responses: {
          200: jsonResponse('Aggregati corpus.', schemaRef('AdminOverviewOutput')),
          401: errorResponse(401),
          403: errorResponse(403),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/admin/capabilities': {
      get: operation({
        tags: ['Administration'],
        operationId: 'getAdminCapabilities',
        summary: 'Riporta le capacità operative effettivamente configurate',
        requiredProfile: 'owner',
        responses: {
          200: jsonResponse('Capacità correnti.', schemaRef('AdminCapabilitiesOutput')),
          401: errorResponse(401),
          403: errorResponse(403),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/admin/memories': {
      get: operation({
        tags: ['Administration'],
        operationId: 'listAdminMemories',
        summary: 'Cerca memorie in ogni lifecycle',
        requiredProfile: 'owner',
        parameters: [
          queryParameter('q', schemaFor(z.string().max(2_000)), false, 'Filtro testuale.'),
          queryParameter('lifecycle', schemaFor(memoryLifecycleSchema), false, 'Filtro lifecycle.'),
          queryParameter('kind', schemaFor(memoryKindSchema), false, 'Filtro tipo memoria.'),
          queryParameter('scopeType', schemaFor(scopeTypeSchema), false, 'Filtro tipo scope.'),
          queryParameter(
            'scopeId',
            schemaFor(idParameterSchema),
            false,
            'Filtro identificatore scope.',
          ),
          limitParameter(100, 50),
          offsetParameter(),
        ],
        responses: {
          200: jsonResponse('Memorie filtrate.', schemaRef('AdminMemoriesOutput')),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/admin/memories/{id}': {
      get: operation({
        tags: ['Administration'],
        operationId: 'getAdminMemory',
        summary: 'Legge memoria, revisioni e conflitti',
        requiredProfile: 'owner',
        parameters: [pathIdParameter()],
        responses: {
          200: jsonResponse('Vista amministrativa.', schemaRef('MemoryAdminView')),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          404: errorResponse(404),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/admin/conflicts': {
      get: operation({
        tags: ['Administration'],
        operationId: 'listConflicts',
        summary: 'Elenca tutti i conflitti diretti',
        requiredProfile: 'owner',
        responses: {
          200: jsonResponse('Conflitti trovati.', schemaRef('ConflictListOutput')),
          401: errorResponse(401),
          403: errorResponse(403),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/admin/conflicts/{id}/resolution': {
      post: operation({
        tags: ['Administration'],
        operationId: 'resolveConflict',
        summary: 'Chiude un conflitto diretto',
        requiredProfile: 'owner',
        idempotent: true,
        parameters: [pathIdParameter()],
        requestBody: optionalRequestBody(emptyRequest),
        responses: {
          200: jsonResponse('Conflitto risolto.', schemaRef('ConflictView')),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          404: errorResponse(404),
          409: errorResponse(409),
          413: errorResponse(413),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/admin/sessions': {
      get: operation({
        tags: ['Administration'],
        operationId: 'listAdminSessions',
        summary: 'Elenca le sessioni',
        requiredProfile: 'owner',
        parameters: [
          queryParameter(
            'projectId',
            schemaFor(idParameterSchema),
            false,
            'Filtro progetto esatto.',
          ),
          queryParameter(
            'status',
            schemaFor(z.enum(['open', 'closed'])),
            false,
            'Filtro stato sessione.',
          ),
          limitParameter(100, 50),
          offsetParameter(),
        ],
        responses: {
          200: jsonResponse('Sessioni filtrate.', schemaRef('AdminSessionsOutput')),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/admin/sessions/{id}': {
      get: operation({
        tags: ['Administration'],
        operationId: 'getAdminSession',
        summary: 'Legge una sessione con eventi e job',
        requiredProfile: 'owner',
        parameters: [pathIdParameter()],
        responses: {
          200: jsonResponse('Dettaglio sessione.', schemaRef('AdminSessionDetailOutput')),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          404: errorResponse(404),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/admin/jobs': {
      get: operation({
        tags: ['Administration'],
        operationId: 'listAdminJobs',
        summary: 'Elenca i job di estrazione e consolidamento',
        requiredProfile: 'owner',
        parameters: [
          queryParameter(
            'status',
            schemaFor(
              z.enum(['queued', 'running', 'succeeded', 'failed', 'quarantined', 'cancelled']),
            ),
            false,
            'Filtro stato job.',
          ),
          limitParameter(100, 50),
          offsetParameter(),
        ],
        responses: {
          200: jsonResponse('Job filtrati.', schemaRef('AdminJobsOutput')),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/admin/jobs/{id}/attempts': {
      get: operation({
        tags: ['Administration'],
        operationId: 'listAdminJobAttempts',
        summary: 'Elenca i tentativi di un job',
        requiredProfile: 'owner',
        parameters: [pathIdParameter()],
        responses: {
          200: jsonResponse('Tentativi del job.', schemaRef('ListJobAttemptsOutput')),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          404: errorResponse(404),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/admin/retention': {
      get: operation({
        tags: ['Administration'],
        operationId: 'getRetentionStatus',
        summary: 'Legge stato e policy di retention',
        requiredProfile: 'owner',
        responses: {
          200: jsonResponse('Stato retention.', schemaRef('RetentionStatusOutput')),
          401: errorResponse(401),
          403: errorResponse(403),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/admin/retention/run': {
      post: operation({
        tags: ['Administration'],
        operationId: 'runRetention',
        summary: 'Esegue la retention governata balanced',
        requiredProfile: 'owner',
        idempotent: true,
        requestBody: optionalRequestBody(emptyRequest),
        responses: {
          200: jsonResponse('Retention completata.', schemaRef('RetentionRunOutput')),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          409: errorResponse(409),
          413: errorResponse(413),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/admin/exports/corpus': {
      get: operation({
        tags: ['Administration'],
        operationId: 'exportCorpus',
        summary: 'Scarica il corpus canonico',
        description:
          'Il download usa Content-Disposition e Cache-Control: no-store. Questo export non è ancora un backup operativo certificato.',
        requiredProfile: 'owner',
        responses: {
          200: jsonResponse('Export canonico schema version 1.', schemaRef('CorpusExport')),
          401: errorResponse(401),
          403: errorResponse(403),
          500: errorResponse(500),
        },
      }),
    },
    '/v1/admin/restore/corpus': {
      post: operation({
        tags: ['Administration'],
        operationId: 'restoreCorpus',
        summary: 'Ripristina un export canonico su corpus vuoto',
        description:
          'Il restore valida i riferimenti, unisce il forget ledger preesistente e ignora i dati appartenenti a memorie dimenticate. Non può importare in un corpus non vuoto.',
        requiredProfile: 'owner',
        idempotent: true,
        requestBody: requestBody(schemaRef('CorpusExport')),
        responses: {
          200: jsonResponse('Corpus ripristinato.', schemaRef('CorpusRestoreResult')),
          400: errorResponse(400),
          401: errorResponse(401),
          403: errorResponse(403),
          409: errorResponse(409),
          413: errorResponse(413),
          500: errorResponse(500),
        },
      }),
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'opaque',
        description:
          'Usa MNEMOSYNE_OWNER_TOKEN oppure MNEMOSYNE_HARNESS_TOKEN. Il profilo è determinato dal token, non dallo schema HTTP.',
      },
    },
    parameters: {
      IdempotencyKey: {
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        description:
          'Chiave 1–200 caratteri `[A-Za-z0-9._:-]`. La stessa chiave, attore, metodo, path e JSON replayano la risposta; un fingerprint diverso restituisce 409.',
        schema: schemaFor(z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/u)),
      },
    },
    schemas: {
      OpenSessionInput: schemaRefValue(openSessionInputSchema, 'input'),
      OpenSessionOutput: schemaRefValue(openSessionOutputSchema),
      RecordEventsRequest: schemaRefValue(inputSchemas.event, 'input'),
      RecordEventsOutput: schemaRefValue(recordEventsOutputSchema),
      CloseSessionOutput: schemaRefValue(closeSessionOutputSchema),
      ProposeMemoryInput: schemaRefValue(proposeMemoryInputSchema, 'input'),
      ProposalResult: schemaRefValue(proposalResultSchema),
      PendingProposalsOutput: schemaRefValue(pendingProposalsOutputSchema),
      ReviewProposalRequest: schemaRefValue(inputSchemas.proposalDecision, 'input'),
      ReviewProposalOutput: schemaRefValue(reviewProposalOutputSchema),
      ContextInput: schemaRefValue(contextInputSchema, 'input'),
      ContextOutput: schemaRefValue(contextOutputSchema),
      MemoryView: schemaRefValue(memoryViewSchema),
      MemoryAdminView: schemaRefValue(memoryAdminViewSchema),
      SearchMemoriesOutput: schemaRefValue(searchMemoriesOutputSchema),
      ConflictView: schemaRefValue(conflictViewSchema),
      ConflictListOutput: schemaRefValue(conflictListOutputSchema),
      CorrectMemoryRequest: schemaRefValue(inputSchemas.correction, 'input'),
      CorrectMemoryOutput: schemaRefValue(correctMemoryOutputSchema),
      RetractionRequest: schemaRefValue(inputSchemas.retraction, 'input'),
      PrepareForgetOutput: schemaRefValue(prepareForgetOutputSchema),
      ForgetRequest: schemaRefValue(inputSchemas.forget, 'input'),
      MemoryFeedbackInput: schemaRefValue(memoryFeedbackSchema, 'input'),
      MemoryFeedbackOutput: schemaRefValue(memoryFeedbackOutputSchema),
      ListMemoryFeedbackOutput: schemaRefValue(listMemoryFeedbackOutputSchema),
      JobView: schemaRefValue(jobViewSchema),
      AdminOverviewOutput: schemaRefValue(adminOverviewOutputSchema),
      AdminCapabilitiesOutput: schemaRefValue(adminCapabilitiesOutputSchema),
      AdminMemoriesOutput: schemaRefValue(adminMemoriesOutputSchema),
      AdminSessionsOutput: schemaRefValue(adminSessionsOutputSchema),
      AdminSessionDetailOutput: schemaRefValue(adminSessionDetailOutputSchema),
      AdminJobsOutput: schemaRefValue(adminJobsOutputSchema),
      ListJobAttemptsOutput: schemaRefValue(listJobAttemptsOutputSchema),
      RetentionStatusOutput: schemaRefValue(retentionStatusOutputSchema),
      RetentionRunOutput: schemaRefValue(retentionRunOutputSchema),
      CorpusExport: schemaRefValue(corpusExportSchema, 'input'),
      CorpusRestoreResult: schemaRefValue(corpusRestoreResultSchema),
      ApiProblem: schemaRefValue(apiProblemSchema),
      ApiError: schemaRefValue(apiErrorSchema),
    },
  },
};

export function serializeOpenApiDocument(): string {
  return `${JSON.stringify(openApiDocument, null, 2)}\n`;
}

interface OperationInput {
  tags: string[];
  operationId: string;
  summary: string;
  description?: string;
  requiredProfile: 'public' | 'harness' | 'owner' | 'harness_or_owner';
  security?: Array<Record<string, string[]>>;
  idempotent?: boolean;
  parameters?: Oas3Parameter<Oas3_1Schema>[];
  requestBody?: ReturnType<typeof requestBody>;
  responses: Record<string, Oas3Response<Oas3_1Schema>>;
}

interface MnemosyneOperation extends Oas3Operation<Oas3_1Schema> {
  'x-required-profile': OperationInput['requiredProfile'];
}

function operation(input: OperationInput): MnemosyneOperation {
  const parameters = [
    ...(input.idempotent ? [{ $ref: '#/components/parameters/IdempotencyKey' }] : []),
    ...(input.parameters ?? []),
  ];
  return {
    tags: input.tags,
    operationId: input.operationId,
    summary: input.summary,
    ...(input.description ? { description: input.description } : {}),
    ...(input.security ? { security: input.security } : {}),
    'x-required-profile': input.requiredProfile,
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(input.requestBody ? { requestBody: input.requestBody } : {}),
    responses: input.responses,
  };
}

function requestBody(schema: Oas3_1Schema) {
  return {
    required: true,
    description: `Corpo JSON; limite massimo applicato: ${maxRequestBodyBytes.toLocaleString('en-US')} byte.`,
    content: { 'application/json': { schema } },
  };
}

function optionalRequestBody(schema: Oas3_1Schema) {
  return {
    required: false,
    description: `Corpo JSON opzionale; quando presente deve essere un oggetto vuoto. Il server accetta anche un body assente. Limite massimo: ${maxRequestBodyBytes.toLocaleString('en-US')} byte.`,
    content: { 'application/json': { schema } },
  };
}

function jsonResponse(description: string, schema: Oas3_1Schema): Oas3Response<Oas3_1Schema> {
  return {
    description,
    content: { 'application/json': { schema } },
  };
}

function emptyResponse(description: string): Oas3Response<Oas3_1Schema> {
  return { description };
}

function errorResponse(status: number): Oas3Response<Oas3_1Schema> {
  return jsonResponse(errorDescriptions[status] ?? 'Errore API.', {
    oneOf: [schemaRef('ApiProblem'), schemaRef('ApiError')],
  });
}

function schemaRef(name: string): Oas3_1Schema {
  return { $ref: `#/components/schemas/${name}` };
}

function pathIdParameter(name = 'id'): Oas3Parameter<Oas3_1Schema> {
  return {
    name,
    in: 'path',
    required: true,
    description: 'Identificatore sintetico o opaco restituito dal servizio.',
    schema: schemaFor(idParameterSchema),
  };
}

function queryParameter(
  name: string,
  schema: Oas3_1Schema,
  required: boolean,
  description: string,
): Oas3Parameter<Oas3_1Schema> {
  return { name, in: 'query', required, description, schema };
}

function limitParameter(maximum: number, defaultValue: number): Oas3Parameter<Oas3_1Schema> {
  return queryParameter(
    'limit',
    schemaFor(z.coerce.number().int().min(1).max(maximum).default(defaultValue)),
    false,
    'Numero massimo di elementi da restituire.',
  );
}

function offsetParameter(): Oas3Parameter<Oas3_1Schema> {
  return queryParameter(
    'offset',
    schemaFor(z.coerce.number().int().min(0).default(0)),
    false,
    'Numero di elementi da saltare.',
  );
}

function schemaRefValue(schema: z.ZodType, io: 'input' | 'output' = 'output'): Oas3_1Schema {
  return schemaFor(schema, io);
}

function schemaFor(schema: z.ZodType, io: 'input' | 'output' = 'output'): Oas3_1Schema {
  const generated = z.toJSONSchema(schema, {
    io,
    target: 'draft-2020-12',
    unrepresentable: 'throw',
  });
  const schemaValue = { ...generated };
  delete schemaValue.$schema;
  delete schemaValue.$defs;
  return schemaValue as Oas3_1Schema;
}

function openApiDocumentSchema(): Oas3_1Schema {
  return { type: 'object', additionalProperties: true };
}
