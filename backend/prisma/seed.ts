/**
 * Seed de données fictives pour le développement local.
 * Lancer avec : npm run prisma:seed
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const users = [
    { username: 'alice_demo', balance: 100_000 },
    { username: 'bob_demo', balance: 50_000 },
    { username: 'carol_demo', balance: 250_000 },
  ];

  for (const user of users) {
    await prisma.user.upsert({
      where: { username: user.username },
      update: {},
      create: user,
    });
  }

  console.log(`Seed terminé : ${users.length} joueurs fictifs créés/à jour.`);
}

main()
  .catch((error) => {
    console.error('Erreur lors du seed :', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
