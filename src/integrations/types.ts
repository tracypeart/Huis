import type { Readable } from "node:stream";

/**
 * The Integration Hub's adapter contract. Every outside system (OneDrive,
 * Google Drive, Dropbox, Filevine, Clio, StrongSuit) gets one adapter; the hub
 * itself (connections, sync records, imports into Matters, chain of custody)
 * is shared.
 *
 * Adapters run only inside the worker, with an access token the worker
 * obtained from the sealed refresh token. The web app never holds a token.
 */

export type IntegrationProvider = "onedrive" | "google_drive" | "dropbox" | "filevine" | "clio" | "strongsuit";

/** One entry in a folder listing: never the contents, only what's needed to choose. */
export interface ListedItem {
  /** The adapter's own id (e.g. "drive:<driveId>:<itemId>"). */
  id: string;
  kind: "file" | "folder" | "site";
  name: string;
  size?: number | null;
  /** ISO timestamp of the last change. */
  modified?: string | null;
  /** The outside system's version for the content (so the same version isn't imported twice). */
  version?: string | null;
  mime?: string | null;
}

export interface Listing {
  /** The folder's own name. */
  title: string;
  /** Where "up" goes, or null at the top. */
  parent: string | null;
  items: ListedItem[];
  /** True when the folder had more than Huis lists. */
  truncated: boolean;
}

export interface RemoteFile {
  name: string;
  size: number | null;
  version: string | null;
  modified: string | null;
  mime: string | null;
  /** Where it lived, for the chain of custody (e.g. "/Documents/Smith"). */
  path: string | null;
}

/** A file source (cloud storage): browse and download, read-only. */
export interface FileSource {
  list(location: string): Promise<Listing>;
  describe(id: string): Promise<RemoteFile>;
  /** The file's bytes; given the version just read, a source that can fetch that exact version does. */
  download(id: string, version?: string | null): Promise<Readable>;
}
