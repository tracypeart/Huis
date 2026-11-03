import { LocalAiProvider } from "./local";

/**
 * Huis AI Gateway: every AI use in Huis goes through here, so the firm's
 * choice of provider, the privilege rules and the usage log apply everywhere.
 *
 * Providers today:
 *   off    — no AI features (questions are refused, nothing is indexed)
 *   local  — runs entirely inside Huis; sends nothing to any outside service.
 *            Meaning search uses a built-in text fingerprint, and answers are
 *            the most relevant passages from the Matter, each cited, rather
 *            than written conclusions.
 * Outside AI providers (for written answers and better meaning search) are
 * added only once their zero-data-retention, no-training terms are signed
 * (open item O-3). They plug in through this same interface.
 */
export type AiProviderName = "off" | "local";

export interface Passage { n: number; text: string }
export interface AiAnswer { text: string; cited: number[] }

export interface AiProvider {
  readonly name: Exclude<AiProviderName, "off">;
  readonly model: string;
  /** Meaning fingerprints ("embeddings") for passages or a question. */
  embed(texts: string[]): Promise<number[][]>;
  /** Answers a question from numbered passages, citing them by number. Must not use anything else. */
  answer(question: string, passages: Passage[]): Promise<AiAnswer>;
}

export class AiDisabledError extends Error {
  constructor() { super("AI features are turned off for this firm."); }
}

const local = new LocalAiProvider();

export function aiProvider(name: string): AiProvider {
  if (name === "local") return local;
  throw new AiDisabledError();
}

/** Every answer and AI report carries this label. */
export const WORK_PRODUCT_LABEL = "Privileged & Confidential — Attorney Work Product";
