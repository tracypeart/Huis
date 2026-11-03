import pg from "pg";

/**
 * Runs once before all test files. Test files run in parallel, each creating
 * its own database; the Huis roles are shared by the whole Postgres server,
 * so create them here first, or two migrations can race to create them.
 */
export default async function setup() {
  const c = new pg.Client({ connectionString: process.env.HUIS_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5433/postgres" });
  await c.connect();
  try {
    for (const [role, attrs] of [["huis_app", "NOLOGIN NOBYPASSRLS"], ["huis_security", "NOLOGIN BYPASSRLS"], ["huis_worker", "NOLOGIN NOBYPASSRLS"]] as const) {
      const exists = (await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount;
      if (!exists) await c.query(`CREATE ROLE ${role} ${attrs}`);
    }
  } finally {
    await c.end();
  }
}
