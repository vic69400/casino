/**
 * Démo CLI de référence : joue une partie complète de Split en mémoire,
 * affiche chaque round, cash-out (ou bust), puis révèle le serverSeed et
 * vérifie indépendamment tous les rounds joués.
 *
 * Lancer avec : npx tsx src/games/split/demo.ts
 */

import { seedSessionManager } from '../../provably-fair/seedSession.js';
import { verifyRound } from '../../provably-fair/provablyFair.js';
import { cashOut, playRound, startGame } from './splitGame.js';

function main() {
  const userId = 'demo-user';
  const session = seedSessionManager.getOrCreateSession(userId);

  console.log('--- Nouvelle partie Split ---');
  console.log('serverSeedHash (public) :', session.serverSeedHash);
  console.log('clientSeed              :', session.clientSeed);
  console.log('nonce                   :', session.nonce);

  let state = startGame({
    sessionId: session.id,
    serverSeed: session.serverSeed,
    clientSeed: session.clientSeed,
    nonce: session.nonce,
    betAmount: 100,
  });

  const choices: Array<'left' | 'right'> = ['left', 'right', 'left', 'right', 'left'];

  for (const choice of choices) {
    if (state.status !== 'active') break;
    const { state: nextState, result } = playRound(state, choice);
    state = nextState;
    console.log(
      `Round ${result.roundNumber} : choix=${result.chosenSide} sûr=${result.safeSide} ` +
        `${result.survived ? 'SURVIVED' : 'BUSTED'} multiplicateur=${result.cumulativeMultiplierAfter}x`,
    );
  }

  if (state.status === 'active') {
    const { payout } = cashOut(state);
    console.log(`Cash-out volontaire : mise=${state.betAmount} payout=${payout}`);
  } else {
    console.log('Partie perdue, mise non récupérée.');
  }

  // Révélation du serverSeed et vérification indépendante de chaque round.
  const { previous } = seedSessionManager.rotate(userId);
  console.log('\n--- Vérification indépendante ---');
  console.log('serverSeed révélé :', previous.serverSeed);

  const allValid = state.history.every((round) =>
    verifyRound(
      {
        serverSeed: previous.serverSeed,
        clientSeed: previous.clientSeed,
        nonce: previous.nonce,
        roundNumber: round.roundNumber,
      },
      { hmac: round.hmac, safeSide: round.safeSide },
    ),
  );
  console.log('Tous les rounds sont valides :', allValid);
}

main();
