import { z } from 'zod';

const openRouterScopeTypeSchema = z.enum(['session', 'project', 'area', 'global']);
const openRouterMemoryKindSchema = z.enum([
  'fact',
  'preference',
  'instruction',
  'decision',
  'convention',
  'constraint',
  'goal',
  'hypothesis',
  'episode',
]);
const openRouterEpistemicBasisSchema = z.enum([
  'user_asserted',
  'observed',
  'verified',
  'inferred',
  'unknown',
]);
const openRouterAssessmentSchema = z.enum(['uncontested', 'disputed']);
const openRouterSensitivitySchema = z.enum(['normal', 'private', 'sensitive', 'secret']);
const openRouterActivationSchema = z.enum(['always', 'on_demand']);

export const openRouterExtractionCandidateSchema = z.object({
  eventIds: z.array(z.string().min(1)).min(1),
  content: z.string().min(1).max(10_000),
  kind: openRouterMemoryKindSchema,
  scopeType: openRouterScopeTypeSchema,
  scopeId: z.string().min(1),
  epistemicBasis: openRouterEpistemicBasisSchema,
  assessment: openRouterAssessmentSchema,
  confidence: z.number().min(0).max(1).nullable(),
  sensitivity: openRouterSensitivitySchema,
  activation: openRouterActivationSchema,
});

export const openRouterExtractionResultSchema = z.object({
  candidates: z.array(openRouterExtractionCandidateSchema).default([]),
});

export const openRouterChoiceSchema = z.object({
  message: z.object({
    content: z.string().nullable(),
  }),
  finish_reason: z.string().nullable().optional(),
});

export const openRouterResponseSchema = z.object({
  choices: z.array(openRouterChoiceSchema).min(1),
});
