# Training Policy Integrity Check

Script: `src/scripts/check-training-policy-integrity.ts`

This read-only check covers AI training proposals (`aitrainingpolicies`, with their versions and audit log). For each proposal it reports data problems, such as a proposal pointing at a version that doesn't exist, or an approval with no audit record. It also lists the repair each problem would get. The release checklist requires this dry run against production before AI training is released.

On staging and production it only reads. Repairs are only available against a local database. If production ever needs a repair, share the report so that repair can be approved separately.

## What it reports

- Which training collections exist. Before anything has been saved, none do.
- How many proposals have findings, and how many of those are critical.
- One JSON line per proposal with findings, containing:
  - proposal ID and organization ID
  - status and current version
  - the versions that exist
  - issue codes such as `critical:missing_current_version`
  - the planned repair, written as status and version numbers only
- The database commands it sent, by name and count.

It never prints proposal titles, rule text, staff names, customer information or the connection string.

## What changed from the old invocation

The old command read `MONGODB_URI` and ran with `--org` and `--apply --confirm-db`. Loading the app code that way filled `MONGODB_URI` from `.env`, which is production, and started the app logger. In development mode that logger writes warning logs into whatever database is connected, and in production mode it opens its own log connection to `.env`'s database.

The new command:

- connects only through `TRAINING_INTEGRITY_MONGODB_URI` and never uses `MONGODB_URI` or `.env`
- requires `--env` and `--db`
- loads the app code with the logger silenced, and stops if the logger isn't silent or if any database connection opened while loading
- refuses `--apply` on staging and production

## Before you run it: use a read-only database user

1. In MongoDB Atlas, open Database Access and add a new database user with password authentication.
2. Grant only the built-in `read` role on the production database. Do not use `readWrite`, `readWriteAnyDatabase`, `dbAdmin` or any admin role.
3. Restrict the user to the production cluster.
4. Mark it as a temporary user, for example expiring after one day.
5. Run the check from a machine already on the cluster's IP access list, such as the backend server.

The same temporary read-only user can be used for the legacy coaching audit (`docs/legacy-coaching-audit.md`).

The check refuses to run on staging or production in any of these cases. There is no override:

- the user can change data
- the connection is not signed in as a database user
- the permissions cannot be checked

## Run it

Run from the `suprah-backend` folder of a checkout that includes this change and has `node_modules` installed.

Pass the exact database name the production backend uses. `verify-env.sh` in the release kit prints it. The backend's production database guard expects `test`, which is MongoDB's default when the connection string names no database. If the connection string does include a database name, it must match `--db`.

Bash (Linux or macOS):

```
read -rs TRAINING_INTEGRITY_MONGODB_URI && export TRAINING_INTEGRITY_MONGODB_URI
npx ts-node --transpile-only src/scripts/check-training-policy-integrity.ts --env=production --db=<database name>
unset TRAINING_INTEGRITY_MONGODB_URI
```

When `read -rs` waits for input, paste the connection string for the read-only user and press Enter.

PowerShell (Windows):

```
$env:TRAINING_INTEGRITY_MONGODB_URI = Read-Host "Read-only connection string"
npx ts-node --transpile-only src/scripts/check-training-policy-integrity.ts --env=production --db=<database name>
Remove-Item Env:TRAINING_INTEGRITY_MONGODB_URI
```

Optional flags:

- `--org=<organization id>` checks one organization only.
- `--help` shows usage.
- `--apply --confirm-db=<database name>` applies the planned repairs. It is local only, refused for staging and production, and `--confirm-db` must equal `--db`.

## Checks it makes before reading

1. `TRAINING_INTEGRITY_MONGODB_URI` is set.
2. `--env` and `--db` are both given. The database named in the connection string matches `--db`, and `--env=local` only works with a database on the same computer.
3. `--apply` is only allowed with `--env=local`, and `--confirm-db` matches `--db`.
4. App code loads with the logger silenced. It stops if the logger is not silent, or if any database connection opened while loading.
5. It connects to exactly `--db`, reads from a secondary when one is available, has index and collection creation turned off, and records every command it sends.
6. On staging and production, the signed-in user is read-only.
7. The database has an `organizations` collection. If it doesn't, `--db` is probably wrong and the check stops.

If any check fails, it prints the reason and exits with code 1 without reading training data. A dry run that sends any command other than a read also exits with code 1.

## Reading the results

- `Training collections: none yet` with `Proposals with findings: 0` is the expected production result before training is released.
- **Critical findings** block approval in the app until repaired. Planned repairs only ever send a proposal back for review or withdraw it. They never approve anything, and never edit versions or existing audit entries.
- **Warnings** (`unadopted_versions`, `stale_pending_audit`) don't block anything.
- `Database commands sent` should only list read commands: `connectionStatus`, `listCollections`, `find`, and sometimes `getMore`.

## What to send back

Send the full output to the CRM team. It contains IDs, statuses, version numbers, issue codes and command counts only. Afterwards, delete the temporary database user or let it expire.

## Example output

Fictional records in a local, isolated test database:

```
Training integrity check (read-only)
Environment: local
Database: integrity_demo
Hosts: 127.0.0.1
Credentials: not signed in (no database user)
Scope: all organizations
Training collections: aitrainingpolicies, aitrainingpolicyversions, aitrainingauditlogs
Proposals with findings: 1 (critical: 1)
{"policyId":"66f000000000000000000001","organizationId":"64f0000000000000000000a1","status":"in_review","currentVersion":3,"versions":[1,2],"issues":["critical:missing_current_version","critical:missing_submitted_version"],"plannedRepair":{"toStatus":"changes_requested","set":{"currentVersion":2,"adoptedVersions":[1,2],"status":"changes_requested"},"unset":["submittedVersion"],"steps":["Point the proposal back to version 2, the latest version that exists.","Send it back to the author so a complete version is reviewed again.","Clear the reference to the missing submitted version."]}}
Dry run only. Nothing was changed. To apply the planned repairs to this local database, re-run with --apply --confirm-db=integrity_demo.
Database commands sent: connectionStatus 1, find 3, listCollections 1
```

On staging and production, the dry-run line has no repair hint.
