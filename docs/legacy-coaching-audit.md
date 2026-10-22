# Legacy Coaching Audit

Script: `src/scripts/audit-legacy-coaching.ts`

This is a read-only report on existing Alex coaching records (the `aiagentcoachingrules` collection). Each active and disabled record is checked against the current safety rules. These are the same checks that now run when a manager creates coaching, edits its text or turns it back on.

The audit changes nothing. Its results decide whether Alex should skip unsafe active coaching at runtime. That decision is deferred until the results are reviewed.

## What it reports

- How many coaching records were examined, split into active and disabled
- How many pass and how many fail the current safety rules, for active and disabled records separately
- Issue categories with counts:
  - `guardrail_figure`: prices, payments, rates or other money figures
  - `guardrail_topic`: pricing, financing, discount, trade-in or availability claims
  - `safety_bypass`: tells Alex to skip a safety rule, such as opt-outs, handoffs, AI disclosure or mandatory checks
- A summary for each organization
- Each failing record as an ID only, with its organization, status, channel, usage count, last-used date and issue codes
- Deleted records are counted but not examined

It never prints coaching text, the Alex message the coaching was written against, staff names, customer information or the connection string.

## What it never does

- It never inserts, updates, deletes or rewrites anything, and never creates an index or a collection. It reads two collections: `aiagentcoachingrules` and `organizations` (names only).
- It never uses `MONGODB_URI` or any `.env` file. It only connects to the database named in `COACHING_AUDIT_MONGODB_URI`.
- It loads the app code with the app logger silenced, so no log stream can write to any database while it runs.

## Before you run it: use a read-only database user

Create a temporary database user that can only read the production database:

1. In MongoDB Atlas, open Database Access and add a new database user with password authentication.
2. Under privileges, grant only the built-in `read` role on the production database. Do not use `readWrite`, `readWriteAnyDatabase`, `dbAdmin` or any admin role.
3. Restrict the user to the production cluster.
4. Mark it as a temporary user, for example expiring after one day.
5. Run the audit from a machine that is already on the cluster's IP access list, such as the backend server.

Atlas does not allow `db.createUser` from mongosh, so create the user in the Atlas UI or API. On a self-managed MongoDB, the equivalent is:

```
use admin
db.createUser({ user: "coaching_audit_ro", pwd: passwordPrompt(), roles: [{ role: "read", db: "<database name>" }] })
```

Before it reads anything, the script checks the signed-in user's privileges. For `--env=staging` or `--env=production`, it refuses to run in any of these cases. There is no override:

- the user can change data
- the connection is not signed in as a database user
- the privileges cannot be checked

## Run it

Run from the `suprah-backend` folder of a checkout that includes this change and has `node_modules` installed. Replace the placeholders.

`<database name>` must be the exact database name the production backend uses. `verify-env.sh` in the release kit prints it. The backend's production database guard expects `test`, which is MongoDB's default when the connection string names no database. If the connection string does include a database name, it must match `--db`.

Bash (Linux or macOS). `read -rs` keeps the password out of the shell history:

```
read -rs COACHING_AUDIT_MONGODB_URI && export COACHING_AUDIT_MONGODB_URI
npx ts-node --transpile-only src/scripts/audit-legacy-coaching.ts --env=production --db=<database name>
unset COACHING_AUDIT_MONGODB_URI
```

When `read -rs` waits for input, paste the connection string for the read-only user, for example `mongodb+srv://coaching_audit_ro:<password>@<cluster host>/<database name>?retryWrites=true&w=majority`, and press Enter.

PowerShell (Windows):

```
$env:COACHING_AUDIT_MONGODB_URI = Read-Host "Read-only connection string"
npx ts-node --transpile-only src/scripts/audit-legacy-coaching.ts --env=production --db=<database name>
Remove-Item Env:COACHING_AUDIT_MONGODB_URI
```

Optional flags:

- `--org=<organization id>` audits one organization only.
- `--json` prints the full report as JSON. It can be saved with `> coaching-audit.json`.
- `--help` shows usage.

## Checks it makes before reading

1. `COACHING_AUDIT_MONGODB_URI` is set. `MONGODB_URI` and `.env` are never used as a fallback.
2. `--env` and `--db` are both given. The database named in the connection string matches `--db`. `--env=local` only works with a database on the same computer.
3. It connects to exactly `--db`, reads from a secondary when one is available, and has index and collection creation turned off.
4. On staging and production, the signed-in user is read-only.
5. The coaching collection exists in that database. If it doesn't, `--db` is probably wrong and the script stops.

If any check fails, it prints the reason and exits with code 1 without reading coaching records.

## Reading the results

- **Failing active records** are coaching that Alex can currently receive in its prompt for SMS, webchat and Shadow drafts. The usual relevance check and the 50-most-recent limit still apply. This number decides whether runtime filtering is needed.
- **Failing disabled records** can no longer be turned back on. The CRM now refuses to re-enable coaching that fails the safety check, so they need no action unless someone wants to rewrite their text.
- **Records with no text** are skipped by Alex and counted as passing.

## What to send back

Send the text output, or the JSON file, to the CRM team. It contains counts, issue codes, record IDs and organization IDs and names. It contains no coaching text, customer information or credentials. Afterwards, delete the temporary database user or let it expire.

## Example output

Fictional records in a local, isolated test database:

```
Legacy coaching audit (read-only)
Environment: local
Database: coaching_audit_demo
Hosts: 127.0.0.1
Credentials: not signed in (no database user)
Scope: all organizations
Generated: 2026-10-21T21:28:19.322Z

Coaching records examined: 5 (active 3, disabled 2)
Passing current safety rules: 2
Failing current safety rules: 3 (active 1, disabled 2)
Not examined: 1 deleted

Issue categories
- guardrail_figure: 1 record (1 active). Prices, payments, rates or other money figures
- guardrail_topic: 1 record (0 active). Pricing, financing, discount, trade-in or availability claims
- safety_bypass: 1 record (0 active). Tells Alex to skip a safety rule such as opt-outs, handoffs, AI disclosure or mandatory checks

By organization
- 64f0000000000000000000a1 (Fictional Motors North): 3 examined (active 2, disabled 1), 1 passing, 2 failing (active 1, disabled 1). Issues: guardrail_figure 1, safety_bypass 1
- 64f0000000000000000000b2 (Fictional Motors South): 2 examined (active 1, disabled 1), 1 passing, 1 failing (active 0, disabled 1). Issues: guardrail_topic 1

Failing records (ids only, no coaching text)
- 65f000000000000000000002 org 64f0000000000000000000a1 active, channel all, used 7 times, last used 2026-09-01: guardrail_figure
- 65f000000000000000000005 org 64f0000000000000000000b2 disabled, channel all, used 1 time, last used 2026-09-01: guardrail_topic
- 65f000000000000000000003 org 64f0000000000000000000a1 disabled, channel all, used 0 times: safety_bypass

Nothing was changed. This audit only reads coaching records.
```
