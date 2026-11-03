import type { Readable } from "node:stream";

/** What every mailbox provider (Outlook now, Gmail next) must offer Huis. */
export interface MailProvider {
  listFolders(): Promise<MailFolderInfo[]>;
  deltaPage(folderProviderId: string, link: string | null): Promise<DeltaPage>;
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
