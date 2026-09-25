import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./client";
import { log } from "../logger";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

const APPLIED_MARKER = "CATEGORY_MIGRATION_APPLIED";

export async function runMigrations(db: Db): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  const files = entries
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  const applied: string[] = [];

  for (const file of files) {
    const body = await Bun.file(join(MIGRATIONS_DIR, file)).text();
    await db.begin(async (tx) => {
      await tx.unsafe(body);
    });
    applied.push(file);
    log(APPLIED_MARKER, { file });
  }

  return applied;
}