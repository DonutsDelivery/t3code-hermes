import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Fork migration ids recorded in the shared ledger under ids upstream later used. Forgetting fork
 * 55 (`hermes_run_json`) lets upstream's 55 (`OrchestrationV2`) run; the nullable column stays for
 * the V1 importer. This list only shrinks.
 */
const FORK_LEDGER_ROWS = [{ id: 55, name: "ProjectionThreadsHermesRun" }] as const;

export const reconcileForkMigrations = Effect.fn("reconcileForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  for (const row of FORK_LEDGER_ROWS) {
    yield* sql`
      DELETE FROM effect_sql_migrations WHERE migration_id = ${row.id} AND name = ${row.name}
    `;
  }
});
