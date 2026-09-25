import { SQL } from "bun";

export type Db = SQL;

export function createClient(databaseUrl: string): Db {
  return new SQL(databaseUrl);
}

export function closeClient(db: Db): Promise<void> {
  return db.end();
}