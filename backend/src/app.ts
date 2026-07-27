/**
 * Construction de l'instance Fastify (séparée de `server.ts` pour pouvoir
 * être réutilisée telle quelle par les tests d'intégration, sans écouter de
 * port réseau).
 */

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { registerAuth } from './auth/authPlugin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerSplitRoutes } from './routes/split.js';
import { redis } from './redis/client.js';

// Nom -> code HTTP pour les erreurs métier connues (services/*).
const ERROR_STATUS_CODES: Record<string, number> = {
  InsufficientBalanceError: 400,
  ActiveGameExistsError: 409,
  NoActiveGameError: 409,
  ActiveGameInProgressError: 409,
  SessionNotRevealedError: 400,
  LockedOperationError: 429,
};

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(fastifyRateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    redis,
  });

  await registerAuth(app);
  await registerAuthRoutes(app);
  await registerSplitRoutes(app);

  app.get('/health', async () => ({ status: 'ok' }));

  app.setErrorHandler((error, request, reply) => {
    const statusCode = ERROR_STATUS_CODES[error.name];
    if (statusCode) {
      return reply.code(statusCode).send({ error: error.name, message: error.message });
    }
    // Erreurs de validation "métier" levées par le moteur de jeu pur, non
    // sous-classées (ex: mise invalide, partie déjà terminée) : 400. Les
    // autres erreurs (Prisma, bugs internes...) restent des 500.
    if (error instanceof Error && error.name === 'Error') {
      request.log.warn({ err: error }, 'Erreur métier traitée comme 400');
      return reply.code(400).send({ error: 'bad_request', message: error.message });
    }
    request.log.error({ err: error }, 'Erreur interne');
    return reply.code(error.statusCode ?? 500).send({ error: 'internal_error', message: 'Erreur interne du serveur' });
  });

  return app;
}
