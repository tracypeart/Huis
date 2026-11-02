import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);

/**
 * Applies pending SQL migrations in filename order, each in its own
 * transaction. Must run as the schema owner / admin connection, never as the
 * application role. Refuses to continue if an applied migration was edited.
 */
export async function runMigrations(connectionString: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.huis_schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Map<string, string>(
      (await client.query<{ name: string; checksum: string }>(
        "SELECT name, checksum FROM public.huis_schema_migrations",
      )).rows.map((r) => [r.name, r.checksum]),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = done.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(`Migration ${file} was changed after it was applied. Add a new migration instead.`);
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO public.huis_schema_migrations (name, checksum) VALUES ($1, $2)",
          [file, checksum],
        );
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.HUIS_MIGRATION_DATABASE_URL;
  if (!url) {
    console.error("HUIS_MIGRATION_DATABASE_URL is not set");
    process.exit(1);
  }
  runMigrations(url)
    .then((applied) => console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date"))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
