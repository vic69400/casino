/**
 * Plugin d'authentification.
 *
 * Stub JWT pour le développement local : un token signé contient
 * simplement { sub: userId, username }. En production, ce plugin serait
 * remplacé par la vérification de tokens émis par le véritable IdP de
 * l'opérateur de casino (OAuth2/OIDC), sans changer la surface exposée aux
 * routes (`request.authUserId`).
 */

import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    authUserId?: string;
  }
}

export interface JwtPayload {
  sub: string;
  username: string;
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  await app.register(fastifyJwt, {
    secret: process.env.JWT_SECRET ?? 'change-me-in-production',
  });

  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = await request.jwtVerify<JwtPayload>();
      request.authUserId = payload.sub;
    } catch {
      reply.code(401).send({ error: 'unauthorized', message: 'Token manquant ou invalide' });
    }
  });
}

/** Vérifie que le userId ciblé par la requête correspond au token authentifié. */
export function assertOwnUser(request: FastifyRequest, targetUserId: string): boolean {
  return request.authUserId === targetUserId;
}
