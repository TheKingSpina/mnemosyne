const stopWords = new Set([
  'a',
  'ad',
  'al',
  'alla',
  'alle',
  'allo',
  'also',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'che',
  'chi',
  'con',
  'come',
  'da',
  'dal',
  'dalla',
  'dalle',
  'degli',
  'dei',
  'del',
  'di',
  'dove',
  'e',
  'ed',
  'è',
  'for',
  'from',
  'gli',
  'ha',
  'hanno',
  'i',
  'il',
  'in',
  'io',
  'is',
  'it',
  'its',
  'la',
  'le',
  'lo',
  'loro',
  'ma',
  'me',
  'mi',
  'nel',
  'nella',
  'no',
  'non',
  'nostro',
  'o',
  'per',
  'più',
  'qua',
  'quel',
  'quale',
  'quando',
  'quanto',
  'se',
  'senza',
  'si',
  'sono',
  'su',
  'sul',
  'the',
  'their',
  'this',
  'to',
  'un',
  'una',
  'uno',
  'was',
  'we',
  'what',
  'when',
  'where',
  'which',
  'with',
  'you',
]);

const genericTerms = new Set([
  'code',
  'content',
  'file',
  'files',
  'information',
  'memory',
  'memories',
  'project',
  'service',
  'system',
  'use',
  'used',
  'using',
]);

export const minimumSearchScore = 0.12;
export const minimumSemanticScore = 0.9;
export const semanticScoreWeight = 0.65;
export const semanticLexicalBoost = 0.2;

export interface QueryTerm {
  token: string;
  raw: string;
  weight: number;
}

export interface QueryAnalysis {
  normalized: string;
  terms: QueryTerm[];
  tsQuery: string;
}

export interface LexicalDocument {
  content: string;
}

export interface LexicalCorpusStats {
  documentCount: number;
  averageLength: number;
  documentFrequencies: Map<string, number>;
  inverseDocumentFrequencies: Map<string, number>;
}

export function analyzeQuery(query: string): QueryAnalysis {
  const normalized = normalizeText(query);
  const rawTokens = tokenize(normalized);
  const terms: QueryTerm[] = [];
  const seen = new Set<string>();
  for (const raw of rawTokens) {
    const token = stemToken(raw);
    if (token.length < 2 || stopWords.has(token) || seen.has(token)) continue;
    seen.add(token);
    terms.push({
      token,
      raw,
      weight: genericTerms.has(token) ? 0.35 : 1,
    });
  }
  return {
    normalized,
    terms,
    tsQuery: [...new Set(terms.flatMap((term) => [term.raw, term.token]))]
      .map((token) => `${token}:*`)
      .join(' or '),
  };
}

export function buildLexicalCorpusStats(
  analysis: QueryAnalysis,
  documents: LexicalDocument[],
): LexicalCorpusStats {
  const documentFrequencies = new Map<string, number>();
  let totalLength = 0;
  for (const document of documents) {
    const tokens = tokenize(document.content).map(stemToken);
    totalLength += tokens.length;
    for (const token of new Set(tokens)) {
      if (analysis.terms.some((term) => term.token === token)) {
        documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
      }
    }
  }
  const documentCount = documents.length;
  const averageLength = documentCount === 0 ? 1 : Math.max(1, totalLength / documentCount);
  const inverseDocumentFrequencies = new Map<string, number>();
  for (const term of analysis.terms) {
    const frequency = documentFrequencies.get(term.token) ?? 0;
    inverseDocumentFrequencies.set(
      term.token,
      Math.log(1 + (documentCount - frequency + 0.5) / (frequency + 0.5)),
    );
  }
  return {
    documentCount,
    averageLength,
    documentFrequencies,
    inverseDocumentFrequencies,
  };
}

export function tokenize(value: string): string[] {
  return (
    value
      .normalize('NFKC')
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

export function stemToken(value: string): string {
  const token = value.normalize('NFKC').toLocaleLowerCase();
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('ied') && token.length > 4) return `${token.slice(0, -3)}y`;
  const suffixes = [
    'iscono',
    'isce',
    'isci',
    'isco',
    'iamo',
    'ano',
    'azioni',
    'azione',
    'ioni',
    'ione',
    'mente',
    'ing',
    'ed',
    'es',
    's',
  ];
  for (const suffix of suffixes) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

export function lexicalRelevance(
  analysis: QueryAnalysis,
  content: string,
  stats?: LexicalCorpusStats,
): number {
  if (analysis.terms.length === 0) return 0;
  const contentTokens = tokenize(content).map(stemToken);
  const contentTokenCounts = new Map<string, number>();
  for (const token of contentTokens) {
    contentTokenCounts.set(token, (contentTokenCounts.get(token) ?? 0) + 1);
  }
  const contentTokenSet = new Set(contentTokens);
  const matchedTerms = analysis.terms.filter((term) => contentTokenSet.has(term.token));
  if (matchedTerms.length === 0) return 0;
  const totalWeight = analysis.terms.reduce((total, term) => total + term.weight, 0);
  const matchedWeight = matchedTerms.reduce((total, term) => total + term.weight, 0);
  const coverage = matchedWeight / totalWeight;
  const k1 = 1.2;
  const b = 0.75;
  const averageLength = stats?.averageLength ?? Math.max(1, contentTokens.length);
  let bm25 = 0;
  let maximumBm25 = 0;
  for (const term of analysis.terms) {
    const termFrequency = contentTokenCounts.get(term.token) ?? 0;
    const inverseDocumentFrequency = stats?.inverseDocumentFrequencies.get(term.token) ?? 1;
    const lengthNormalization = k1 * (1 - b + (b * contentTokens.length) / averageLength);
    bm25 +=
      termFrequency > 0
        ? (inverseDocumentFrequency * (termFrequency * (k1 + 1))) /
          (termFrequency + lengthNormalization)
        : 0;
    maximumBm25 += inverseDocumentFrequency * (k1 + 1);
  }
  const bm25Score = maximumBm25 > 0 ? bm25 / maximumBm25 : 0;
  const phraseTokens = analysis.terms.map((term) => term.token);
  const phraseBonus = contentTokens.join(' ').includes(phraseTokens.join(' ')) ? 0.25 : 0;
  const proximityBonus = proximityScore(contentTokens, phraseTokens);
  const densityBonus = Math.min(0.12, (matchedWeight / Math.max(1, contentTokens.length)) * 0.12);
  const baseScore = stats ? bm25Score * 0.72 + coverage * 0.28 : coverage;
  const genericPenalty = analysis.terms.every((term) => term.weight < 1) ? 0.7 : 1;
  return Math.min(2.5, (baseScore + phraseBonus + proximityBonus + densityBonus) * genericPenalty);
}

export function combineSearchScores(lexicalScore: number, semanticScore: number): number {
  const lexical = Number.isFinite(lexicalScore) && lexicalScore > 0 ? lexicalScore : 0;
  const semantic =
    Number.isFinite(semanticScore) && semanticScore > 0 ? Math.min(1, semanticScore) : 0;
  if (lexical === 0) {
    return semantic >= minimumSemanticScore ? semantic * semanticScoreWeight : 0;
  }
  return lexical + semantic * semanticLexicalBoost;
}

function proximityScore(contentTokens: string[], queryTokens: string[]): number {
  const required = new Set(queryTokens);
  if (required.size === 0 || !queryTokens.every((token) => contentTokens.includes(token))) return 0;
  const counts = new Map<string, number>();
  let covered = 0;
  let left = 0;
  let minimumSpan = Number.POSITIVE_INFINITY;
  for (let right = 0; right < contentTokens.length; right += 1) {
    const token = contentTokens[right];
    if (!required.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
    if (counts.get(token) === 1) covered += 1;
    while (covered === required.size) {
      minimumSpan = Math.min(minimumSpan, right - left + 1);
      const leftToken = contentTokens[left];
      if (required.has(leftToken)) {
        const nextCount = (counts.get(leftToken) ?? 1) - 1;
        counts.set(leftToken, nextCount);
        if (nextCount === 0) covered -= 1;
      }
      left += 1;
    }
  }
  if (!Number.isFinite(minimumSpan)) return 0;
  return Math.max(0, 0.18 - Math.max(0, minimumSpan - required.size) * 0.02);
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}
