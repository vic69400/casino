/**
 * Client Redis partagé. Utilisé pour :
 * - mettre en cache la session de seeds active et l'état de partie en cours
 *   par joueur (évite de recalculer/relire la DB à chaque round) ;
 * - servir de store pour le rate limiting (`@fastify/rate-limit`) ;
 * - poser des verrous courts par joueur pour éviter les races conditions
 *   (double cash-out, double débit).
 */

import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});
