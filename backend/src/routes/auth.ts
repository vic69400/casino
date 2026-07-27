/**
 * Route d'authentification — STUB DE DÉVELOPPEMENT UNIQUEMENT.
 *
 * Émet un JWT contenant l'userId à partir d'un simple username, sans mot de
 * passe ni vérification d'identité. À remplacer par l'IdP réel de
 * l'opérateur de casino en production (voir docs/INTEGRATION.md).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';

const devLoginSchema = z.object({
  username: z.string().min(3).max(32),
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/dev-login', async (request, reply) => {
    const parsed = devLoginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }

    const user = await prisma.user.upsert({
      where: { username: parsed.data.username },
      update: {},
      create: { username: parsed.data.username, balance: 100_000 },
    });

    const token = app.jwt.sign({ sub: user.id, username: user.username }, { expiresIn: '12h' });

    return reply.send({
      token,
      userId: user.id,
      username: user.username,
      balance: user.balance,
    });
  });
}
