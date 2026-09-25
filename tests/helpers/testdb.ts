import { SQL } from "bun";

function baseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is required to run integration tests (set it in .env)"
    );
  }
  return url;
}

function withSearchPath(base: string, schema: string): string {
  const option = `options=-csearch_path%3D${schema}`;
  return base.includes("?") ? `${base}&${option}` : `${base}?${option}`;
}

function adminClient(): SQL {
  return new SQL(baseUrl());
}

export async function recreateTestSchema(schema: string): Promise<void> {
  const admin = adminClient();
  try {
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }
}

export async function dropTestSchema(schema: string): Promise<void> {
  const admin = adminClient();
  try {
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await admin.end();
  }
}

export function testClient(schema: string): SQL {
  return new SQL(withSearchPath(baseUrl(), schema));
}
