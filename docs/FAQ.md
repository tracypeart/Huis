# Huis Law IP — Frequently Asked Questions

Plain-language answers for attorneys, firm administrators and staff. Updated as each phase is built and reviewed.

---

## Safety, security and attorney–client privilege

### Is attorney–client privilege protected?
Yes. Protecting privilege is Huis's first rule. Every matter has a red **Privileged & Confidential** folder that can never be switched off or reclassified. People outside the firm (clients, co-counsel, expert witnesses, other authorized third parties) can never see it, search it, or see the names of what's inside it. This is enforced by the database itself, not just by the screens, so a bug in the app can't expose it.

### What happens if someone moves privileged material somewhere a client can see?
Huis stops and warns them that this may waive privilege. They must explicitly acknowledge the risk before the move happens, and the acknowledgement is permanently recorded in the item's chain of custody.

### If an email has a privileged attachment, can it leak through the email?
No. Attachments filed separately (for example, into the red folder) stay where they were put, even if the email is later moved. A client can't discover a privileged attachment's name by searching the email it came from either.

### Can other people in my firm see every matter?
Not if you don't want them to. Any matter can be put behind an **ethical wall**: only the people on that matter can see it, its files, or its search results. That includes firm owners who aren't on the matter. Only the matter's owners can lift a wall.

### How are our files stored?
Every file is encrypted with its own key, and those keys are locked with a separate key for each firm. Files are stored in tamper-evident pieces. If a stored file is altered, cut short, swapped for another file, or opened with the wrong firm's key, Huis detects it and refuses to use it.

### Can evidence be changed or deleted?
No. Originals are never altered. The original record (file name, size, digital fingerprint, who uploaded it, when, who it was received from and when) is locked by the database. Highlighting, redacting and exhibit-stamping will always happen on a separate working copy.

### Is there a chain of custody?
Yes, for every item. It records when the item was received, by whom and from whom, its digital fingerprint, integrity checks, virus scan results, every move, every download, and every time someone reads its text. The log is append-only and chained together, so a removed or altered entry is detectable. Huis shows on screen whether the chain is intact.

### What about viruses and malicious files?
Every upload is virus-scanned before anyone can open it. Until it passes, it's held and can't be opened. Threats are quarantined. If a virus is found inside an email attachment or a file inside a ZIP, the email or ZIP it came from is quarantined too. Programs disguised as documents are flagged. If the scanner is ever unavailable, files stay held rather than being let through.

### Could a booby-trapped document harm Huis or expose other cases?
Huis opens every file inside a sealed-off area, one file at a time. That area has no internet access, no access to encryption keys or other cases, and strict time and memory limits. It can only write to a private temporary folder that is deleted afterwards. If a file misbehaves, it is stopped safely. Huis won't read files at all if this protection isn't available.

### Do we know who looked at what?
Yes. Every download and every time someone reads a document's text is recorded in that item's chain of custody and in the firm's audit log. Every search is recorded in the audit log, including what was searched and how many results came back.

### Can clients upload documents?
Yes, through the client portal, and only into the matter's **Client Uploads** folder. Clients see only what's in client-shared folders. They never see firm work product or the red privileged folder.

### How do people sign in?
With their firm's Microsoft account, and only by invitation. Invitations are single-use and expire after 7 days. Accounts are never linked automatically by email address. Signing out ends the session on every device, and an administrator can end a user's sessions or disable them immediately.

### Has Huis been independently security-tested?
Yes, at every stage. After each part is built, a separate reviewer that did not write the code attacks it with working exploit attempts against a real database and real malicious files. The reviewer assumes an attacker already has access to the app's own database connection. Every confirmed issue is fixed, and each fix gets a permanent automated test so it can't quietly return. A part isn't released until the reviewer's own attacks no longer work.

- **Review 1** (sign-in, firms, matters, secure intake): 9 issues confirmed, all fixed.
- **Review 2** (reading files and search): 7 security issues plus 7 reliability issues, all fixed. These included the protections above for privileged attachments, attachment names, the sealed-off file reader and the reading and search records.

### Who owns our data?
Your firm does. You can export everything at any time.

### Is our real client data used to build or test Huis?
No. Development and testing use only made-up sample files.

---

## Search and reading documents

### What can Huis read?
- PDFs, including scanned ones (Huis reads scanned pages with OCR, up to 300 pages per file)
- Photos of documents (PNG, JPEG, TIFF, GIF)
- Word, Excel and PowerPoint, both current and older formats, plus RTF
- Emails (.eml) and Outlook messages (.msg)
- Mailbox exports (.mbox)
- ZIP archives and discovery productions
- Text, HTML and CSV files

Audio and video will be transcribed once an approved transcription service that keeps no copy of the data is connected.

### What happens to email attachments and ZIP files?
Each attachment, and each file inside a ZIP, becomes its own evidence item. It gets its own fingerprint, virus scan, chain of custody and searchable text, and it remembers which email or archive it came from. Mailbox exports are split into one item per message.

### What does search cover?
The words inside every document, email, scan and attachment you're allowed to see, across all your matters or within one matter. You can search an exact phrase "in quotes", use `or` for alternatives, and put `-` before a word to exclude it. Matches are highlighted in the results.

### Will search ever show me something I shouldn't see?
No. Search follows the same rules as everything else, enforced by the database: firm separation, ethical walls, the red privileged folder and client restrictions. A client searching only ever finds what's in their shared folders.

### What if a file can't be fully read?
Huis tells you. Each item shows whether its text was read completely, partly (for example, a very long scan or an oversized archive), or not at all, and why. The original is always safely stored either way.

### Are there size limits?
Uploads can be very large (up to 100 GB per file by default, and whole folders or thumb drives keep their structure). To stop "zip bombs", Huis refuses archive contents that are suspiciously compressed and caps how much one upload may unpack. Anything skipped is noted on the item.
