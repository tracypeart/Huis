import { z } from "zod";
import type { FirmSession } from "../db/tenant";
import { NotFoundError, PermissionDeniedError } from "../errors";
import { INTERNAL_ROLES, ADMIN_ROLES } from "../security/permissions";
import { AI_CATEGORIES, BUILT_IN_PROMPTS, builtInPrompt, type AiCategory } from "../ai/prompts";
import { recordAudit } from "./audit";
import { askMatter, getAnswer, type BrainAnswer } from "./brain";
import { getMatter } from "./matters";

/**
 * AI Workspace: saved conversations inside a Matter (a series of Matter Brain
 * questions and answers, with a category), private to their owner unless
 * shared with the Matter's firm staff; and the Prompt Library (personal, firm
 * and built-in prompts).
 *
 * Work product: firm staff only. The database decides who sees a
 * conversation, and shows each answer only while every source it drew on is
 * available to the person reading it, so sharing never reveals a document
 * someone can't open. The audit log records what kind of change was made,
 * never titles, questions, answers or prompt wording.
 */

const uuid = z.uuid();
function staff(s: FirmSession, what: string) {
  if (!INTERNAL_ROLES.has(s.actor.role)) throw new PermissionDeniedError(what);
}

export interface Conversation {
  id: string; matterId: string; title: string; category: AiCategory; shared: boolean; mine: boolean; ownerName: string;
  createdAt: Date; updatedAt: Date; answers: number;
}

const CONV_COLS = `c.id, c.matter_id, c.title, c.category, c.shared, c.owner_id, coalesce(u.full_name, 'Former user') AS owner_name,
  c.created_at, c.updated_at, (SELECT count(*)::int FROM huis.brain_answers a WHERE a.conversation_id = c.id) AS answers`;
const toConversation = (s: FirmSession, r: Record<string, unknown>): Conversation => ({
  id: r.id as string, matterId: r.matter_id as string, title: r.title as string, category: r.category as AiCategory, shared: r.shared as boolean,
  mine: r.owner_id === s.actor.userId, ownerName: r.owner_name as string, createdAt: r.created_at as Date, updatedAt: r.updated_at as Date,
  answers: r.answers as number,
});

const conversationInput = z.object({
  title: z.string().trim().min(1).max(200),
  category: z.enum(AI_CATEGORIES),
});

/** The person's own conversations in the Matter, and those colleagues shared. */
export async function listConversations(s: FirmSession, matterId: string, category?: unknown): Promise<Conversation[]> {
  staff(s, "use the AI Workspace");
  await getMatter(s, matterId);
  const cat = z.enum(AI_CATEGORIES).safeParse(category);
  const { rows } = await s.client.query(
    `SELECT ${CONV_COLS} FROM huis.ai_conversations c LEFT JOIN huis.users u ON u.id = c.owner_id
      WHERE c.matter_id = $1 ${cat.success ? "AND c.category = $2" : ""} ORDER BY c.updated_at DESC LIMIT 500`,
    cat.success ? [matterId, cat.data] : [matterId]);
  return rows.map((r) => toConversation(s, r));
}

export async function createConversation(s: FirmSession, matterId: string, input: unknown): Promise<string> {
  staff(s, "use the AI Workspace");
  await getMatter(s, matterId);
  const v = conversationInput.parse(input);
  const id = (await s.client.query<{ id: string }>(
    "INSERT INTO huis.ai_conversations (firm_id, matter_id, owner_id, title, category) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [s.actor.firmId, matterId, s.actor.userId, v.title, v.category])).rows[0]!.id;
  await recordAudit(s, "ai.conversation_created", { targetType: "matter", targetId: matterId, matterId, metadata: { category: v.category } });
  return id;
}

async function conversation(s: FirmSession, id: unknown): Promise<Conversation> {
  if (!uuid.safeParse(id).success) throw new NotFoundError("Conversation");
  const r = (await s.client.query(
    `SELECT ${CONV_COLS} FROM huis.ai_conversations c LEFT JOIN huis.users u ON u.id = c.owner_id WHERE c.id = $1`, [id])).rows[0];
  if (!r) throw new NotFoundError("Conversation");
  return toConversation(s, r);
}
async function myConversation(s: FirmSession, id: unknown): Promise<Conversation> {
  const c = await conversation(s, id);
  // Someone else's (shared) conversation can be read but not changed: as if it weren't there to change.
  if (!c.mine) throw new NotFoundError("Conversation");
  return c;
}

export interface ConversationView {
  conversation: Conversation;
  answers: BrainAnswer[];
  /** Answers withheld from this reader (a source isn't available to them). */
  hidden: number;
}

export async function getConversation(s: FirmSession, id: string): Promise<ConversationView> {
  staff(s, "use the AI Workspace");
  const c = await conversation(s, id);
  const ids = (await s.client.query<{ id: string }>(
    "SELECT id FROM huis.brain_answers WHERE conversation_id = $1 ORDER BY created_at, id LIMIT 500", [c.id])).rows.map((r) => r.id);
  const answers: BrainAnswer[] = [];
  for (const answerId of ids) answers.push(await getAnswer(s, answerId));
  const total = (await s.client.query<{ n: number }>("SELECT huis.ai_conversation_answer_count($1) AS n", [c.id])).rows[0]?.n ?? 0;
  return { conversation: { ...c, answers: ids.length }, answers, hidden: Math.max(0, total - ids.length) };
}

/** The next question in one's own conversation. */
export async function askInConversation(s: FirmSession, id: string, question: unknown): Promise<string> {
  staff(s, "use the AI Workspace");
  const c = await myConversation(s, id);
  const answerId = await askMatter(s, c.matterId, question, c.id);
  await s.client.query("UPDATE huis.ai_conversations SET updated_at = now() WHERE id = $1", [c.id]);
  return answerId;
}

/** Renames, recategorizes, or shares / stops sharing one's own conversation. */
export async function updateConversation(s: FirmSession, id: string, input: unknown): Promise<void> {
  staff(s, "use the AI Workspace");
  const c = await myConversation(s, id);
  const v = conversationInput.extend({ shared: z.boolean() }).parse(input);
  await s.client.query("UPDATE huis.ai_conversations SET title = $2, category = $3, shared = $4 WHERE id = $1", [c.id, v.title, v.category, v.shared]);
  const action = v.shared === c.shared ? "ai.conversation_changed" : v.shared ? "ai.conversation_shared" : "ai.conversation_unshared";
  await recordAudit(s, action, { targetType: "matter", targetId: c.matterId, matterId: c.matterId, metadata: { category: v.category } });
}

/** Deletes one's own conversation and every answer in it. */
export async function deleteConversation(s: FirmSession, id: string): Promise<string> {
  staff(s, "use the AI Workspace");
  const c = await myConversation(s, id);
  await s.client.query("DELETE FROM huis.ai_conversations WHERE id = $1", [c.id]);
  await recordAudit(s, "ai.conversation_deleted", { targetType: "matter", targetId: c.matterId, matterId: c.matterId });
  return c.matterId;
}

// ---------------------------------------------------------------------------
// Prompt Library
// ---------------------------------------------------------------------------
export interface Prompt {
  /** "huis:<key>" for built-in prompts, else the prompt's id. */
  id: string; scope: "huis" | "firm" | "personal"; title: string; body: string; category: AiCategory; canEdit: boolean;
}

const promptInput = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(2000),
  category: z.enum(AI_CATEGORIES),
});

export async function listPrompts(s: FirmSession): Promise<Prompt[]> {
  staff(s, "use the Prompt Library");
  const admin = ADMIN_ROLES.has(s.actor.role);
  const { rows } = await s.client.query(
    "SELECT id, scope, title, body, category FROM huis.ai_prompts ORDER BY scope, category, title LIMIT 2000");
  return [
    ...BUILT_IN_PROMPTS.map((p) => ({ id: `huis:${p.key}`, scope: "huis" as const, title: p.title, body: p.body, category: p.category, canEdit: false })),
    ...rows.map((r) => ({
      id: r.id, scope: r.scope, title: r.title, body: r.body, category: r.category, canEdit: r.scope === "personal" || admin,
    })),
  ];
}

/** One prompt the person may use (built-in, the firm's, or their own). */
export async function getPrompt(s: FirmSession, id: string): Promise<Prompt | null> {
  staff(s, "use the Prompt Library");
  const b = builtInPrompt(id);
  if (b) return { id, scope: "huis", title: b.title, body: b.body, category: b.category, canEdit: false };
  if (!uuid.safeParse(id).success) return null;
  const r = (await s.client.query("SELECT id, scope, title, body, category FROM huis.ai_prompts WHERE id = $1", [id])).rows[0];
  return r ? { id: r.id, scope: r.scope, title: r.title, body: r.body, category: r.category, canEdit: r.scope === "personal" || ADMIN_ROLES.has(s.actor.role) } : null;
}

/** A personal prompt (anyone on staff), or a firm prompt (firm administrators). */
export async function createPrompt(s: FirmSession, input: unknown): Promise<string> {
  staff(s, "use the Prompt Library");
  const v = promptInput.extend({ scope: z.enum(["personal", "firm"]) }).parse(input);
  if (v.scope === "firm" && !ADMIN_ROLES.has(s.actor.role)) throw new PermissionDeniedError("add firm prompts");
  const id = (await s.client.query<{ id: string }>(
    `INSERT INTO huis.ai_prompts (firm_id, scope, owner_id, created_by, title, body, category) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [s.actor.firmId, v.scope, v.scope === "personal" ? s.actor.userId : null, s.actor.userId, v.title, v.body, v.category])).rows[0]!.id;
  await recordAudit(s, "ai.prompt_created", { targetType: "prompt", targetId: id, metadata: { scope: v.scope } });
  return id;
}

export async function updatePrompt(s: FirmSession, id: string, input: unknown): Promise<void> {
  staff(s, "use the Prompt Library");
  const p = await getPrompt(s, id);
  if (!p || p.scope === "huis" || !p.canEdit) throw new NotFoundError("Prompt");
  const v = promptInput.parse(input);
  const r = await s.client.query("UPDATE huis.ai_prompts SET title = $2, body = $3, category = $4 WHERE id = $1", [id, v.title, v.body, v.category]);
  if (!r.rowCount) throw new NotFoundError("Prompt");
  await recordAudit(s, "ai.prompt_changed", { targetType: "prompt", targetId: id, metadata: { scope: p.scope } });
}

export async function deletePrompt(s: FirmSession, id: string): Promise<void> {
  staff(s, "use the Prompt Library");
  const p = await getPrompt(s, id);
  if (!p || p.scope === "huis" || !p.canEdit) throw new NotFoundError("Prompt");
  const r = await s.client.query("DELETE FROM huis.ai_prompts WHERE id = $1", [id]);
  if (!r.rowCount) throw new NotFoundError("Prompt");
  await recordAudit(s, "ai.prompt_deleted", { targetType: "prompt", targetId: id, metadata: { scope: p.scope } });
}
