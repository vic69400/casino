/**
 * Service de gestion des sessions de seeds, persistées en PostgreSQL et
 * mises en cache dans Redis (clé `seed:active:{userId}`) pour éviter une
 * lecture DB à chaque round. Le nonce est fixe pour toute la durée de vie
 * d'une session (jusqu'à rotation) ; le round_number, lui, est monotone sur
 * toute la session (voir `getNextRoundNumber`) afin que chaque round joué,
 * même dans des parties différentes, ait un HMAC distinct.
 */

import type { SeedSession as SeedSessionRow } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { redis } from '../redis/client.js';
import { generateClientSeed, generateServerSeed, hashServerSeed } from '../provably-fair/provablyFair.js';

export interface ActiveSeedSession {
  id: string;
  userId: string;
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
}

export interface PublicSeedSessionInfo {
  id: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  isActive: boolean;
  revealedAt: string | null;
}

export class ActiveGameInProgressError extends Error {
  constructor() {
    super('Impossible de faire tourner les seeds : une partie est en cours');
    this.name = 'ActiveGameInProgressError';
  }
}

export class SessionNotRevealedError extends Error {
  constructor() {
    super('Cette session est encore active : le serverSeed ne peut pas être révélé');
    this.name = 'SessionNotRevealedError';
  }
}

const cacheKey = (userId: string) => `seed:active:${userId}`;
const CACHE_TTL_SECONDS = 60 * 60 * 6;

function toActiveSession(row: SeedSessionRow): ActiveSeedSession {
  return {
    id: row.id,
    userId: row.userId,
    serverSeed: row.serverSeed,
    serverSeedHash: row.serverSeedHash,
    clientSeed: row.clientSeed,
    nonce: row.nonce,
  };
}

async function cacheSession(session: ActiveSeedSession): Promise<void> {
  await redis.set(cacheKey(session.userId), JSON.stringify(session), 'EX', CACHE_TTL_SECONDS);
}

async function invalidateCache(userId: string): Promise<void> {
  await redis.del(cacheKey(userId));
}

/** Récupère la session active du joueur, ou en crée une nouvelle si aucune n'existe. */
export async function getOrCreateActiveSession(userId: string): Promise<ActiveSeedSession> {
  const cached = await redis.get(cacheKey(userId));
  if (cached) {
    return JSON.parse(cached) as ActiveSeedSession;
  }

  let row = await prisma.seedSession.findFirst({
    where: { userId, isActive: true },
    orderBy: { createdAt: 'desc' },
  });

  if (!row) {
    const serverSeed = generateServerSeed();
    row = await prisma.seedSession.create({
      data: {
        userId,
        serverSeed,
        serverSeedHash: hashServerSeed(serverSeed),
        clientSeed: generateClientSeed(),
        nonce: 0,
        isActive: true,
      },
    });
  }

  const session = toActiveSession(row);
  await cacheSession(session);
  return session;
}

/**
 * Calcule le prochain round_number à utiliser pour cette session (monotone
 * sur toute la durée de vie de la session, même entre plusieurs parties).
 */
export async function getNextRoundNumber(sessionId: string): Promise<number> {
  const aggregate = await prisma.gameRound.aggregate({
    where: { sessionId },
    _max: { roundNumber: true },
  });
  return (aggregate._max.roundNumber ?? 0) + 1;
}

/**
 * Révèle la session active (serverSeed en clair) et en crée une nouvelle.
 * Refuse si une partie est en cours pour ce joueur.
 */
export async function rotateSession(
  userId: string,
  newClientSeed?: string,
): Promise<{ previous: (PublicSeedSessionInfo & { serverSeed: string }) | null; next: PublicSeedSessionInfo }> {
  const activeGame = await prisma.gameHistory.findFirst({ where: { userId, status: 'active' } });
  if (activeGame) {
    throw new ActiveGameInProgressError();
  }

  const { previousRow, nextRow } = await prisma.$transaction(async (tx) => {
    const previous = await tx.seedSession.findFirst({ where: { userId, isActive: true } });
    if (previous) {
      await tx.seedSession.update({
        where: { id: previous.id },
        data: { isActive: false, revealedAt: new Date() },
      });
    }

    const serverSeed = generateServerSeed();
    const next = await tx.seedSession.create({
      data: {
        userId,
        serverSeed,
        serverSeedHash: hashServerSeed(serverSeed),
        clientSeed: newClientSeed ?? generateClientSeed(),
        nonce: (previous?.nonce ?? -1) + 1,
        isActive: true,
      },
    });

    return { previousRow: previous, nextRow: next };
  });

  await invalidateCache(userId);
  await cacheSession(toActiveSession(nextRow));

  return {
    // null si le joueur n'avait encore jamais eu de session active (rien à révéler).
    previous: previousRow
      ? {
          id: previousRow.id,
          serverSeed: previousRow.serverSeed,
          serverSeedHash: previousRow.serverSeedHash,
          clientSeed: previousRow.clientSeed,
          nonce: previousRow.nonce,
          isActive: false,
          revealedAt: new Date().toISOString(),
        }
      : null,
    next: {
      id: nextRow.id,
      serverSeedHash: nextRow.serverSeedHash,
      clientSeed: nextRow.clientSeed,
      nonce: nextRow.nonce,
      isActive: true,
      revealedAt: null,
    },
  };
}

/** Infos publiques de la session courante d'un joueur (jamais le serverSeed en clair si active). */
export async function getPublicSessionInfo(userId: string): Promise<PublicSeedSessionInfo> {
  const session = await getOrCreateActiveSession(userId);
  return {
    id: session.id,
    serverSeedHash: session.serverSeedHash,
    clientSeed: session.clientSeed,
    nonce: session.nonce,
    isActive: true,
    revealedAt: null,
  };
}

/** Récupère une session révélée (isActive=false) avec tous ses rounds, pour vérification publique. */
export async function getRevealedSessionWithRounds(sessionId: string) {
  const session = await prisma.seedSession.findUnique({
    where: { id: sessionId },
    include: { rounds: { orderBy: { roundNumber: 'asc' } } },
  });

  if (!session) {
    return null;
  }
  if (session.isActive) {
    throw new SessionNotRevealedError();
  }
  return session;
}

export async function invalidateActiveSessionCache(userId: string): Promise<void> {
  await invalidateCache(userId);
}
