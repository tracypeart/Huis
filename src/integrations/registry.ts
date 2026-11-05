import type { IntegrationProvider } from "./types";

/**
 * Every system the Integration Hub knows about, and where each stands.
 *
 *   available        — built and can be connected (once the firm's sign-in app is registered)
 *   coming_next      — planned for the next part of Phase 9
 *   needs_agreement  — needs a partner or developer agreement before Huis can connect
 */
export type IntegrationStatus = "available" | "coming_next" | "needs_agreement";

export interface IntegrationInfo {
  provider: IntegrationProvider;
  name: string;
  kind: "file_storage" | "case_management" | "legal_ai";
  status: IntegrationStatus;
  what: string;
  /** Read-only, write, or both, once available. */
  access: string;
  /** What has to happen before it can be used. */
  needs: string | null;
}

export const INTEGRATIONS: readonly IntegrationInfo[] = [
  {
    provider: "onedrive", name: "OneDrive and SharePoint", kind: "file_storage", status: "available",
    what: "Browse your OneDrive and the SharePoint sites you follow, and import chosen files into a Matter as evidence.",
    access: "Read-only. Huis can't change, move or delete your files.",
    needs: "The firm's Microsoft sign-in app needs the Files.Read.All permission (delegated).",
  },
  {
    provider: "google_drive", name: "Google Drive", kind: "file_storage", status: "coming_next",
    what: "Choose files with Google's own file picker and import them into a Matter.",
    access: "Only the files you pick (the drive.file permission).", needs: "Google Cloud Picker set-up.",
  },
  {
    provider: "dropbox", name: "Dropbox", kind: "file_storage", status: "coming_next",
    what: "Browse Dropbox and import chosen files into a Matter.", access: "Read-only.", needs: "Dropbox app review.",
  },
  {
    provider: "filevine", name: "Filevine", kind: "case_management", status: "needs_agreement",
    what: "Link Huis Matters to Filevine projects; bring in documents, contacts and deadlines.",
    access: "To be agreed with Filevine.", needs: "A Filevine developer account (API key and partner access).",
  },
  {
    provider: "clio", name: "Clio", kind: "case_management", status: "needs_agreement",
    what: "Link Huis Matters to Clio matters; bring in documents, contacts and calendar entries.",
    access: "To be agreed with Clio.", needs: "A Clio developer application (Clio App Directory).",
  },
  {
    provider: "strongsuit", name: "StrongSuit", kind: "legal_ai", status: "needs_agreement",
    what: "StrongSuit supports an API connection and a user-interface merger; Huis will link Matters and share case files both ways.",
    access: "To be agreed with StrongSuit (open item O-1).", needs: "Discussions with StrongSuit and their API documentation.",
  },
];

export const integrationInfo = (p: string): IntegrationInfo | undefined => INTEGRATIONS.find((i) => i.provider === p);
