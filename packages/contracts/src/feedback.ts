import { z } from 'zod';

export const memoryFeedbackSchema = z.object({
  memoryId: z.string().min(1),
  sessionId: z.string().min(1),
  kind: z.enum(['useful', 'not_useful', 'outdated', 'incorrect', 'scope_mismatch']),
  comment: z.string().max(2_000).optional(),
  observedAt: z.string().datetime({ offset: true }),
});
export type MemoryFeedbackInput = z.infer<typeof memoryFeedbackSchema>;

export const memoryFeedbackOutputSchema = z.object({
  id: z.string().min(1),
  memoryId: z.string().min(1),
  sessionId: z.string().min(1),
  kind: z.enum(['useful', 'not_useful', 'outdated', 'incorrect', 'scope_mismatch']),
  comment: z.string().max(2_000).optional(),
  observedAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
});
export type MemoryFeedbackOutput = z.infer<typeof memoryFeedbackOutputSchema>;

export const listMemoryFeedbackOutputSchema = z.object({
  items: z.array(memoryFeedbackOutputSchema),
});
export type ListMemoryFeedbackOutput = z.infer<typeof listMemoryFeedbackOutputSchema>;
