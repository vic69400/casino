/**
 * Moteur du jeu "Split".
 *
 * Règle : le joueur mise un montant puis choisit GAUCHE ou DROITE à chaque
 * round. Un seul côté est "sûr" (déterminé par HMAC-SHA256, voir
 * `provably-fair/provablyFair.ts`). Bon choix -> le multiplicateur cumulé est
 * multiplié par `roundMultiplier` (1.94 par défaut, house edge ~3% sur un
 * jeu 50/50) et le joueur peut continuer ou cash-out. Mauvais choix -> perte
 * totale de la mise, partie terminée.
 *
 * Ce module est pur / sans effet de bord (aucun accès DB ou réseau) : il ne
 * fait que transformer un état de partie en un nouvel état. La couche API
 * (`src/services/splitService.ts`) est responsable de la persistance.
 */

import { computeSafeSide, RoundHmacInput, Side, verifyRound as verifyRoundHmac } from '../../provably-fair/provablyFair.js';

export const DEFAULT_ROUND_MULTIPLIER = 1.94;

export type GameStatus = 'active' | 'busted' | 'cashed_out';

export interface RoundResult {
  roundNumber: number;
  chosenSide: Side;
  safeSide: Side;
  survived: boolean;
  hmac: string;
  cumulativeMultiplierAfter: number;
}

export interface SplitGameState {
  /** Identifiant de la session de seeds utilisée pour cette partie. */
  sessionId: string;
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  roundMultiplier: number;
  betAmount: number;
  /** Numéro du prochain round à jouer. */
  roundNumber: number;
  cumulativeMultiplier: number;
  status: GameStatus;
  history: RoundResult[];
}

export interface StartGameParams {
  sessionId: string;
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  betAmount: number;
  roundMultiplier?: number;
  /**
   * Numéro du premier round de cette partie. Le nonce est fixe pour toute la
   * durée de vie d'une session de seeds (jusqu'à rotation) ; le roundNumber,
   * lui, doit rester unique sur toute la session pour garantir un HMAC
   * distinct par round, y compris entre deux parties successives jouées avec
   * la même session. Par défaut 1 (première partie de la session).
   */
  startingRoundNumber?: number;
}

/** Démarre une nouvelle partie : mise validée, aucun round joué encore. */
export function startGame(params: StartGameParams): SplitGameState {
  if (!Number.isFinite(params.betAmount) || params.betAmount <= 0) {
    throw new Error('betAmount doit être un nombre strictement positif');
  }
  return {
    sessionId: params.sessionId,
    serverSeed: params.serverSeed,
    clientSeed: params.clientSeed,
    nonce: params.nonce,
    roundMultiplier: params.roundMultiplier ?? DEFAULT_ROUND_MULTIPLIER,
    betAmount: params.betAmount,
    roundNumber: params.startingRoundNumber ?? 1,
    cumulativeMultiplier: 1,
    status: 'active',
    history: [],
  };
}

/** Joue un round : le joueur choisit un côté, le côté sûr est révélé par HMAC. */
export function playRound(state: SplitGameState, chosenSide: Side): {
  state: SplitGameState;
  result: RoundResult;
} {
  if (state.status !== 'active') {
    throw new Error('La partie est déjà terminée');
  }

  const hmacInput: RoundHmacInput = {
    serverSeed: state.serverSeed,
    clientSeed: state.clientSeed,
    nonce: state.nonce,
    roundNumber: state.roundNumber,
  };
  const { hmac, safeSide } = computeSafeSide(hmacInput);
  const survived = chosenSide === safeSide;
  const cumulativeMultiplierAfter = survived
    ? round2(state.cumulativeMultiplier * state.roundMultiplier)
    : 0;

  const result: RoundResult = {
    roundNumber: state.roundNumber,
    chosenSide,
    safeSide,
    survived,
    hmac,
    cumulativeMultiplierAfter,
  };

  const nextState: SplitGameState = {
    ...state,
    roundNumber: state.roundNumber + 1,
    cumulativeMultiplier: survived ? cumulativeMultiplierAfter : state.cumulativeMultiplier,
    status: survived ? 'active' : 'busted',
    history: [...state.history, result],
  };

  return { state: nextState, result };
}

/** Cash-out volontaire : clôture la partie et calcule le gain final. */
export function cashOut(state: SplitGameState): { state: SplitGameState; payout: number } {
  if (state.status !== 'active') {
    throw new Error('Impossible de cash-out : la partie est déjà terminée');
  }
  if (state.history.length === 0) {
    throw new Error('Impossible de cash-out avant d\'avoir survécu à au moins un round');
  }
  const payout = Math.floor(state.betAmount * state.cumulativeMultiplier);
  const nextState: SplitGameState = { ...state, status: 'cashed_out' };
  return { state: nextState, payout };
}

/** Vérification indépendante d'un round déjà joué (seeds révélés). */
export function verifyRound(
  input: RoundHmacInput,
  expected: { hmac: string; safeSide: Side },
): boolean {
  return verifyRoundHmac(input, expected);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
