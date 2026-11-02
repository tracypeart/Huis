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
import { ROLES } from "../src/security/permissions";
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

export async function endSessionsAction(fd: FormData): Promise<void> {
  return act("/users", "Signed out on all devices.", () => withSession(async (s) => {
    await endUserSessions(s, text(fd, "userId") ?? "");
  }));
}
