/**
 * Client Prisma partagé (singleton) pour toute l'application.
 */

import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
