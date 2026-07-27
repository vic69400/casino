/**
 * Moteur provably fair générique.
 *
 * Principe : le serveur génère un `serverSeed` secret et n'en révèle que le hash
 * (SHA-256) avant la partie. Le joueur fournit (ou se voit attribuer) un
 * `clientSeed`. Chaque tirage est dérivé d'un HMAC-SHA256(serverSeed, "clientSeed:nonce:round"),
 * ce qui rend le résultat impossible à prédire à l'avance (le serverSeed est secret)
 * et vérifiable après coup (une fois le serverSeed révélé, n'importe qui peut
 * recalculer le HMAC et confirmer qu'il correspond au résultat annoncé).
 */

import { createHash, createHmac, randomBytes } from 'crypto';

export type Side = 'left' | 'right';

export interface RoundHmacInput {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  roundNumber: number;
}

/** Génère un serverSeed secret (256 bits). */
export function generateServerSeed(): string {
  return randomBytes(32).toString('hex');
}

/** Génère un clientSeed par défaut (peut être remplacé par le joueur). */
export function generateClientSeed(): string {
  return randomBytes(16).toString('hex');
}

/** Hash public du serverSeed, communiqué au joueur avant la partie. */
export function hashServerSeed(serverSeed: string): string {
  return createHash('sha256').update(serverSeed).digest('hex');
}

/**
 * Message canonique combinant clientSeed, nonce (identifie la session de seeds)
 * et numéro de round. Le nonce change à chaque rotation de seed, le round
 * number à chaque tirage au sein d'une même partie.
 */
function buildMessage(clientSeed: string, nonce: number, roundNumber: number): string {
  return `${clientSeed}:${nonce}:${roundNumber}`;
}

/** Calcule le HMAC-SHA256(serverSeed, message) pour un round donné. */
export function computeRoundHmac(input: RoundHmacInput): string {
  const message = buildMessage(input.clientSeed, input.nonce, input.roundNumber);
  return createHmac('sha256', input.serverSeed).update(message).digest('hex');
}

/**
 * Convertit les 8 premiers caractères hex du HMAC (32 bits) en un flottant [0, 1).
 * On ne consomme qu'une partie du HMAC : le reste peut servir à dériver d'autres
 * valeurs (multi-outcome) sans avoir à recalculer un nouveau HMAC.
 */
export function hmacToFloat(hmac: string): number {
  const chunk = hmac.slice(0, 8);
  const int = parseInt(chunk, 16);
  return int / 0x100000000;
}

/**
 * Détermine le côté "sûr" pour ce round à partir du HMAC.
 * Distribution ~50/50 par construction (borne à 0.5 sur un flottant uniforme).
 */
export function determineSafeSide(hmac: string): Side {
  return hmacToFloat(hmac) < 0.5 ? 'left' : 'right';
}

/** Calcule directement le côté sûr d'un round à partir des seeds/nonce/round. */
export function computeSafeSide(input: RoundHmacInput): { hmac: string; safeSide: Side } {
  const hmac = computeRoundHmac(input);
  return { hmac, safeSide: determineSafeSide(hmac) };
}

/**
 * Vérification indépendante d'un round : recalcule le HMAC à partir des seeds
 * révélés et confirme qu'il correspond au HMAC et au côté sûr annoncés.
 */
export function verifyRound(
  input: RoundHmacInput,
  expected: { hmac: string; safeSide: Side },
): boolean {
  const { hmac, safeSide } = computeSafeSide(input);
  return hmac === expected.hmac && safeSide === expected.safeSide;
}

/** Vérifie que serverSeedHash = SHA-256(serverSeed), preuve que le seed n'a pas changé après coup. */
export function verifyServerSeedHash(serverSeed: string, serverSeedHash: string): boolean {
  return hashServerSeed(serverSeed) === serverSeedHash;
}
