/**
 * Tests unitaires du moteur Split et du moteur provably fair sous-jacent.
 */

import { describe, expect, it } from 'vitest';
import {
  computeRoundHmac,
  computeSafeSide,
  determineSafeSide,
  generateClientSeed,
  generateServerSeed,
  hashServerSeed,
  hmacToFloat,
  verifyRound as verifyRoundHmac,
  verifyServerSeedHash,
} from '../../provably-fair/provablyFair.js';
import { cashOut, DEFAULT_ROUND_MULTIPLIER, playRound, startGame } from './splitGame.js';

const SEED = 'test-server-seed';
const CLIENT_SEED = 'test-client-seed';

describe('provablyFair - déterminisme du RNG', () => {
  it('produit toujours le même HMAC pour les mêmes seeds/nonce/round', () => {
    const input = { serverSeed: SEED, clientSeed: CLIENT_SEED, nonce: 0, roundNumber: 1 };
    const hmac1 = computeRoundHmac(input);
    const hmac2 = computeRoundHmac(input);
    expect(hmac1).toBe(hmac2);
  });

  it('produit un résultat différent si le round change', () => {
    const base = { serverSeed: SEED, clientSeed: CLIENT_SEED, nonce: 0 };
    const hmac1 = computeRoundHmac({ ...base, roundNumber: 1 });
    const hmac2 = computeRoundHmac({ ...base, roundNumber: 2 });
    expect(hmac1).not.toBe(hmac2);
  });

  it('produit un résultat différent si le serverSeed change', () => {
    const a = computeRoundHmac({ serverSeed: 'seed-a', clientSeed: CLIENT_SEED, nonce: 0, roundNumber: 1 });
    const b = computeRoundHmac({ serverSeed: 'seed-b', clientSeed: CLIENT_SEED, nonce: 0, roundNumber: 1 });
    expect(a).not.toBe(b);
  });

  it('hashServerSeed est déterministe et vérifiable', () => {
    const seed = generateServerSeed();
    const hash = hashServerSeed(seed);
    expect(verifyServerSeedHash(seed, hash)).toBe(true);
    expect(verifyServerSeedHash('un-autre-seed', hash)).toBe(false);
  });

  it('génère des seeds de longueur cohérente', () => {
    expect(generateServerSeed()).toMatch(/^[0-9a-f]{64}$/);
    expect(generateClientSeed()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('provablyFair - distribution ~50/50', () => {
  it('la répartition gauche/droite converge vers 50/50 sur un grand nombre de tirages', () => {
    const N = 20000;
    let leftCount = 0;
    for (let round = 0; round < N; round++) {
      const hmac = computeRoundHmac({ serverSeed: SEED, clientSeed: CLIENT_SEED, nonce: round, roundNumber: 1 });
      if (determineSafeSide(hmac) === 'left') leftCount++;
    }
    const ratio = leftCount / N;
    // tolérance large pour éviter la flakiness tout en détectant un biais réel
    expect(ratio).toBeGreaterThan(0.47);
    expect(ratio).toBeLessThan(0.53);
  });

  it('hmacToFloat retourne toujours une valeur dans [0, 1)', () => {
    for (let round = 0; round < 1000; round++) {
      const hmac = computeRoundHmac({ serverSeed: SEED, clientSeed: CLIENT_SEED, nonce: round, roundNumber: 1 });
      const value = hmacToFloat(hmac);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('splitGame - démarrage de partie', () => {
  it('rejette une mise négative ou nulle', () => {
    const base = { sessionId: 's1', serverSeed: SEED, clientSeed: CLIENT_SEED, nonce: 0 };
    expect(() => startGame({ ...base, betAmount: 0 })).toThrow();
    expect(() => startGame({ ...base, betAmount: -50 })).toThrow();
  });

  it('initialise un multiplicateur cumulé de 1 et le statut "active"', () => {
    const state = startGame({ sessionId: 's1', serverSeed: SEED, clientSeed: CLIENT_SEED, nonce: 0, betAmount: 100 });
    expect(state.cumulativeMultiplier).toBe(1);
    expect(state.status).toBe('active');
    expect(state.roundNumber).toBe(1);
    expect(state.roundMultiplier).toBe(DEFAULT_ROUND_MULTIPLIER);
  });
});

describe('splitGame - calcul du multiplicateur cumulé', () => {
  it('multiplie le multiplicateur cumulé par roundMultiplier à chaque survie', () => {
    let state = startGame({ sessionId: 's1', serverSeed: SEED, clientSeed: CLIENT_SEED, nonce: 0, betAmount: 100 });

    // On force plusieurs rounds jusqu'à trouver 3 rounds survécus consécutifs
    // en essayant les deux côtés (déterministe car seeds fixes).
    let survivedRounds = 0;
    let guardRounds = 0;
    while (survivedRounds < 3 && guardRounds < 50) {
      const { safeSide } = computeSafeSide({
        serverSeed: state.serverSeed,
        clientSeed: state.clientSeed,
        nonce: state.nonce,
        roundNumber: state.roundNumber,
      });
      const before = state.cumulativeMultiplier;
      const { state: nextState, result } = playRound(state, safeSide);
      state = nextState;
      expect(result.survived).toBe(true);
      expect(result.cumulativeMultiplierAfter).toBeCloseTo(before * DEFAULT_ROUND_MULTIPLIER, 6);
      survivedRounds++;
      guardRounds++;
    }
    expect(state.cumulativeMultiplier).toBeCloseTo(DEFAULT_ROUND_MULTIPLIER ** 3, 6);
  });

  it('remet la mise à zéro (multiplicateur figé) en cas de mauvais choix', () => {
    let state = startGame({ sessionId: 's1', serverSeed: SEED, clientSeed: CLIENT_SEED, nonce: 0, betAmount: 100 });
    const { safeSide } = computeSafeSide({
      serverSeed: state.serverSeed,
      clientSeed: state.clientSeed,
      nonce: state.nonce,
      roundNumber: state.roundNumber,
    });
    const wrongSide = safeSide === 'left' ? 'right' : 'left';
    const { state: nextState, result } = playRound(state, wrongSide);
    expect(result.survived).toBe(false);
    expect(result.cumulativeMultiplierAfter).toBe(0);
    expect(nextState.status).toBe('busted');
    // le multiplicateur affiché reste celui d'avant le bust (perte totale de la mise, pas du multiplicateur affiché)
    expect(nextState.cumulativeMultiplier).toBe(1);
  });

  it('calcule le payout correct au cash-out', () => {
    let state = startGame({ sessionId: 's1', serverSeed: SEED, clientSeed: CLIENT_SEED, nonce: 0, betAmount: 100 });
    const { safeSide } = computeSafeSide({
      serverSeed: state.serverSeed,
      clientSeed: state.clientSeed,
      nonce: state.nonce,
      roundNumber: state.roundNumber,
    });
    const { state: afterRound } = playRound(state, safeSide);
    const { payout } = cashOut(afterRound);
    expect(payout).toBe(Math.floor(100 * DEFAULT_ROUND_MULTIPLIER));
  });

  it('refuse le cash-out avant le premier round', () => {
    const state = startGame({ sessionId: 's1', serverSeed: SEED, clientSeed: CLIENT_SEED, nonce: 0, betAmount: 100 });
    expect(() => cashOut(state)).toThrow();
  });

  it('refuse de jouer un round sur une partie déjà terminée', () => {
    let state = startGame({ sessionId: 's1', serverSeed: SEED, clientSeed: CLIENT_SEED, nonce: 0, betAmount: 100 });
    const { safeSide } = computeSafeSide({
      serverSeed: state.serverSeed,
      clientSeed: state.clientSeed,
      nonce: state.nonce,
      roundNumber: state.roundNumber,
    });
    const wrongSide = safeSide === 'left' ? 'right' : 'left';
    const { state: busted } = playRound(state, wrongSide);
    expect(() => playRound(busted, 'left')).toThrow();
  });
});

describe('splitGame - vérification indépendante', () => {
  it('valide un round dont les données correspondent aux seeds révélés', () => {
    let state = startGame({ sessionId: 's1', serverSeed: SEED, clientSeed: CLIENT_SEED, nonce: 0, betAmount: 100 });
    const { result } = playRound(state, 'left');

    const isValid = verifyRoundHmac(
      { serverSeed: SEED, clientSeed: CLIENT_SEED, nonce: 0, roundNumber: result.roundNumber },
      { hmac: result.hmac, safeSide: result.safeSide },
    );
    expect(isValid).toBe(true);
  });

  it('échoue si le serverSeed révélé ne correspond pas', () => {
    let state = startGame({ sessionId: 's1', serverSeed: SEED, clientSeed: CLIENT_SEED, nonce: 0, betAmount: 100 });
    const { result } = playRound(state, 'left');

    const isValid = verifyRoundHmac(
      { serverSeed: 'seed-falsifie', clientSeed: CLIENT_SEED, nonce: 0, roundNumber: result.roundNumber },
      { hmac: result.hmac, safeSide: result.safeSide },
    );
    expect(isValid).toBe(false);
  });

  it('échoue si le hmac ou le safeSide annoncé a été altéré', () => {
    let state = startGame({ sessionId: 's1', serverSeed: SEED, clientSeed: CLIENT_SEED, nonce: 0, betAmount: 100 });
    const { result } = playRound(state, 'left');

    const tamperedSide = result.safeSide === 'left' ? 'right' : 'left';
    const isValid = verifyRoundHmac(
      { serverSeed: SEED, clientSeed: CLIENT_SEED, nonce: 0, roundNumber: result.roundNumber },
      { hmac: result.hmac, safeSide: tamperedSide },
    );
    expect(isValid).toBe(false);

    const isValid2 = verifyRoundHmac(
      { serverSeed: SEED, clientSeed: CLIENT_SEED, nonce: 0, roundNumber: result.roundNumber },
      { hmac: 'deadbeef'.repeat(8), safeSide: result.safeSide },
    );
    expect(isValid2).toBe(false);
  });
});
