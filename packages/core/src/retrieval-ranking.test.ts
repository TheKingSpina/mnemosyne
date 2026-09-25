import { describe, expect, it } from 'vitest';
import {
  analyzeQuery,
  buildLexicalCorpusStats,
  combineSearchScores,
  lexicalRelevance,
  minimumSearchScore,
  minimumSemanticScore,
} from './retrieval-ranking.js';

describe('retrieval ranking', () => {
  it('scores a specific token match above a generic match', () => {
    const analysis = analyzeQuery('cache Redis');
    const specific = lexicalRelevance(
      analysis,
      'Il gateway API usa una cache Redis per le risposte',
    );
    const generic = lexicalRelevance(analysis, 'Il progetto usa una cache per il gateway');
    const missing = lexicalRelevance(analysis, 'Il worker usa una coda PostgreSQL');

    expect(specific).toBeGreaterThan(generic);
    expect(generic).toBeGreaterThanOrEqual(minimumSearchScore);
    expect(missing).toBe(0);
  });

  it('boosts rare terms and nearby phrase matches', () => {
    const analysis = analyzeQuery('orbital telemetry');
    const documents = [
      { content: 'telemetry appears in many unrelated reports' },
      { content: 'orbital telemetry' },
      { content: 'orbital telemetry appears in many unrelated reports' },
    ];
    const stats = buildLexicalCorpusStats(analysis, documents);
    const rare = lexicalRelevance(analysis, documents[1].content, stats);
    const distant = lexicalRelevance(
      analysis,
      'orbital appears in many unrelated reports before telemetry',
      stats,
    );

    expect(rare).toBeGreaterThan(distant);
    expect(rare).toBeGreaterThanOrEqual(minimumSearchScore);
  });

  it('rejects weak semantic-only matches and combines strong ones', () => {
    expect(combineSearchScores(0, minimumSemanticScore - 0.01)).toBe(0);
    expect(combineSearchScores(0.4, 0)).toBeCloseTo(0.4);
    expect(combineSearchScores(0.4, 0.2)).toBeGreaterThan(0.4);
    expect(combineSearchScores(0.4, minimumSemanticScore + 0.05)).toBeGreaterThan(0.4);
  });
});
