import { extractionResultSchema, type ExtractionCandidate, type Scope } from '@mnemosyne/contracts';
import type { EventRecord, Extractor, SessionRecord } from '@mnemosyne/core';

const rememberCommand = /^\s*ricorda\b(?:\s+che\b)?(?:\s*:\s*|\s+)(.+?)\s*$/iu;
const sessionScope = /\b(?:per|in)\s+(?:questa\s+)?sessione\b|\bsessione\s+corrente\b/iu;
const globalScope =
  /\b(?:globalmente|in modo globale|in tutte le sessioni|per tutte le sessioni)\b/iu;
const areaScope = /\b(?:area|ambito)\s+["“']?([^"'”’\s,.;!?]+)["”']?/iu;

export class ExplicitRememberExtractor implements Extractor {
  async extract(input: { session: SessionRecord; events: EventRecord[] }): Promise<unknown> {
    const candidates: ExtractionCandidate[] = [];
    for (const event of input.events) {
      if (!event.explicitMemoryRequest || event.role !== 'user') continue;
      const content = rememberCommand.exec(event.content)?.[1]?.trim();
      if (!content) continue;
      const scope = inferScope(content, input.session);
      if (!scope) continue;
      candidates.push({
        sessionId: input.session.id,
        eventIds: [event.id],
        content,
        kind: inferKind(content),
        scope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
      });
    }
    return extractionResultSchema.parse({ candidates });
  }
}

function inferScope(content: string, session: SessionRecord): Scope | null {
  const matchesSession = sessionScope.test(content);
  const matchesGlobal = globalScope.test(content);
  const areaMatch = areaScope.exec(content);
  if (Number(matchesSession) + Number(matchesGlobal) + Number(areaMatch !== null) > 1) {
    return null;
  }
  if (matchesSession) return { type: 'session', id: session.id };
  if (matchesGlobal) return { type: 'global', id: 'personal' };
  if (areaMatch?.[1]) {
    const areaId = session.areaIds.find(
      (id) => id.toLocaleLowerCase() === areaMatch[1]?.toLocaleLowerCase(),
    );
    return areaId ? { type: 'area', id: areaId } : null;
  }
  return { type: 'project', id: session.projectId };
}

function inferKind(content: string): ExtractionCandidate['kind'] {
  if (/\b(?:preferisco|preferenza|materiale)\b/iu.test(content)) return 'preference';
  if (/\b(?:abbiamo deciso|ho deciso|si è deciso|decisione)\b/iu.test(content)) return 'decision';
  if (/\b(?:mai|vincolo|obbligo|proibito|non devi)\b/iu.test(content)) return 'constraint';
  if (/\b(?:l'obiettivo|obiettivo è|deve raggiungere)\b/iu.test(content)) return 'goal';
  if (/\b(?:usa|usiamo|utilizziamo)\b/iu.test(content)) return 'convention';
  return 'instruction';
}
