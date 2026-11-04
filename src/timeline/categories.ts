/**
 * Timeline categories, and the fixed rules Huis uses to suggest them.
 *
 * The rules are plain word lists (no AI), so the same text always gets the
 * same categories and each suggestion can be explained ("mentions surgery").
 * Attorneys can replace Huis's categories with their own on any confirmed item.
 */
export const CATEGORIES = [
  "court", "plaintiff", "defendant", "medical", "financial", "employment", "communications", "discovery", "witness", "damages",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  court: "Court", plaintiff: "Plaintiff", defendant: "Defendant", medical: "Medical", financial: "Financial",
  employment: "Employment", communications: "Communications", discovery: "Discovery", witness: "Witness", damages: "Damages",
};

/**
 * Words (any case) that suggest each category from an item's own wording.
 * A word matches whole ("paid" isn't "unpaid"); one ending in * matches as the
 * start of a word ("terminat*" finds "terminated", "termination").
 */
const WORDS: Partial<Record<Category, string[]>> = {
  court: [
    "court*", "hearing*", "judge*", "docket*", "complaint*", "summons", "motion*", "trial*", "lawsuit*", "filed", "filing*", "verdict*",
    "judgment*", "ruling*", "order to show cause", "scheduling order", "mediation", "arbitration", "appeal*", "efiling", "e-filing",
  ],
  medical: [
    "medical*", "doctor*", "dr", "physician*", "surgery", "surgeries", "surgical*", "hospital*", "clinic*", "diagnos*", "treatment*",
    "therap*", "prescri*", "injur*", "illness*", "patient*", "nurse*", "urgent care", "emergency room", "health condition*", "medication*",
  ],
  financial: [
    "payment*", "paid", "pay", "invoice*", "wire", "wired", "bank*", "deposit", "deposits", "deposited", "transaction*", "salary",
    "salaries", "wage*", "paycheck*", "payroll", "bonus*", "commission*", "refund*", "loan*", "account balance", "$",
  ],
  employment: [
    "employ*", "hired", "hiring", "terminat*", "fired", "discipline*", "disciplinary", "written warning*", "performance review*",
    "performance improvement", "promot*", "demot*", "resign*", "human resources", "hr", "supervisor*", "pto",
    "leave", "fmla", "accommodation*", "job", "jobs", "position", "onboard*", "layoff*", "laid off", "retaliat*",
  ],
  communications: [
    "email*", "e-mail*", "letter*", "text message*", "texted", "phone call*", "called", "voicemail*", "memo", "memos",
    "wrote", "message*", "meeting*", "met with", "conversation*", "spoke", "told", "informed", "notified", "notice*",
  ],
  discovery: [
    "deposition*", "deposed", "interrogator*", "request for production", "requests for production", "request for admission",
    "requests for admission", "subpoena*", "discovery", "initial disclosures", "privilege log", "document production",
  ],
  damages: [
    "damage*", "lost wages", "back pay", "front pay", "medical bills", "emotional distress", "out of pocket", "out-of-pocket",
    "loss of", "lost income", "economic loss*", "punitive", "attorney fees", "attorneys' fees",
  ],
};

function escape(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** One pattern per category, with word boundaries on the sides that are letters. */
const PATTERNS: [Category, RegExp][] = (Object.entries(WORDS) as [Category, string[]][]).map(([cat, words]) => [
  cat,
  new RegExp(words.map((w) => {
    const prefix = w.endsWith("*");
    const word = prefix ? w.slice(0, -1) : w;
    return `${/^\w/.test(word) ? "\\b" : ""}${escape(word)}${!prefix && /\w$/.test(word) ? "\\b" : ""}`;
  }).join("|"), "i"),
]);

/** What the rules can see about an item besides its own words. */
export interface CategoryContext {
  /** Roles (or names) of the confirmed people and organizations linked to the item. */
  linkedRoles?: string[];
  /** A confirmed person witnessed it. */
  hasWitness?: boolean;
  /** The item is a damage, or has an amount. */
  isDamage?: boolean;
  /** The item is a filed email. */
  isEmail?: boolean;
}

/** Bounded text, so a very long item can't make matching slow. */
const MAX_TEXT = 5000;

/** Huis's suggested categories for an item, in the order of CATEGORIES. */
export function suggestCategories(text: string, ctx: CategoryContext = {}): Category[] {
  const t = ` ${text.slice(0, MAX_TEXT)} `;
  const found = new Set<Category>();
  for (const [cat, re] of PATTERNS) if (re.test(t)) found.add(cat);
  for (const role of ctx.linkedRoles ?? []) {
    const r = role.toLowerCase();
    if (/\b(plaintiff|petitioner|claimant|client)\b/.test(r)) found.add("plaintiff");
    if (/\b(defendant|respondent|opposing|employer)\b/.test(r)) found.add("defendant");
    if (/\bwitness\b/.test(r)) found.add("witness");
  }
  if (ctx.hasWitness) found.add("witness");
  if (ctx.isDamage) found.add("damages");
  if (ctx.isEmail) found.add("communications");
  return CATEGORIES.filter((c) => found.has(c));
}
