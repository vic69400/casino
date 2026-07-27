/**
 * Point d'entrée du serveur HTTP.
 */

import { buildApp } from './app.js';

const PORT = Number(process.env.PORT ?? 3001);

async function main() {
  const app = await buildApp();
  await app.listen({ port: PORT, host: '0.0.0.0' });
}

main().catch((error) => {
  console.error('Échec du démarrage du serveur :', error);
  process.exit(1);
});
