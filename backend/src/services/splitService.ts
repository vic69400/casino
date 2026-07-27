/**
 * Service applicatif du jeu Split : orchestre le moteur pur
 * (`games/split/splitGame.ts`), la persistance PostgreSQL (Prisma) et le
 * cache Redis de l'état de partie en cours. Toute mutation de solde est
 * exécutée dans une transaction Prisma ; toute opération est sérialisée par
 * joueur via un verrou Redis (`withUserLock`) pour éviter les races
 * conditions (double cash-out, double débit).
 */

import type { Side } from '../provably-fair/provablyFair.js';
import * as engine from '../games/split/splitGame.js';
import { prisma } from '../db/prisma.js';
import { redis } from '../redis/client.js';
import { withUserLock } from '../redis/lock.js';
import { getNextRoundNumber, getOrCreateActiveSession } from './seedSessionService.js';

interface CachedGame {
  gameHistoryId: string;
  state: engine.SplitGameState;
}

function getRoundMultiplier(): number {
  const configured = Number(process.env.SPLIT_ROUND_MULTIPLIER);
  return Number.isFinite(configured) && configured > 1 ? configured : engine.DEFAULT_ROUND_MULTIPLIER;
}

export class NoActiveGameError extends Error {
  constructor() {
    super("Aucune partie en cours pour ce joueur");
    this.name = 'NoActiveGameError';
  }
}

export class ActiveGameExistsError extends Error {
  constructor() {
    super('Une partie est déjà en cours, terminez-la avant d\'en démarrer une nouvelle');
    this.name = 'ActiveGameExistsError';
  }
}

export class InsufficientBalanceError extends Error {
  constructor() {
    super('Solde insuffisant pour cette mise');
    this.name = 'InsufficientBalanceError';
  }
}

const gameCacheKey = (userId: string) => `game:active:${userId}`;
const GAME_TTL_SECONDS = 60 * 60 * 2;

async function saveActiveGame(userId: string, game: CachedGame): Promise<void> {
  await redis.set(gameCacheKey(userId), JSON.stringify(game), 'EX', GAME_TTL_SECONDS);
}

async function clearActiveGame(userId: string): Promise<void> {
  await redis.del(gameCacheKey(userId));
}

/**
 * Charge l'état de la partie en cours depuis Redis. Si le cache a expiré,
 * reconstruit l'état à partir des rounds déjà persistés en base (le cache
 * n'est qu'une optimisation de lecture, la DB reste la source de vérité).
 */
async function loadActiveGame(userId: string): Promise<CachedGame> {
  const cached = await redis.get(gameCacheKey(userId));
  if (cached) {
    return JSON.parse(cached) as CachedGame;
  }

  const gameHistory = await prisma.gameHistory.findFirst({ where: { userId, status: 'active' } });
  if (!gameHistory) {
    throw new NoActiveGameError();
  }

  const session = await prisma.seedSession.findUniqueOrThrow({ where: { id: gameHistory.seedSessionId } });
  const rounds = await prisma.gameRound.findMany({
    where: { gameHistoryId: gameHistory.id },
    orderBy: { roundNumber: 'asc' },
  });

  const firstRoundNumber = rounds[0]?.roundNumber ?? (await getNextRoundNumber(session.id));
  let state = engine.startGame({
    sessionId: session.id,
    serverSeed: session.serverSeed,
    clientSeed: session.clientSeed,
    nonce: session.nonce,
    betAmount: gameHistory.betAmount,
    startingRoundNumber: firstRoundNumber,
    roundMultiplier: getRoundMultiplier(),
  });

  for (const round of rounds) {
    state = { ...state, roundNumber: round.roundNumber };
    const { state: next } = engine.playRound(state, round.chosenSide as Side);
    state = next;
  }

  const game: CachedGame = { gameHistoryId: gameHistory.id, state };
  await saveActiveGame(userId, game);
  return game;
}

export interface StartGameResult {
  gameId: string;
  balance: number;
  roundNumber: number;
  cumulativeMultiplier: number;
  status: engine.GameStatus;
}

export async function startGame(userId: string, betAmount: number): Promise<StartGameResult> {
  return withUserLock(userId, async () => {
    const existingGame = await prisma.gameHistory.findFirst({ where: { userId, status: 'active' } });
    if (existingGame) {
      throw new ActiveGameExistsError();
    }

    const session = await getOrCreateActiveSession(userId);
    const startingRoundNumber = await getNextRoundNumber(session.id);

    const { user, gameHistory } = await prisma.$transaction(async (tx) => {
      const currentUser = await tx.user.findUnique({ where: { id: userId } });
      if (!currentUser || currentUser.balance < betAmount) {
        throw new InsufficientBalanceError();
      }

      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: { balance: { decrement: betAmount } },
      });

      const newGameHistory = await tx.gameHistory.create({
        data: {
          userId,
          gameType: 'split',
          betAmount,
          payout: 0,
          multiplierFinal: 1,
          status: 'active',
          seedSessionId: session.id,
        },
      });

      return { user: updatedUser, gameHistory: newGameHistory };
    });

    const state = engine.startGame({
      sessionId: session.id,
      serverSeed: session.serverSeed,
      clientSeed: session.clientSeed,
      nonce: session.nonce,
      betAmount,
      startingRoundNumber,
      roundMultiplier: getRoundMultiplier(),
    });

    await saveActiveGame(userId, { gameHistoryId: gameHistory.id, state });

    return {
      gameId: gameHistory.id,
      balance: user.balance,
      roundNumber: state.roundNumber,
      cumulativeMultiplier: state.cumulativeMultiplier,
      status: state.status,
    };
  });
}

export interface PlayRoundResult {
  roundNumber: number;
  chosenSide: Side;
  safeSide: Side;
  survived: boolean;
  cumulativeMultiplier: number;
  status: engine.GameStatus;
}

export async function playRound(userId: string, direction: Side): Promise<PlayRoundResult> {
  return withUserLock(userId, async () => {
    const game = await loadActiveGame(userId);

    const { state: nextState, result } = engine.playRound(game.state, direction);

    await prisma.gameRound.create({
      data: {
        sessionId: nextState.sessionId,
        gameHistoryId: game.gameHistoryId,
        gameType: 'split',
        betAmount: nextState.betAmount,
        roundNumber: result.roundNumber,
        chosenSide: result.chosenSide,
        safeSide: result.safeSide,
        survived: result.survived,
        hmac: result.hmac,
      },
    });

    if (!result.survived) {
      await prisma.gameHistory.update({
        where: { id: game.gameHistoryId },
        data: { status: 'busted', payout: 0, multiplierFinal: nextState.cumulativeMultiplier },
      });
      await clearActiveGame(userId);
    } else {
      await saveActiveGame(userId, { gameHistoryId: game.gameHistoryId, state: nextState });
    }

    return {
      roundNumber: result.roundNumber,
      chosenSide: result.chosenSide,
      safeSide: result.safeSide,
      survived: result.survived,
      cumulativeMultiplier: nextState.cumulativeMultiplier,
      status: nextState.status,
    };
  });
}

export interface CashOutResult {
  payout: number;
  balance: number;
  cumulativeMultiplier: number;
}

export async function cashOut(userId: string): Promise<CashOutResult> {
  return withUserLock(userId, async () => {
    const game = await loadActiveGame(userId);
    const { state: finalState, payout } = engine.cashOut(game.state);

    const user = await prisma.$transaction(async (tx) => {
      await tx.gameHistory.update({
        where: { id: game.gameHistoryId },
        data: { status: 'cashed_out', payout, multiplierFinal: finalState.cumulativeMultiplier },
      });
      return tx.user.update({
        where: { id: userId },
        data: { balance: { increment: payout } },
      });
    });

    await clearActiveGame(userId);

    return { payout, balance: user.balance, cumulativeMultiplier: finalState.cumulativeMultiplier };
  });
}
