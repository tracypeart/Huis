/**
 * Conversation and prompt categories (the AI Workspace's, from the source spec),
 * and Huis's built-in prompts: general-purpose questions an attorney can start
 * from. They are written for the Matter Brain (they ask the Matter's own
 * evidence) and are not legal advice; firms add their own approved prompts.
 */
export const AI_CATEGORIES = [
  "strategy", "research", "deposition", "discovery", "timeline", "damages", "motion", "trial", "client", "miscellaneous",
] as const;
export type AiCategory = (typeof AI_CATEGORIES)[number];

export const AI_CATEGORY_LABELS: Record<AiCategory, string> = {
  strategy: "Strategy", research: "Research", deposition: "Deposition", discovery: "Discovery", timeline: "Timeline",
  damages: "Damages", motion: "Motion", trial: "Trial", client: "Client", miscellaneous: "Miscellaneous",
};

export interface BuiltInPrompt { key: string; title: string; body: string; category: AiCategory }

export const BUILT_IN_PROMPTS: readonly BuiltInPrompt[] = [
  { key: "key-dates", category: "timeline", title: "Key dates",
    body: "What are the key dates in this matter, and what happened on each?" },
  { key: "notice", category: "strategy", title: "Who knew what, and when",
    body: "When did the employer first learn of the condition, request or complaint, and who learned of it?" },
  { key: "decision-makers", category: "strategy", title: "Decision makers",
    body: "Who made the decision at issue, who was consulted, and what reasons were given at the time?" },
  { key: "stated-reasons", category: "motion", title: "Stated reasons over time",
    body: "What reasons were given for the decision, and did those reasons change over time?" },
  { key: "witness-statements", category: "deposition", title: "What a witness has said",
    body: "What has the witness said, in writing or under oath, about the events in this matter?" },
  { key: "deposition-topics", category: "deposition", title: "Topics to cover in deposition",
    body: "Which events, documents and communications involve this witness and should be covered in their deposition?" },
  { key: "missing-documents", category: "discovery", title: "Documents referred to but not produced",
    body: "Which documents, emails or records are referred to in the evidence but don't appear to be in the matter?" },
  { key: "policies", category: "discovery", title: "Policies and procedures",
    body: "Which workplace policies, handbooks or procedures are mentioned, and how were they applied here?" },
  { key: "lost-pay", category: "damages", title: "Lost pay and benefits",
    body: "What does the evidence show about pay, benefits, hours and any loss of income?" },
  { key: "client-timeline", category: "client", title: "What the client told us",
    body: "What has the client told us, in notes and uploads, about what happened and when?" },
  { key: "trial-themes", category: "trial", title: "Strongest documents",
    body: "Which documents most directly show what happened, in the words of the people involved at the time?" },
];

/** A built-in prompt by its key (built-in ids are "huis:<key>"). */
export function builtInPrompt(id: string): BuiltInPrompt | undefined {
  return id.startsWith("huis:") ? BUILT_IN_PROMPTS.find((p) => `huis:${p.key}` === id) : undefined;
}
