/**
 * Gestion de session de seeds par joueur.
 *
 * Implémentation de référence en mémoire (Map). Utilisée par la démo CLI et
 * les tests unitaires du moteur. La version servie par l'API HTTP persiste
 * ces mêmes informations en PostgreSQL (table `seed_sessions`) et met en
 * cache la session active par joueur dans Redis — voir
 * `src/services/seedSessionService.ts`.
 */

import { randomUUID } from 'crypto';
import { generateClientSeed, generateServerSeed, hashServerSeed } from './provablyFair.js';

export interface SeedSession {
  id: string;
  userId: string;
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  isActive: boolean;
  revealedAt: Date | null;
  createdAt: Date;
}

export class SeedSessionManager {
  private sessionsByUser = new Map<string, SeedSession>();

  /** Crée (ou remplace) la session active d'un joueur. */
  createSession(userId: string, clientSeed?: string): SeedSession {
    const serverSeed = generateServerSeed();
    const session: SeedSession = {
      id: randomUUID(),
      userId,
      serverSeed,
      serverSeedHash: hashServerSeed(serverSeed),
      clientSeed: clientSeed ?? generateClientSeed(),
      nonce: 0,
      isActive: true,
      revealedAt: null,
      createdAt: new Date(),
    };
    this.sessionsByUser.set(userId, session);
    return session;
  }

  getActiveSession(userId: string): SeedSession | undefined {
    return this.sessionsByUser.get(userId);
  }

  getOrCreateSession(userId: string): SeedSession {
    return this.getActiveSession(userId) ?? this.createSession(userId);
  }

  /** Incrémente le nonce (nouvelle partie avec les mêmes seeds révélables). */
  incrementNonce(userId: string): number {
    const session = this.getOrCreateSession(userId);
    session.nonce += 1;
    return session.nonce;
  }

  /**
   * Révèle le serverSeed courant et démarre une nouvelle session avec un
   * nouveau serverSeed. Retourne l'ancienne session (révélée) et la nouvelle.
   */
  rotate(userId: string, newClientSeed?: string): { previous: SeedSession; next: SeedSession } {
    const previous = this.getActiveSession(userId);
    if (previous) {
      previous.isActive = false;
      previous.revealedAt = new Date();
    }
    const next = this.createSession(userId, newClientSeed);
    return { previous: previous ?? next, next };
  }
}

export const seedSessionManager = new SeedSessionManager();
