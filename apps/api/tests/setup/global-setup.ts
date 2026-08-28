import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { adminDatabaseUrl, applyTestEnv, testDatabaseUrl } from "./test-env.js";

/**
 * Creates the test database if it does not exist and brings it up to the
 * current migration. Runs once per `vitest` invocation.
 */
export default async function setup(): Promise<void> {
  applyTestEnv();

  const admin = new PrismaClient({ datasourceUrl: adminDatabaseUrl() });
  try {
    const dbName = new URL(testDatabaseUrl()).pathname.replace(/^\//, "");
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  } catch (error) {
    const message = (error as Error).message;
    if (!message.includes("already exists")) throw error;
  } finally {
    await admin.$disconnect();
  }

  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
  });
}
