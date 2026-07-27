/**
 * Verrou court par joueur (SET NX PX) pour sérialiser les opérations
 * mutant le solde ou l'état de partie (start / round / cashout / rotate).
 * Évite les races conditions type double cash-out ou double débit en cas
 * de requêtes concurrentes sur le même joueur.
 */

import { redis } from './client.js';

const LOCK_TTL_MS = 5000;

export class LockedOperationError extends Error {
  constructor() {
    super('Une opération est déjà en cours pour ce joueur, réessayez.');
    this.name = 'LockedOperationError';
  }
}

export async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const key = `lock:game:${userId}`;
  const token = Math.random().toString(36).slice(2);
  const acquired = await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) {
    throw new LockedOperationError();
  }
  try {
    return await fn();
  } finally {
    // Ne libère le verrou que si on le détient toujours (évite de supprimer
    // le verrou d'une autre requête si le nôtre a expiré entre-temps).
    const current = await redis.get(key);
    if (current === token) {
      await redis.del(key);
    }
  }
}
