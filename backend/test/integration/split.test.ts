/**
 * Tests d'intégration légers sur les endpoints critiques de l'API Split.
 *
 * Nécessite une base PostgreSQL et un Redis disponibles (voir
 * `docker-compose.yml` à la racine + `DATABASE_URL`/`REDIS_URL`) et le
 * schéma migré (`npm run prisma:migrate`). Lancer avec :
 *   npm run test:integration
 *
 * Pour rendre les rounds déterministes sans exposer le serverSeed via
 * l'API, les tests forcent directement en base les seeds de la session
 * active du joueur de test, puis recalculent le côté sûr attendu avec le
 * même moteur provably fair que le serveur.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';
import { redis } from '../../src/redis/client.js';
import { computeSafeSide, hashServerSeed } from '../../src/provably-fair/provablyFair.js';

const TEST_SERVER_SEED = 'integration-test-server-seed';
const TEST_CLIENT_SEED = 'integration-test-client-seed';
const ROUND_MULTIPLIER = 1.94;

describe('API Split - tests d\'intégration', () => {
  let app: FastifyInstance;
  let token: string;
  let userId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await redis.quit();
  });

  function authHeader() {
    return { authorization: `Bearer ${token}` };
  }

  async function forceKnownSeeds() {
    // Déclenche la création paresseuse d'une session de seeds si nécessaire.
    await app.inject({ method: 'GET', url: `/api/split/session/${userId}`, headers: authHeader() });
    await prisma.seedSession.updateMany({
      where: { userId, isActive: true },
      data: {
        serverSeed: TEST_SERVER_SEED,
        serverSeedHash: hashServerSeed(TEST_SERVER_SEED),
        clientSeed: TEST_CLIENT_SEED,
      },
    });
    await redis.del(`seed:active:${userId}`);
  }

  async function expectedSafeSideForRound(roundNumber: number) {
    const session = await prisma.seedSession.findFirstOrThrow({ where: { userId, isActive: true } });
    return computeSafeSide({
      serverSeed: TEST_SERVER_SEED,
      clientSeed: TEST_CLIENT_SEED,
      nonce: session.nonce,
      roundNumber,
    }).safeSide;
  }

  beforeEach(async () => {
    const username = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/dev-login',
      payload: { username },
    });
    expect(loginRes.statusCode).toBe(200);
    const body = loginRes.json();
    token = body.token;
    userId = body.userId;

    await prisma.user.update({ where: { id: userId }, data: { balance: 1000 } });
    await forceKnownSeeds();
  });

  it('valide strictement les entrées (400 sur mise négative, direction invalide)', async () => {
    const badBet = await app.inject({
      method: 'POST',
      url: '/api/split/start',
      headers: authHeader(),
      payload: { betAmount: -10 },
    });
    expect(badBet.statusCode).toBe(400);

    const badDirection = await app.inject({
      method: 'POST',
      url: '/api/split/round',
      headers: authHeader(),
      payload: { direction: 'up' },
    });
    expect(badDirection.statusCode).toBe(400);
  });

  it('refuse de démarrer une partie si le solde est insuffisant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/split/start',
      headers: authHeader(),
      payload: { betAmount: 5000 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('démarre une partie (débit de la mise), joue un round gagnant, puis cash-out (crédit du gain)', async () => {
    const startRes = await app.inject({
      method: 'POST',
      url: '/api/split/start',
      headers: authHeader(),
      payload: { betAmount: 100 },
    });
    expect(startRes.statusCode).toBe(200);
    expect(startRes.json().balance).toBe(900);

    const safeSide = await expectedSafeSideForRound(1);
    const roundRes = await app.inject({
      method: 'POST',
      url: '/api/split/round',
      headers: authHeader(),
      payload: { direction: safeSide },
    });
    expect(roundRes.statusCode).toBe(200);
    const roundBody = roundRes.json();
    expect(roundBody.survived).toBe(true);
    expect(roundBody.cumulativeMultiplier).toBeCloseTo(ROUND_MULTIPLIER, 5);

    const cashoutRes = await app.inject({
      method: 'POST',
      url: '/api/split/cashout',
      headers: authHeader(),
    });
    expect(cashoutRes.statusCode).toBe(200);
    const cashoutBody = cashoutRes.json();
    expect(cashoutBody.payout).toBe(Math.floor(100 * ROUND_MULTIPLIER));
    expect(cashoutBody.balance).toBe(900 + cashoutBody.payout);
  });

  it('un mauvais choix termine la partie sans remboursement et empêche un nouveau cash-out', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/split/start',
      headers: authHeader(),
      payload: { betAmount: 100 },
    });

    const safeSide = await expectedSafeSideForRound(1);
    const wrongSide = safeSide === 'left' ? 'right' : 'left';

    const roundRes = await app.inject({
      method: 'POST',
      url: '/api/split/round',
      headers: authHeader(),
      payload: { direction: wrongSide },
    });
    const roundBody = roundRes.json();
    expect(roundBody.survived).toBe(false);
    expect(roundBody.status).toBe('busted');

    const cashoutRes = await app.inject({
      method: 'POST',
      url: '/api/split/cashout',
      headers: authHeader(),
    });
    expect(cashoutRes.statusCode).toBe(409);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.balance).toBe(900);
  });

  it('refuse de démarrer une seconde partie tant que la précédente est active', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/split/start',
      headers: authHeader(),
      payload: { betAmount: 100 },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/split/start',
      headers: authHeader(),
      payload: { betAmount: 100 },
    });
    expect(second.statusCode).toBe(409);
  });

  it("refuse l'accès à la session d'un autre joueur", async () => {
    const otherLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/dev-login',
      payload: { username: `other_${Date.now()}` },
    });
    const otherUserId = otherLogin.json().userId;

    const res = await app.inject({
      method: 'GET',
      url: `/api/split/session/${otherUserId}`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(403);
  });

  it('rotate révèle le serverSeed et /verify confirme tous les rounds joués', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/split/start',
      headers: authHeader(),
      payload: { betAmount: 100 },
    });
    const safeSide = await expectedSafeSideForRound(1);
    await app.inject({
      method: 'POST',
      url: '/api/split/round',
      headers: authHeader(),
      payload: { direction: safeSide },
    });
    await app.inject({ method: 'POST', url: '/api/split/cashout', headers: authHeader() });

    const rotateRes = await app.inject({
      method: 'POST',
      url: '/api/split/session/rotate',
      headers: authHeader(),
      payload: {},
    });
    expect(rotateRes.statusCode).toBe(200);
    const rotateBody = rotateRes.json();
    expect(rotateBody.revealed.serverSeed).toBe(TEST_SERVER_SEED);

    const verifyRes = await app.inject({
      method: 'GET',
      url: `/api/split/verify/${rotateBody.revealed.sessionId}`,
    });
    expect(verifyRes.statusCode).toBe(200);
    const verifyBody = verifyRes.json();
    expect(verifyBody.allRoundsValid).toBe(true);
    expect(verifyBody.rounds).toHaveLength(1);
    expect(verifyBody.rounds[0].survived).toBe(true);
  });

  it('/verify refuse une session encore active (serverSeed non révélé)', async () => {
    const session = await prisma.seedSession.findFirstOrThrow({ where: { userId, isActive: true } });
    const res = await app.inject({ method: 'GET', url: `/api/split/verify/${session.id}` });
    expect(res.statusCode).toBe(400);
  });
});
