# Intégration de Split — guide technique casino-client

Ce document décrit comment un opérateur de casino intègre le jeu Split via l'API
backend, et comment ses joueurs (ou son équipe conformité) peuvent vérifier
indépendamment l'équité de chaque partie.

## 1. Modèle d'intégration

Split est livré comme une API stateless (côté client HTTP) : l'opérateur héberge
son propre frontend (ou utilise/adapte le nôtre) et consomme l'API de jeu. Les
soldes joueurs affichés dans ce dépôt sont simulés en base de données à titre de
démonstration ; en intégration réelle, l'opérateur reste responsable du portefeuille
joueur (crédit/débit) via son propre système, ou délègue au backend Split selon les
modalités contractuelles convenues.

## 2. Authentification

Toutes les routes de jeu exigent un token JWT (`Authorization: Bearer <token>`)
dont le payload contient l'identifiant du joueur (`sub`). Dans ce dépôt de
démonstration, `POST /api/auth/dev-login` émet un token de test à partir d'un
simple pseudo — **ce endpoint est un stub de développement et ne doit jamais être
exposé en production**. En intégration réelle, l'opérateur fournit ses propres
tokens (émis par son IdP), et le backend Split est configuré pour vérifier ces
tokens avec la clé publique/secret partagée de l'opérateur (voir
`backend/src/auth/authPlugin.ts` — le point d'extension est isolé pour ne pas
impacter les routes).

L'API ne fait jamais confiance à un `userId` fourni dans le corps de la requête :
l'identité du joueur est systématiquement dérivée du token vérifié.

## 3. Cycle de vie d'une partie

```
POST /api/split/start     { betAmount }              → débite la mise, démarre la partie
POST /api/split/round     { direction: 'left'|'right'} → joue un round
POST /api/split/cashout    (aucun body)                → clôture volontairement, crédite le gain
```

Une seule partie active à la fois par joueur. `POST /api/split/start` renvoie
`409 ActiveGameExistsError` si une partie est déjà en cours.

### Réponses

`POST /api/split/start` → `200`
```json
{
  "gameId": "…",
  "balance": 900,
  "roundNumber": 1,
  "cumulativeMultiplier": 1,
  "status": "active"
}
```

`POST /api/split/round` → `200`
```json
{
  "roundNumber": 1,
  "chosenSide": "left",
  "safeSide": "left",
  "survived": true,
  "cumulativeMultiplier": 1.94,
  "status": "active"
}
```
`status` passe à `"busted"` dès qu'un mauvais choix est fait (`survived: false`,
mise perdue, aucun crédit).

`POST /api/split/cashout` → `200`
```json
{
  "payout": 194,
  "balance": 1094,
  "cumulativeMultiplier": 1.94
}
```

### Codes d'erreur

| Code | Cas |
|------|-----|
| 400  | Corps de requête invalide (mise négative/nulle, direction invalide, etc.) |
| 401  | Token manquant ou invalide |
| 403  | `userId` demandé (route `/session/:userId`) différent du token authentifié |
| 409  | Partie déjà en cours (`/start`) ou aucune partie en cours (`/round`, `/cashout`) |
| 429  | Rate limit dépassé (`/start`, `/round`) ou opération concurrente verrouillée |

## 4. Provably fair — le mécanisme

Chaque joueur a une **session de seeds** active :

- `serverSeed` : 256 bits générés côté serveur, **secret** tant que la session est
  active.
- `serverSeedHash` = SHA-256(serverSeed) : publié immédiatement, avant toute partie.
- `clientSeed` : généré par défaut, ou personnalisable par le joueur (transparence
  totale : le joueur peut influencer l'aléa).
- `nonce` : fixe pour la durée de vie de la session.
- `roundNumber` : identifiant de round, unique et croissant sur toute la durée de
  vie de la session (même à travers plusieurs parties successives, tant que la
  session n'est pas révélée).

Pour chaque round :

```
hmac = HMAC-SHA256(key = serverSeed, message = `${clientSeed}:${nonce}:${roundNumber}`)
safeSide = (premiers 32 bits de hmac, interprétés comme un flottant [0,1)) < 0.5 ? 'left' : 'right'
```

Le `serverSeed` étant secret et non manipulable une fois la partie commencée
(`serverSeedHash` publié à l'avance verrouille son contenu), aucune partie —
opérateur inclus — ne peut prédire ni influencer le résultat d'un round à
l'avance.

### Endpoints de transparence

`GET /api/split/session/:userId` (authentifié, joueur propriétaire uniquement)
```json
{
  "id": "…",
  "serverSeedHash": "…",
  "clientSeed": "…",
  "nonce": 0,
  "isActive": true,
  "revealedAt": null
}
```
Ne renvoie **jamais** `serverSeed` tant que `isActive` est `true`.

`POST /api/split/session/rotate` (authentifié) : révèle le `serverSeed` de la
session courante et en démarre une nouvelle. Utilisable à tout moment entre deux
parties (refuse avec `409` si une partie est en cours).
```json
{
  "revealed": {
    "sessionId": "…", "serverSeed": "…", "serverSeedHash": "…", "clientSeed": "…", "nonce": 0
  },
  "next": { "id": "…", "serverSeedHash": "…", "clientSeed": "…", "nonce": 1, "isActive": true, "revealedAt": null }
}
```

`GET /api/split/verify/:sessionId` (**public, aucune authentification**) :
recalcule le HMAC de chaque round de la session révélée et confirme sa validité.
C'est l'endpoint que le joueur (ou un régulateur/auditeur) utilise pour vérifier
indépendamment l'équité, exactement comme la page "provably fair" de Stake.
```json
{
  "sessionId": "…",
  "serverSeed": "…",
  "serverSeedHash": "…",
  "clientSeed": "…",
  "nonce": 0,
  "revealedAt": "2026-07-27T10:00:00.000Z",
  "allRoundsValid": true,
  "rounds": [
    { "roundNumber": 1, "chosenSide": "left", "safeSide": "left", "survived": true, "hmac": "…", "valid": true }
  ]
}
```

### Vérification côté joueur, pas à pas

1. Récupérer `serverSeedHash` avant de jouer (`GET /session/:userId`) et le
   conserver (capture d'écran, copie).
2. Jouer normalement.
3. Après avoir cash-out ou perdu, appeler `POST /session/rotate` pour révéler le
   `serverSeed`.
4. Vérifier que `SHA-256(serverSeed) === serverSeedHash` capturé à l'étape 1 (cela
   prouve que le serverSeed n'a pas été changé après coup).
5. Appeler `GET /verify/:sessionId` (ou recalculer soi-même côté client avec
   `HMAC-SHA256`) et confirmer que chaque round annoncé correspond au HMAC recalculé.

Toute la logique de recalcul tient en quelques lignes et peut être ré-implémentée
indépendamment dans n'importe quel langage — c'est la garantie que l'opérateur peut
mettre en avant auprès de ses propres joueurs et régulateurs.

## 5. Rate limiting et abus

`POST /api/split/start` et `POST /api/split/round` sont limités à 15 requêtes /
10 secondes par IP (voir `STRICT_RATE_LIMIT` dans `backend/src/routes/split.ts`),
en plus d'une limite globale de 100 req/min. Le store est Redis (partagé entre
instances si l'API est répliquée horizontalement).

## 6. Paramétrage du house edge

Le multiplicateur par round survécu est configurable (`SPLIT_ROUND_MULTIPLIER`,
1.94 par défaut ≈ 3% de house edge sur un jeu 50/50). Toute modification de ce
paramètre s'applique aux nouvelles parties uniquement (les parties en cours
gardent le multiplicateur avec lequel elles ont démarré).
