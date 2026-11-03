# Pre-release check (made-up data only)

Run before moving to the next phase or step. It seeds a fresh database with an entirely made-up firm (staff of every kind, a client-portal user, an ordinary and a walled Matter, documents, a PDF and its exhibit copy, a filed email, Matter Brain questions and notes, and a Case DNA claim), then opens every reachable page as each kind of user and reports:

- pages that fail (500) or show error text, and pages that unexpectedly don't load;
- console and page errors in the browser;
- download and connect links that don't respond.

A 404 is expected (and correct) when someone opens something they aren't allowed to see, such as a walled Matter, administrator pages, another person's mailbox, or the Matter Brain and Case DNA for a client.

```bash
# 1. Seed (needs a local PostgreSQL with pgvector; default postgres://postgres@127.0.0.1:5433/postgres)
HUIS_ALLOW_UNSANDBOXED_EXTRACTION=1 npx tsx scripts/qa/seed.ts          # writes qa-state.json
# 2. Build and start the app with the settings it printed into qa-state.json ("env"), on port 3100
npm run build && env $(node -e 'for (const [k, v] of Object.entries(require("./qa-state.json").env)) console.log(`${k}=${v}`)') npx next start -p 3100
# 3. Crawl every page as every kind of user (needs Playwright with Chromium)
node scripts/qa/crawl.cjs                                               # writes qa-crawl-report.json
```

Afterwards drop the seeded database (its name is `dbName` in `qa-state.json`). `qa-state.json` holds the made-up firm's session cookies and keys and is never committed.
