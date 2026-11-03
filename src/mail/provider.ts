import type { Readable } from "node:stream";

/** What every mailbox provider (Outlook, Gmail) must offer Huis. */
export interface MailProvider {
  listFolders(): Promise<MailFolderInfo[]>;
  /** Folder-by-folder change feed (Outlook). */
  deltaPage(folderProviderId: string, link: string | null): Promise<DeltaPage>;
  /**
   * Whole-mailbox change feed (Gmail). When present it is used instead of
   * deltaPage: each message carries its labels, which decide its folder.
   */
  mailboxPage?(link: string | null): Promise<MailboxPage>;
  fetchMime(messageId: string): Promise<Readable>;
}

export interface MailFolderInfo { providerId: string; parentProviderId: string | null; name: string; path: string; total: number | null }

export type MailMessageInfo =
  | { id: string; removed: true }
  | {
      id: string; removed: false; internetMessageId: string | null; conversationId: string | null; subject: string | null;
      fromAddress: string | null; fromName: string | null; to: string[]; cc: string[];
      receivedAt: string | null; sentAt: string | null; hasAttachments: boolean; importance: string | null;
      isRead: boolean | null; preview: string | null; body: string | null;
    };

export interface DeltaPage { messages: MailMessageInfo[]; nextLink: string | null; deltaLink: string | null }

/** restart: the saved position is too old (Gmail keeps about a week of history); import everything again. */
/** fullImportDone: a fresh import just finished listing everything (mail it didn't see is no longer in the mailbox). */
export interface MailboxPage {
  messages: (MailMessageInfo & { labels: string[] })[]; nextLink: string | null; deltaLink: string | null; restart?: boolean; fullImportDone?: boolean;
}
