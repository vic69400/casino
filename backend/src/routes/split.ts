/**
 * Routes REST du jeu Split.
 *
 * Toutes les routes de jeu (`/start`, `/round`, `/cashout`, `/session/rotate`)
 * exigent un token JWT valide ; l'userId est TOUJOURS dérivé du token
 * authentifié, jamais d'un champ de la requête, ce qui élimine par
 * construction tout risque de usurpation d'un autre joueur. La route
 * `GET /session/:userId` vérifie explicitement que le userId demandé
 * correspond au token. `GET /verify/:sessionId` est publique (aucune
 * authentification requise) : c'est l'argument de confiance B2B du jeu.
 */

import type { FastifyInstance } from 'fastify';
import { assertOwnUser } from '../auth/authPlugin.js';
import { verifyRound } from '../provably-fair/provablyFair.js';
import {
  getPublicSessionInfo,
  getRevealedSessionWithRounds,
  rotateSession,
} from '../services/seedSessionService.js';
import { cashOut, playRound, startGame } from '../services/splitService.js';
import {
  playRoundSchema,
  rotateSessionSchema,
  sessionIdParamSchema,
  startGameSchema,
  userIdParamSchema,
} from '../schemas/split.js';

const STRICT_RATE_LIMIT = { max: 15, timeWindow: '10 seconds' };

export async function registerSplitRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/split/start',
    { preHandler: [app.authenticate], config: { rateLimit: STRICT_RATE_LIMIT } },
    async (request, reply) => {
      const parsed = startGameSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }

      const userId = request.authUserId!;
      const result = await startGame(userId, parsed.data.betAmount);
      return reply.send(result);
    },
  );

  app.post(
    '/api/split/round',
    { preHandler: [app.authenticate], config: { rateLimit: STRICT_RATE_LIMIT } },
    async (request, reply) => {
      const parsed = playRoundSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }

      const userId = request.authUserId!;
      const result = await playRound(userId, parsed.data.direction);
      return reply.send(result);
    },
  );

  app.post('/api/split/cashout', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = request.authUserId!;
    const result = await cashOut(userId);
    return reply.send(result);
  });

  app.get('/api/split/session/:userId', { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = userIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_params', issues: parsed.error.issues });
    }
    if (!assertOwnUser(request, parsed.data.userId)) {
      return reply.code(403).send({ error: 'forbidden', message: "Vous ne pouvez consulter que votre propre session" });
    }

    const session = await getPublicSessionInfo(parsed.data.userId);
    return reply.send(session);
  });

  app.post('/api/split/session/rotate', { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = rotateSessionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }

    const userId = request.authUserId!;
    const { previous, next } = await rotateSession(userId, parsed.data.clientSeed);
    return reply.send({
      revealed: previous
        ? {
            sessionId: previous.id,
            serverSeed: previous.serverSeed,
            serverSeedHash: previous.serverSeedHash,
            clientSeed: previous.clientSeed,
            nonce: previous.nonce,
          }
        : null,
      next,
    });
  });

  // Endpoint public : aucune authentification, c'est l'argument de confiance
  // "provably fair" que n'importe qui (joueur, auditeur, régulateur) peut
  // utiliser pour vérifier indépendamment une session révélée.
  app.get('/api/split/verify/:sessionId', async (request, reply) => {
    const parsed = sessionIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_params', issues: parsed.error.issues });
    }

    const session = await getRevealedSessionWithRounds(parsed.data.sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'not_found', message: 'Session inconnue' });
    }

    const rounds = session.rounds.map((round) => {
      const isValid = verifyRound(
        {
          serverSeed: session.serverSeed,
          clientSeed: session.clientSeed,
          nonce: session.nonce,
          roundNumber: round.roundNumber,
        },
        { hmac: round.hmac, safeSide: round.safeSide as 'left' | 'right' },
      );
      return {
        roundNumber: round.roundNumber,
        chosenSide: round.chosenSide,
        safeSide: round.safeSide,
        survived: round.survived,
        hmac: round.hmac,
        valid: isValid,
      };
    });

    return reply.send({
      sessionId: session.id,
      serverSeed: session.serverSeed,
      serverSeedHash: session.serverSeedHash,
      clientSeed: session.clientSeed,
      nonce: session.nonce,
      revealedAt: session.revealedAt,
      allRoundsValid: rounds.every((r) => r.valid),
      rounds,
    });
  });
}
