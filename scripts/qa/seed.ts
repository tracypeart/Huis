// Seeds a realistic (entirely made-up) firm for the full crawl, with one session cookie per role.
// Development only: never point this at a database holding real client data.
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { seal, SESSION_TTL_SECONDS } from "../../src/auth/tokens";
import { BrainWorker } from "../../src/brain/worker";
import { runMigrations } from "../../src/db/migrate";
import { HuisDb, type RequestContext } from "../../src/db/tenant";
import { MailWorker } from "../../src/mail/worker";
import { addNote, askMatter } from "../../src/services/brain";
import { createClient } from "../../src/services/clients";
import { createContact } from "../../src/services/contacts";
import { addClaimFromTemplate, addFactFromPassage, addNode, claimView, decideNode, findEvidenceFor, linkNodes, listNodes } from "../../src/services/dna";
import { assembleOriginal, getUploadSession, markChunkReceived, newEvidenceId, recordEvidence, startUpload, storeChunk } from "../../src/services/evidence";
import { connectMailbox, fileMessage, listMessages, setMatterColor } from "../../src/services/inbox";
import { addMatterMember, createMatter, linkContactToMatter, listMatterFolders, setCourtCaseNumber } from "../../src/services/matters";
import { requestCopy } from "../../src/services/workingCopies";
import { inviteUser } from "../../src/services/users";
import { MasterKeyProvider } from "../../src/storage/encryption";
import { EvidenceVault, LocalObjectStore } from "../../src/storage/store";
import { EvidenceProcessor } from "../../src/worker/processor";
import { FakeMicrosoft, mimeOf } from "../../test/fake-microsoft";
import { newFirm } from "../../test/helpers";

async function main() {
  const name = `huis_e2e_${randomBytes(3).toString("hex")}`;
  const a0 = new pg.Client({ connectionString: process.env.HUIS_QA_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5433/postgres" });
  await a0.connect(); await a0.query(`CREATE DATABASE ${name}`); await a0.end();
  const adminBase = new URL(process.env.HUIS_QA_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5433/postgres");
  const adminUrl = Object.assign(new URL(adminBase.toString()), { pathname: `/${name}` }).toString();
  await runMigrations(adminUrl);
  const pw = randomBytes(12).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE ROLE ${name}_app LOGIN PASSWORD '${pw}' NOSUPERUSER NOBYPASSRLS IN ROLE huis_app`);
  await admin.query(`CREATE ROLE ${name}_worker LOGIN PASSWORD '${pw}' NOSUPERUSER NOBYPASSRLS IN ROLE huis_worker`);
  const appUrl = `postgres://${name}_app:${pw}@${adminBase.host}/${name}`;
  const workerUrl = `postgres://${name}_worker:${pw}@${adminBase.host}/${name}`;
  const db = HuisDb.fromUrl(appUrl);
  const master = randomBytes(32).toString("base64");
  const storageDir = await mkdtemp(path.join(os.tmpdir(), "huis-crawl-vault-"));
  const vault = new EvidenceVault(new LocalObjectStore(storageDir), new MasterKeyProvider(master));

  const f = await newFirm(db);
  const x = await db.withFirm(f.owner, async (s) => {
    const client = await createClient(s, { kind: "person", displayName: "Pat Smith", email: "pat.smith@example.com" });
    const attorney = await inviteUser(s, { email: `avery@${f.slug}.example`, fullName: "Avery Attorney", role: "attorney", locationId: f.locationId });
    const para = await inviteUser(s, { email: `pp@${f.slug}.example`, fullName: "Pat Para", role: "paralegal", locationId: f.locationId });
    const reader = await inviteUser(s, { email: `rr@${f.slug}.example`, fullName: "Rae Reader", role: "read_only", locationId: f.locationId });
    const portal = await inviteUser(s, { email: `cc@${f.slug}.example`, fullName: "Casey Client", role: "client", locationId: f.locationId });
    const matter = await createMatter(s, { title: "Smith v. Acme", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT" });
    const walled = await createMatter(s, { title: "Walled settlement", clientId: client.id, leadAttorneyId: f.ownerUserId, jurisdictionState: "UT", restricted: true });
    await setMatterColor(s, matter.id, "#7c3aed");
    await setCourtCaseNumber(s, matter.id, "250901234");
    const opp = await createContact(s, { kind: "opposing_counsel", fullName: "Olivia Opposing", email: "opposing@biglaw.example" });
    await linkContactToMatter(s, matter.id, opp.id, "opposing counsel");
    return { attorney, para, reader, portal, matter, walled };
  });
  for (const u of [x.attorney, x.para, x.reader, x.portal]) await admin.query("UPDATE huis.users SET status = 'active' WHERE id = $1", [u.id]);
  await db.withFirm(f.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.attorney.id, access: "edit" }));
  await db.withFirm(f.owner, (s) => addMatterMember(s, { matterId: x.matter.id, userId: x.portal.id, access: "view", acknowledgePrivilegeWaiverRisk: true }));
  const ctx = (id: string): RequestContext => ({ firmId: f.firmId, userId: id });
  const avery = ctx(x.attorney.id);

  const up = async (who: RequestContext, matterId: string, filename: string, content: Buffer, folderId?: string) => {
    const session = await db.withFirm(who, (s) => startUpload(s, { matterId, filename, totalSize: content.length, folderId }));
    for (let i = 0; i < session.chunkCount; i++) {
      await storeChunk(vault, session, i, content.subarray(i * session.chunkSize, (i + 1) * session.chunkSize));
      await db.withFirm(who, (s) => markChunkReceived(s, session.id, i));
    }
    const fresh = await db.withFirm(who, (s) => getUploadSession(s, session.id));
    const id = newEvidenceId();
    const stored = await assembleOriginal(vault, fresh, id);
    return db.withFirm(who, (s) => recordEvidence(s, fresh, id, stored));
  };
  const letter = "Termination letter.\n\nDear Ms. Smith, your employment with Acme Corporation is terminated effective April 18, 2026. This decision follows your request for FMLA leave on April 2, 2026 for surgery.\n\nSigned, Cindy Manager, Human Resources.";
  await up(avery, x.matter.id, "termination-letter.txt", Buffer.from(letter));
  await up(avery, x.matter.id, "termination-letter-draft.txt", Buffer.from(letter.replace("Signed", "Draft — signed")));
  const pdf = await up(avery, x.matter.id, "sample.pdf", await readFile("scripts/qa/sample.pdf"));
  await up(avery, x.matter.id, "leave-request.eml", Buffer.from(["From: Cindy Manager <cindy@acme.example>", "To: Pat Smith <pat.smith@example.com>",
    "Subject: Your leave request", "Date: Thu, 02 Apr 2026 09:00:00 -0600", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="B"', "",
    "--B", "Content-Type: text/plain", "", "Pat, I received your FMLA request. The team can't afford anyone out for weeks.", "",
    "--B", 'Content-Type: text/plain; name="notes.txt"', 'Content-Disposition: attachment; filename="notes.txt"', "", "Meeting notes: March 3.", "", "--B--", ""].join("\r\n")));
  await up(f.owner, x.walled.id, "walled-memo.txt", Buffer.from("Confidential settlement memo: offer 900000."));
  const shared = (await db.withFirm(f.owner, (s) => listMatterFolders(s, x.matter.id))).find((fo) => fo.classification === "client_accessible")!;
  await up(ctx(x.portal.id), x.matter.id, "my-timeline.txt", Buffer.from("My timeline: April 2 asked for leave; April 18 fired."), shared.id);

  const pool = new pg.Pool({ connectionString: workerUrl, max: 2 });
  const scanner = { name: "test", async scan(stream: AsyncIterable<unknown>) { for await (const _ of stream) { /* drain */ } return { status: "clean" as const, detail: "No threats found" }; } };
  const processor = new EvidenceProcessor(pool, vault, scanner as never);
  await processor.drain();
  const evFolder = (await db.withFirm(avery, (s) => listMatterFolders(s, x.matter.id))).find((fo) => fo.name === "Evidence")!;
  await db.withFirm(avery, (s) => requestCopy(s, pdf.id, { redact: false, exhibitLabel: "Exhibit 1", batesPrefix: "SMITH", folderId: evFolder.id }));
  await processor.drain();

  // Mailbox (stand-in Microsoft), synced and one email filed.
  const ms = new FakeMicrosoft(); await ms.start();
  process.env.HUIS_MS_LOGIN_BASE = ms.base; process.env.HUIS_GRAPH_BASE = `${ms.base}/v1.0`;
  ms.messages = [
    { id: "M1", folder: "F-inbox", subject: "Smith v. Acme — deposition notice", from: "opposing@biglaw.example", to: ["avery@lawfirm.example"], received: "2026-10-01T15:00:00Z", body: "Deposition notice for Case No. 250901234.", mime: "" },
    { id: "M2", folder: "F-inbox", subject: "Lunch Friday?", from: "friend@example.com", to: ["avery@lawfirm.example"], received: "2026-10-02T15:00:00Z", body: "Lunch?", mime: "" },
  ];
  for (const m of ms.messages) m.mime = mimeOf(m);
  const connectionId = await db.withFirm(avery, (s) => connectMailbox(s, { provider: "microsoft", subject: "tid:oid", address: "avery@lawfirm.example", displayName: "Avery Attorney", refreshToken: "RT-1", masterKey: master }));
  const mail = new MailWorker(pool, vault, { masterKey: master, microsoft: { clientId: "c", clientSecret: "s" } });
  while (await mail.syncOnce()) { /* sync */ }
  const msg = (await db.withFirm(avery, (s) => listMessages(s, { q: "deposition" })))[0]!;
  const corr = (await db.withFirm(avery, (s) => listMatterFolders(s, x.matter.id))).find((fo) => fo.name === "Correspondence")!;
  await db.withFirm(avery, (s) => fileMessage(s, msg.id, { matterId: x.matter.id, folderId: corr.id }));
  while (await mail.fileOnce()) { /* file */ }
  ms.server.close();
  await processor.drain();

  // Matter Brain and Case DNA.
  await db.withFirm(avery, (s) => addNote(s, x.matter.id, { title: "Call with client", body: "Client says the manager joked about her surgery." }));
  const brain = new BrainWorker(pool);
  while (await brain.indexOnce()) { /* index */ }
  const answerId = await db.withFirm(avery, (s) => askMatter(s, x.matter.id, "Why was she terminated?"));
  const claimId = await db.withFirm(avery, (s) => addClaimFromTemplate(s, x.matter.id, "fmla_retaliation"));
  const el = (await db.withFirm(avery, (s) => claimView(s, claimId))).elements[0]!.element;
  const passage = (await db.withFirm(avery, (s) => findEvidenceFor(s, el.id)))[0]!;
  await db.withFirm(avery, (s) => addFactFromPassage(s, el.id, { chunkId: passage.chunkId, relation: "supports" }));
  const sug = (await db.withFirm(avery, (s) => listNodes(s, x.matter.id))).find((n) => n.status === "suggested" && n.kind === "person");
  if (sug) await db.withFirm(avery, (s) => decideNode(s, sug.id, "confirmed"));
  // Timeline: a confirmed suggested event, and an attorney's own event with categories, linked to the client.
  const event = (await db.withFirm(avery, (s) => listNodes(s, x.matter.id))).find((n) => n.status === "suggested" && n.kind === "event");
  if (event) await db.withFirm(avery, (s) => decideNode(s, event.id, "confirmed"));
  await db.withFirm(avery, async (s) => {
    const meeting = await addNode(s, x.matter.id, { kind: "event", label: "Disciplinary meeting with HR", eventDate: "2026-04-23", categories: ["employment", "defendant"] });
    const client = (await listNodes(s, x.matter.id)).find((n) => n.kind === "person" && n.status === "confirmed");
    if (client) await linkNodes(s, meeting, client.id, "involves");
  });
  // Contradictions: a deposition statement against the earlier filed email and documents.
  await up(avery, x.matter.id, "deposition-cindy-manager.txt", Buffer.from(
    "Deposition of Cindy Manager, taken June 3, 2026.\n\nQ. When did you learn about the surgery?\nA. I didn't know about her surgery until May. Nobody told me about any FMLA leave request.\n"));
  await processor.drain();
  while (await brain.indexOnce()) { /* index */ }
  await pool.end();

  const secret = randomBytes(32).toString("base64");
  const key = new Uint8Array(Buffer.from(secret, "base64"));
  const cookies: Record<string, string> = {};
  for (const [role, id] of Object.entries({ owner: f.ownerUserId, attorney: x.attorney.id, paralegal: x.para.id, read_only: x.reader.id, client: x.portal.id })) {
    const sessionVersion = await db.withFirm(ctx(id), async (s) => s.actor.sessionVersion);
    cookies[role] = await seal({ ...ctx(id), provider: "microsoft", subject: `s-${role}`, sessionVersion }, key, "session", SESSION_TTL_SECONDS);
  }
  const env = { HUIS_DATABASE_URL: appUrl, HUIS_WORKER_DATABASE_URL: workerUrl, HUIS_STORAGE_DIR: storageDir, HUIS_STORAGE_MASTER_KEY: master,
    HUIS_SESSION_SECRET: secret, HUIS_BASE_URL: "http://localhost:3100", MICROSOFT_CLIENT_ID: "c", MICROSOFT_CLIENT_SECRET: "s",
    GOOGLE_CLIENT_ID: "gc", GOOGLE_CLIENT_SECRET: "gs" };
  await writeFile(process.env.HUIS_QA_STATE ?? "qa-state.json", JSON.stringify({ env, cookies, matterId: x.matter.id, walledId: x.walled.id, answerId, claimId, connectionId, dbName: name }, null, 2));
  await admin.end();
  await db.close();
  console.log("ok");
}
main().catch((e) => { console.error(e); process.exit(1); });
