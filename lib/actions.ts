"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";
import { authConfig } from "../src/auth/config";
import { createClient } from "../src/services/clients";
import { CONTACT_KINDS, createContact } from "../src/services/contacts";
import { resolveIdentity, signUpFirm } from "../src/services/firms";
import { addMatterMember, createMatter, linkContactToMatter, setCourtCaseNumber } from "../src/services/matters";
import { changeUserRole, disableUser, endUserSessions, inviteUser, issueInvitation } from "../src/services/users";
import { moveEvidence } from "../src/services/evidence";
import {
  addClaimFromTemplate, addElement, addFactFromPassage, addNode, decideLink, decideNode, deleteNode, importMatterPeople, linkNodes, setCategories, unlink, updateNode,
} from "../src/services/dna";
import { addNote, askMatter, deleteAnswer, deleteNote, setAiProviderSetting, updateNote } from "../src/services/brain";
import { requestCopy } from "../src/services/workingCopies";
import { confirmContradiction, reconsiderContradiction, rejectContradiction } from "../src/services/contradictions";
import { askAgent } from "../src/services/agents";
import { reanalyzeMatter } from "../src/services/analysis";
import {
  createConversation, createPrompt, deleteConversation, deletePrompt, updateConversation, updatePrompt,
} from "../src/services/workspace";
import {
  fileMessage, fileToSuggestion, requestSync, setAutoFile, setDelegate, setFilingMode, setFolderIncluded, setMatterColor, updateMailbox,
} from "../src/services/inbox";
import { ROLES } from "../src/security/permissions";
import { UserFacingError } from "../src/errors";
import { act, db, getPending, setSessionCookie, withSession } from "./server";

const text = (fd: FormData, key: string) => {
  const v = fd.get(key);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

function inviteLink(token: string): string {
  return `${authConfig().baseUrl}/invite/${token}`;
}

// ---- Onboarding --------------------------------------------------------------

export async function createFirmAction(fd: FormData): Promise<void> {
  const pending = await getPending();
  if (!pending) redirect("/signin?reason=expired");
  return act("/onboarding", "Your firm is ready.", async () => {
    const firmName = z.string().trim().min(2).max(200).parse(text(fd, "firmName"));
    const base = firmName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "firm";
    const res = await signUpFirm(db(), {
      firmName,
      slug: `${base}-${randomBytes(3).toString("hex")}`,
      stateCode: text(fd, "stateCode") ?? "UT",
      locationName: text(fd, "locationName") ?? "Main Office",
      ownerEmail: pending.email ?? `${randomBytes(6).toString("hex")}@no-email.huis.invalid`,
      ownerName: text(fd, "ownerName") ?? pending.name,
      authProvider: pending.provider as "microsoft" | "google",
      authSubject: pending.subject,
    });
    await setSessionCookie({ firmId: res.firmId, userId: res.ownerUserId, provider: pending.provider, subject: pending.subject });
    return { redirectTo: "/dashboard" };
  });
}

export async function chooseFirmAction(fd: FormData): Promise<void> {
  const pending = await getPending();
  if (!pending) redirect("/signin?reason=expired");
  const userId = text(fd, "userId");
  // Re-check: only accounts that belong to this verified identity.
  const account = (await resolveIdentity(db(), pending.provider, pending.subject)).find((a) => a.userId === userId);
  if (!account) redirect("/select-firm");
  await setSessionCookie({ firmId: account.firmId, userId: account.userId, provider: pending.provider, subject: pending.subject });
  redirect("/dashboard");
}

// ---- Clients & contacts -----------------------------------------------------------

export async function createClientAction(fd: FormData): Promise<void> {
  return act("/clients", "Client added.", () => withSession(async (s) => {
    await createClient(s, {
      kind: text(fd, "kind") === "organization" ? "organization" : "person",
      displayName: text(fd, "displayName") ?? "",
      email: text(fd, "email"),
      phone: text(fd, "phone"),
    });
  }));
}

export async function createContactAction(fd: FormData): Promise<void> {
  return act("/contacts", "Contact added.", () => withSession(async (s) => {
    await createContact(s, {
      kind: z.enum(CONTACT_KINDS).parse(text(fd, "kind")),
      fullName: text(fd, "fullName") ?? "",
      organization: text(fd, "organization"),
      email: text(fd, "email"),
      phone: text(fd, "phone"),
      barNumber: text(fd, "barNumber"),
    });
  }));
}

// ---- Matters -----------------------------------------------------------

export async function createMatterAction(fd: FormData): Promise<void> {
  return act("/matters/new", "Matter created.", () => withSession(async (s) => {
    const m = await createMatter(s, {
      title: text(fd, "title") ?? "",
      clientId: text(fd, "clientId") ?? "",
      leadAttorneyId: text(fd, "leadAttorneyId") ?? "",
      jurisdictionState: text(fd, "jurisdictionState") ?? "UT",
      courtCaseNumber: text(fd, "courtCaseNumber"),
      firmMatterNumber: text(fd, "firmMatterNumber"),
      courtName: text(fd, "courtName"),
      practiceArea: text(fd, "practiceArea"),
      restricted: fd.get("restricted") === "on",
    });
    return { redirectTo: `/matters/${m.id}`, message: `Matter ${m.huisNumber} created.` };
  }));
}

export async function setCourtCaseNumberAction(fd: FormData): Promise<void> {
  const matterId = text(fd, "matterId") ?? "";
  return act(`/matters/${matterId}`, "Court case number saved.", () => withSession(async (s) => {
    await setCourtCaseNumber(s, matterId, text(fd, "courtCaseNumber") ?? null);
  }));
}

export async function addMatterMemberAction(fd: FormData): Promise<void> {
  const matterId = text(fd, "matterId") ?? "";
  return act(`/matters/${matterId}`, "Access granted.", () => withSession(async (s) => {
    await addMatterMember(s, {
      matterId,
      userId: text(fd, "userId") ?? "",
      access: z.enum(["owner", "edit", "view"]).parse(text(fd, "access") ?? "view"),
      acknowledgePrivilegeWaiverRisk: fd.get("acknowledge") === "on",
    });
  }));
}

export async function linkContactAction(fd: FormData): Promise<void> {
  const matterId = text(fd, "matterId") ?? "";
  return act(`/matters/${matterId}`, "Contact linked.", () => withSession(async (s) => {
    await linkContactToMatter(s, matterId, text(fd, "contactId") ?? "", text(fd, "roleLabel"));
  }));
}

// ---- Users -----------------------------------------------------------

export async function inviteUserAction(fd: FormData): Promise<void> {
  return act("/users", "Person added.", () => withSession(async (s) => {
    const u = await inviteUser(s, {
      email: text(fd, "email") ?? "",
      fullName: text(fd, "fullName") ?? "",
      role: z.enum(ROLES).parse(text(fd, "role")),
      locationId: text(fd, "locationId") ?? "",
    });
    return {
      message: `${u.fullName} was added. Send them this one-time link (valid 7 days). It is shown only once.`,
      secretLink: inviteLink(u.invitationToken),
    };
  }));
}

export async function reissueInviteAction(fd: FormData): Promise<void> {
  return act("/users", "New invitation link created.", () => withSession(async (s) => {
    const token = await issueInvitation(s, text(fd, "userId") ?? "");
    return {
      message: "New one-time link created; any earlier link no longer works. It is shown only once.",
      secretLink: inviteLink(token),
    };
  }));
}

export async function changeRoleAction(fd: FormData): Promise<void> {
  return act("/users", "Role updated.", () => withSession(async (s) => {
    await changeUserRole(s, text(fd, "userId") ?? "", z.enum(ROLES).parse(text(fd, "role")));
  }));
}

export async function disableUserAction(fd: FormData): Promise<void> {
  return act("/users", "Access removed.", () => withSession(async (s) => {
    await disableUser(s, text(fd, "userId") ?? "");
  }));
}

// ---- Evidence -----------------------------------------------------------

export async function moveEvidenceAction(fd: FormData): Promise<void> {
  const evidenceId = text(fd, "evidenceId") ?? "";
  return act(`/evidence/${evidenceId}`, "Moved. The move is recorded in the chain of custody.", () => withSession(async (s) => {
    await moveEvidence(s, evidenceId, text(fd, "folderId") ?? "", { acknowledgePrivilegeWaiverRisk: fd.get("acknowledge") === "on" });
  }));
}

export async function requestCopyAction(fd: FormData): Promise<void> {
  const evidenceId = text(fd, "evidenceId") ?? "";
  return act(`/evidence/${evidenceId}`, "Copy requested. Huis is producing it now; it will appear below and in the chosen folder.", () => withSession(async (s) => {
    await requestCopy(s, evidenceId, {
      redact: fd.get("redact") === "on",
      exhibitLabel: text(fd, "exhibitLabel") ?? undefined,
      batesPrefix: text(fd, "batesPrefix") ?? undefined,
      folderId: text(fd, "folderId") ?? "",
      acknowledgePrivilegeWaiverRisk: fd.get("acknowledge") === "on",
    });
  }));
}

// ---------------------------------------------------------------------------
// Huis Inbox
// ---------------------------------------------------------------------------
export async function fileMessageAction(fd: FormData): Promise<void> {
  const messageId = text(fd, "messageId") ?? "";
  return act(`/inbox/${messageId}`, "Filing… Huis is copying the original email into the Matter (with its attachments).", () => withSession(async (s) => {
    await fileMessage(s, messageId, {
      matterId: text(fd, "matterId") ?? "", folderId: text(fd, "folderId") ?? "",
      acknowledgePrivilegeWaiverRisk: fd.get("acknowledge") === "on",
    });
  }));
}

export async function updateMailboxAction(fd: FormData): Promise<void> {
  const id = text(fd, "connectionId") ?? "";
  const status = (text(fd, "status") ?? "active") as "active" | "paused" | "disconnected";
  return act(status === "disconnected" ? "/inbox" : `/inbox/mailboxes/${id}`,
    status === "disconnected" ? "Mailbox disconnected. Its unfiled mail was deleted from Huis; filed emails stay in their Matters." : "Mailbox settings saved.",
    () => withSession(async (s) => {
      await updateMailbox(s, id, {
        scope: text(fd, "scope") ?? "all", syncSince: text(fd, "syncSince") || null, manage: fd.get("manage") === "on", status,
      });
    }));
}

export async function mailFolderAction(fd: FormData): Promise<void> {
  const id = text(fd, "connectionId") ?? "";
  return act(`/inbox/mailboxes/${id}`, "Folder updated.", () => withSession(async (s) => {
    await setFolderIncluded(s, text(fd, "folderId") ?? "", fd.get("included") === "true");
    await requestSync(s, id);
  }));
}

export async function mailDelegateAction(fd: FormData): Promise<void> {
  const id = text(fd, "connectionId") ?? "";
  return act(`/inbox/mailboxes/${id}`, "Access updated.", () => withSession(async (s) => {
    await setDelegate(s, id, text(fd, "userId") ?? "", fd.get("granted") === "true");
  }));
}

export async function syncMailboxAction(fd: FormData): Promise<void> {
  const id = text(fd, "connectionId") ?? "";
  return act("/inbox", "Sync requested.", () => withSession(async (s) => { await requestSync(s, id); }));
}

export async function fileSuggestionAction(fd: FormData): Promise<void> {
  const messageId = text(fd, "messageId") ?? "";
  return act(`/inbox/${messageId}`, "Filing… Huis is copying the original email into the Matter's Correspondence folder.", () => withSession(async (s) => {
    await fileToSuggestion(s, messageId, text(fd, "matterId") ?? "");
  }));
}

export async function filingModeAction(fd: FormData): Promise<void> {
  return act("/inbox", "Filing mode saved.", () => withSession(async (s) => { await setFilingMode(s, text(fd, "mode") ?? ""); }));
}

export async function autoFileAction(fd: FormData): Promise<void> {
  const id = text(fd, "connectionId") ?? "";
  return act(`/inbox/mailboxes/${id}`, "Automatic filing setting saved.", () => withSession(async (s) => {
    await setAutoFile(s, id, fd.get("on") === "true");
  }));
}

export async function matterColorAction(fd: FormData): Promise<void> {
  const id = text(fd, "matterId") ?? "";
  return act(`/matters/${id}`, "Color saved.", () => withSession(async (s) => {
    await setMatterColor(s, id, text(fd, "color") || null);
  }));
}

export async function endSessionsAction(fd: FormData): Promise<void> {
  return act("/users", "Signed out on all devices.", () => withSession(async (s) => {
    await endUserSessions(s, text(fd, "userId") ?? "");
  }));
}

// ---------------------------------------------------------------------------
// Matter Brain
// ---------------------------------------------------------------------------
export async function askMatterAction(fd: FormData): Promise<void> {
  const matterId = text(fd, "matterId") ?? "";
  let answerId = "";
  return act(`/matters/${matterId}/brain`, "Answer ready.", async () => {
    answerId = await withSession((s) => askMatter(s, matterId, fd.get("question")));
    return { redirectTo: `/matters/${matterId}/brain?a=${answerId}` };
  });
}

export async function deleteAnswerAction(fd: FormData): Promise<void> {
  const matterId = text(fd, "matterId") ?? "";
  return act(`/matters/${matterId}/brain`, "Question removed.", () => withSession(async (s) => { await deleteAnswer(s, text(fd, "answerId") ?? ""); }));
}

export async function addNoteAction(fd: FormData): Promise<void> {
  const matterId = text(fd, "matterId") ?? "";
  return act(`/matters/${matterId}/brain`, "Note saved. Huis adds it to the Matter Brain.", () => withSession(async (s) => {
    await addNote(s, matterId, { title: fd.get("title"), body: fd.get("body") });
  }));
}

export async function updateNoteAction(fd: FormData): Promise<void> {
  const matterId = text(fd, "matterId") ?? "";
  return act(`/matters/${matterId}/brain`, "Note updated.", () => withSession(async (s) => {
    await updateNote(s, text(fd, "noteId") ?? "", { title: fd.get("title"), body: fd.get("body") });
  }));
}

export async function deleteNoteAction(fd: FormData): Promise<void> {
  const matterId = text(fd, "matterId") ?? "";
  return act(`/matters/${matterId}/brain`, "Note deleted.", () => withSession(async (s) => { await deleteNote(s, text(fd, "noteId") ?? ""); }));
}

export async function aiProviderAction(fd: FormData): Promise<void> {
  const matterId = text(fd, "matterId") ?? "";
  return act(matterId ? `/matters/${matterId}/brain` : "/", "AI setting saved.", () => withSession(async (s) => {
    await setAiProviderSetting(s, text(fd, "provider") ?? "");
  }));
}

// ---------------------------------------------------------------------------
// Case DNA
// ---------------------------------------------------------------------------
const dnaPath = (fd: FormData) => {
  const matterId = text(fd, "matterId") ?? "";
  const back = text(fd, "back");
  // Only return to a page inside this Matter's Case DNA or timeline (with its filters).
  const ok = back && (/^\/matters\/[0-9a-f-]{36}\/dna(\/[0-9a-f-]{36})?(\?[a-z=0-9-]*)?$/i.test(back)
    || /^\/matters\/[0-9a-f-]{36}\/timeline(\?[A-Za-z0-9=&%+._*-]{0,2000})?$/.test(back));
  return ok && back.startsWith(`/matters/${matterId}/`) ? back : `/matters/${matterId}/dna`;
};
const nodeFields = (fd: FormData) => ({
  kind: fd.get("kind") ?? undefined, label: fd.get("label"), details: fd.get("details") ?? "",
  eventDate: text(fd, "eventDate") || null, email: text(fd, "email") || null, role: text(fd, "role") || null,
  amount: text(fd, "amount") || null,
  // Only forms that offer categories set them (an empty choice there means "none").
  categories: fd.get("categoriesShown") === "1" ? fd.getAll("categories").map(String) : null,
});

export async function dnaAddNodeAction(fd: FormData): Promise<void> {
  const matterId = text(fd, "matterId") ?? "";
  return act(dnaPath(fd), "Added to Case DNA.", () => withSession(async (s) => { await addNode(s, matterId, nodeFields(fd)); }));
}
export async function dnaUpdateNodeAction(fd: FormData): Promise<void> {
  return act(dnaPath(fd), "Saved.", () => withSession(async (s) => { await updateNode(s, text(fd, "nodeId") ?? "", nodeFields(fd)); }));
}
export async function dnaDeleteNodeAction(fd: FormData): Promise<void> {
  const matterId = text(fd, "matterId") ?? "";
  return act(`/matters/${matterId}/dna`, "Deleted.", () => withSession(async (s) => { await deleteNode(s, text(fd, "nodeId") ?? ""); }));
}
export async function dnaSetCategoriesAction(fd: FormData): Promise<void> {
  return act(dnaPath(fd), "Categories saved.", () => withSession(async (s) => {
    await setCategories(s, text(fd, "nodeId") ?? "", fd.get("useHuis") === "1" ? null : fd.getAll("categories").map(String));
  }));
}
export async function dnaDecideAction(fd: FormData): Promise<void> {
  const d = text(fd, "decision");
  return act(dnaPath(fd), d === "confirmed" ? "Confirmed." : "Rejected; Huis won't suggest it again.", () => withSession(async (s) => {
    const linkId = text(fd, "linkId");
    if (linkId) await decideLink(s, linkId, d); else await decideNode(s, text(fd, "nodeId") ?? "", d);
  }));
}
export async function dnaLinkAction(fd: FormData): Promise<void> {
  return act(dnaPath(fd), "Linked.", () => withSession(async (s) => {
    await linkNodes(s, text(fd, "fromId") ?? "", text(fd, "toId") ?? "", text(fd, "relation"));
  }));
}
export async function dnaUnlinkAction(fd: FormData): Promise<void> {
  return act(dnaPath(fd), "Link removed.", () => withSession(async (s) => { await unlink(s, text(fd, "linkId") ?? ""); }));
}
export async function dnaAddClaimAction(fd: FormData): Promise<void> {
  const matterId = text(fd, "matterId") ?? "";
  return act(`/matters/${matterId}/dna`, "Claim added.", async () => {
    const id = await withSession(async (s) => {
      const template = text(fd, "template");
      if (template && template !== "custom") return addClaimFromTemplate(s, matterId, template);
      return addNode(s, matterId, { kind: text(fd, "kind") === "defense" ? "defense" : "claim", label: fd.get("label"), details: fd.get("details") ?? "" });
    });
    return { redirectTo: `/matters/${matterId}/dna/${id}` };
  });
}
export async function dnaAddElementAction(fd: FormData): Promise<void> {
  return act(dnaPath(fd), "Element added.", () => withSession(async (s) => {
    await addElement(s, text(fd, "claimId") ?? "", { label: fd.get("label"), details: fd.get("details") ?? "" });
  }));
}
export async function dnaAddFactAction(fd: FormData): Promise<void> {
  return act(dnaPath(fd), "Added as a fact, with its source.", () => withSession(async (s) => {
    await addFactFromPassage(s, text(fd, "elementId") ?? "", { chunkId: text(fd, "chunkId"), relation: text(fd, "relation") });
  }));
}
export async function dnaImportPeopleAction(fd: FormData): Promise<void> {
  const matterId = text(fd, "matterId") ?? "";
  return act(`/matters/${matterId}/dna`, "People added.", async () => {
    const n = await withSession((s) => importMatterPeople(s, matterId));
    return { message: n ? `${n} added from the Matter's client and contacts.` : "Everyone is already on the map." };
  });
}

// ---------------------------------------------------------------------------
// Contradiction engine
// ---------------------------------------------------------------------------
export async function contradictionDecideAction(fd: FormData): Promise<void> {
  const matterId = text(fd, "matterId") ?? "";
  const back = /^[0-9a-f-]{36}$/i.test(matterId) ? `/matters/${matterId}/contradictions` : "/matters";
  const decision = text(fd, "decision");
  const key = text(fd, "key");
  const messages: Record<string, string> = {
    confirm: "Confirmed. The statement and the evidence that contradicts it are now in Case DNA.",
    reject: "Rejected; Huis won't suggest it again.",
    reconsider: "It's back on the list to decide.",
  };
  return act(back, messages[decision ?? ""] ?? "Done.", () => withSession(async (s) => {
    if (decision === "confirm") await confirmContradiction(s, matterId, key, text(fd, "version"));
    else if (decision === "reject") await rejectContradiction(s, matterId, key);
    else if (decision === "reconsider") await reconsiderContradiction(s, matterId, key);
    else throw new UserFacingError("Choose confirm or reject.");
  }));
}

// ---------------------------------------------------------------------------
// AI Workspace and Prompt Library
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const workspacePath = (matterId: string, conversationId?: string) =>
  !UUID_RE.test(matterId) ? "/matters" : conversationId && UUID_RE.test(conversationId)
    ? `/matters/${matterId}/workspace/${conversationId}` : `/matters/${matterId}/workspace`;

export async function createConversationAction(fd: FormData): Promise<void> {
  const matterId = text(fd, "matterId") ?? "";
  return act(workspacePath(matterId), "Conversation started.", async () => {
    const id = await withSession((s) => createConversation(s, matterId, { title: fd.get("title"), category: fd.get("category") }));
    return { redirectTo: workspacePath(matterId, id) };
  });
}
export async function askInConversationAction(fd: FormData): Promise<void> {
  const matterId = text(fd, "matterId") ?? "";
  const id = text(fd, "conversationId") ?? "";
  return act(workspacePath(matterId, id), "Answer ready.", () => withSession(async (s) => { await askAgent(s, id, fd.get("question"), text(fd, "agent") ?? "auto"); }));
}
export async function updateConversationAction(fd: FormData): Promise<void> {
  const matterId = text(fd, "matterId") ?? "";
  const id = text(fd, "conversationId") ?? "";
  return act(workspacePath(matterId, id), "Saved.", () => withSession(async (s) => {
    await updateConversation(s, id, { title: fd.get("title"), category: fd.get("category"), shared: fd.get("shared") === "on" });
  }));
}
export async function deleteConversationAction(fd: FormData): Promise<void> {
  const matterId = text(fd, "matterId") ?? "";
  return act(workspacePath(matterId), "Conversation deleted.", () => withSession(async (s) => { await deleteConversation(s, text(fd, "conversationId") ?? ""); }));
}
export async function createPromptAction(fd: FormData): Promise<void> {
  return act("/prompts", "Prompt saved.", () => withSession(async (s) => {
    await createPrompt(s, { scope: text(fd, "scope"), title: fd.get("title"), body: fd.get("body"), category: fd.get("category") });
  }));
}
export async function updatePromptAction(fd: FormData): Promise<void> {
  return act("/prompts", "Prompt saved.", () => withSession(async (s) => {
    await updatePrompt(s, text(fd, "promptId") ?? "", { title: fd.get("title"), body: fd.get("body"), category: fd.get("category") });
  }));
}
export async function deletePromptAction(fd: FormData): Promise<void> {
  return act("/prompts", "Prompt deleted.", () => withSession(async (s) => { await deletePrompt(s, text(fd, "promptId") ?? ""); }));
}

// ---------------------------------------------------------------------------
// Matter analysis
// ---------------------------------------------------------------------------
export async function reanalyzeAction(fd: FormData): Promise<void> {
  const matterId = text(fd, "matterId") ?? "";
  const back = UUID_RE.test(matterId) ? `/matters/${matterId}/analysis` : "/matters";
  return act(back, "Reanalyzed.", async () => {
    const r = await withSession((s) => reanalyzeMatter(s, matterId));
    return { message: r.retried ? `Reanalyzed. Huis is trying again to read ${r.retried} ${r.retried === 1 ? "item" : "items"} it couldn't read before.` : "Reanalyzed. A new analysis period starts now." };
  });
}
