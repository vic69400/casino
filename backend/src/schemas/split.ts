/**
 * Schémas de validation stricte des entrées de l'API Split (zod).
 */

import { z } from 'zod';

export const startGameSchema = z.object({
  betAmount: z.number().int().positive().max(1_000_000),
});

export const playRoundSchema = z.object({
  direction: z.enum(['left', 'right']),
});

export const rotateSessionSchema = z.object({
  clientSeed: z.string().min(1).max(128).optional(),
});

export const userIdParamSchema = z.object({
  userId: z.string().uuid(),
});

export const sessionIdParamSchema = z.object({
  sessionId: z.string().uuid(),
});
