# Migrations

Forward-only schema migrations. Each file runs once, in lexicographic order, inside its own transaction.

## Convention

- File names: `NNN_short_description.sql` (e.g. `001_state_history.sql`)
- Three-digit prefix sorts naturally; description is informational only
- Idempotent where reasonable (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`)
- One logical change per file
- Multi-statement OK — `db.exec()` runs them all

## Adding a new migration

1. Pick the next number after the highest existing `NNN_` file
2. Write `NNN_what_youre_doing.sql`
3. Restart the server. The runner picks it up automatically and records the version in `schema_migrations`.

## Forward-only

There are no DOWN migrations. To revert: write a new forward migration that undoes the change.

## Existing inline DDL

The `db.exec(...)` blocks throughout `server/db.js` are pre-runner schema and stay where they are. New schema changes go here.

## Dry-run / inspection

```sql
-- What migrations have been applied?
SELECT version, applied_at FROM schema_migrations ORDER BY version;
```
