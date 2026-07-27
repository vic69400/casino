# Split — Casino provably fair (B2B)

Split est un jeu de casino "choix binaire en cascade" : le joueur mise, puis choisit
GAUCHE ou DROITE à chaque round. Un seul côté est sûr, déterminé par un HMAC-SHA256
provably fair — impossible à prédire à l'avance, vérifiable après coup. Bon choix →
le multiplicateur cumulé augmente (x1.94 par défaut) et le joueur peut continuer ou
cash-out. Mauvais choix → perte totale de la mise.

Ce dépôt contient le moteur de jeu, l'API backend (Fastify + Prisma + PostgreSQL +
Redis) et le frontend (React + Vite + Tailwind).

> ⚠️ Aucune transaction financière réelle : les soldes joueurs sont des entiers
> simulés en base de données. Aucune intégration wallet crypto n'est incluse à ce
> stade.

## Structure du dépôt

```
backend/    API Fastify, moteur de jeu, schéma Prisma, tests
frontend/   Application React (jeu + page de vérification d'équité)
docs/       Documentation d'intégration B2B
docker-compose.yml   PostgreSQL + Redis pour le développement local
```

## Prérequis

- Node.js ≥ 20
- Docker + Docker Compose (pour PostgreSQL et Redis)

## Setup local

### 1. Démarrer PostgreSQL et Redis

```bash
docker-compose up -d
```

Cela expose PostgreSQL sur `localhost:5432` (base `split`, user/mdp `split`/`split`)
et Redis sur `localhost:6379`.

### 2. Backend

```bash
cd backend
cp .env.example .env
npm install
npm run prisma:migrate   # crée les tables (users, seed_sessions, game_rounds, game_history)
npm run prisma:seed      # crée quelques joueurs fictifs (alice_demo, bob_demo, carol_demo)
npm run dev               # démarre l'API sur http://localhost:3001
```

Vérifier que l'API répond : `curl http://localhost:3001/health` → `{"status":"ok"}`.

### 3. Frontend

Dans un second terminal :

```bash
cd frontend
npm install
npm run dev   # démarre l'app sur http://localhost:5173
```

Le serveur de dev Vite fait proxy des requêtes `/api/*` vers `http://localhost:3001`
(voir `frontend/vite.config.ts`), donc aucune configuration supplémentaire n'est
nécessaire en local.

### 4. Jouer

Ouvrir `http://localhost:5173`, entrer un pseudo (connexion de démo sans mot de
passe — voir `POST /api/auth/dev-login`), miser, choisir GAUCHE/DROITE, cash-out.
La page "Vérifier l'équité" permet de vérifier indépendamment n'importe quelle
session révélée (entrer son `sessionId`, obtenu via `POST /api/split/session/rotate`).

## Tests

```bash
cd backend

# Tests unitaires du moteur de jeu (aucune dépendance externe)
npm test

# Tests d'intégration des endpoints (nécessite Postgres + Redis démarrés
# et le schéma migré, voir étape 1-2 ci-dessus)
npm run test:integration
```

Le moteur de démo CLI (`backend/src/games/split/demo.ts`) peut être lancé
indépendamment pour rejouer une partie complète en mémoire et voir la
vérification indépendante s'exécuter :

```bash
cd backend && npm run demo
```

## Architecture

- **Moteur provably fair** (`backend/src/provably-fair/`) : génération de seeds,
  HMAC-SHA256 déterministe, vérification. Pur, sans effet de bord.
- **Moteur Split** (`backend/src/games/split/splitGame.ts`) : logique de jeu pure
  (démarrage, round, cash-out, calcul du multiplicateur). Ne touche ni la DB ni le
  réseau — testé unitairement de façon isolée.
- **Services** (`backend/src/services/`) : orchestrent le moteur pur, PostgreSQL
  (Prisma, transactionnel) et Redis (cache des seeds actifs et de l'état de partie
  en cours, verrou par joueur pour éviter les races conditions).
- **API Fastify** (`backend/src/routes/`, `backend/src/app.ts`) : validation stricte
  (zod), auth JWT (stub de dev), rate limiting (`@fastify/rate-limit`, store Redis).
- **Frontend** (`frontend/src/`) : page de jeu + page de vérification d'équité
  indépendante, Tailwind, mobile-first.

Voir `docs/INTEGRATION.md` pour la documentation destinée à un futur casino-client
(intégration API, format des réponses, vérification côté joueur).

## Limites connues

- L'authentification est un stub de développement (`POST /api/auth/dev-login`
  émet un JWT à partir d'un simple pseudo, sans mot de passe). En production, ce
  plugin serait remplacé par le véritable IdP de l'opérateur (voir
  `backend/src/auth/authPlugin.ts`).
- Le cache Redis de l'état de partie est une optimisation de lecture ; en cas
  d'expiration (TTL 2h), l'état est reconstruit à partir des rounds déjà persistés
  en base (voir `loadActiveGame` dans `backend/src/services/splitService.ts`).
