import { randomBytes } from "node:crypto";
import pg from "pg";
import { runMigrations } from "../src/db/migrate.js";
import { HuisDb, type RequestContext } from "../src/db/tenant.js";
import { signUpFirm } from "../src/services/firms.js";

/**
 * Admin connection to an existing database on the test server. CI points this
 * at its Postgres service; locally it defaults to a server on port 5433.
 */
const ADMIN_URL = process.env.HUIS_TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5433/postgres";

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

function withCredentials(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

export interface TestDatabase {
  /** Application connection: NOT superuser, NOT owner — row-level security applies. */
  db: HuisDb;
  /** Superuser connection, used only to simulate attacks such as tampering. */
  admin: pg.Pool;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `huis_test_${randomBytes(4).toString("hex")}`;
  const appUser = `${name}_app`;
  const appPassword = randomBytes(12).toString("hex");

  const server = new pg.Client({ connectionString: ADMIN_URL });
  await server.connect();
  await server.query(`CREATE DATABASE ${name}`);
  // huis_app is a cluster-wide role created by the first migration; make sure
  // it exists before granting it (CREATE ROLE is idempotent in the migration).
  await server.end();

  const adminUrl = withDatabase(ADMIN_URL, name);
  await runMigrations(adminUrl);

  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  await admin.query(`CREATE ROLE ${appUser} LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS IN ROLE huis_app`);

  const db = HuisDb.fromUrl(withCredentials(adminUrl, appUser, appPassword));

  return {
    db,
    admin,
    async drop() {
      await db.close();
      await admin.end();
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.query(`DROP ROLE IF EXISTS ${appUser}`);
      await c.end();
    },
  };
}

let firmCounter = 0;

/** Signs up a firm and returns the owner's request context. */
export async function newFirm(db: HuisDb, ownerName = "Jane Smith", state = "UT") {
  firmCounter += 1;
  const slug = `firm-${firmCounter}-${randomBytes(3).toString("hex")}`;
  const res = await signUpFirm(db, {
    firmName: `Test Firm ${firmCounter}`,
    slug,
    stateCode: state,
    ownerEmail: `owner${firmCounter}@${slug}.example`,
    ownerName,
    authProvider: "microsoft",
    authSubject: `subject-${slug}`,
  });
  const owner: RequestContext = { firmId: res.firmId, userId: res.ownerUserId };
  return { ...res, owner, slug };
}
