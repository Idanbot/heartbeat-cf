import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

export function createDatabase({ initialOnly = false } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const directory = new URL("../../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    if (initialOnly && !name.startsWith("0001_")) continue;
    sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
  }

  const database = {
    sqlite,
    queries: [],
    beforeQuery: null,
    prepare(sql) {
      let bindings = [];
      const statement = {
        bind(...values) {
          bindings = values;
          return statement;
        },
        async all() {
          await database.beforeQuery?.(sql, bindings);
          database.queries.push({ sql, bindings });
          const prepared = sqlite.prepare(sql);
          const parameters = /\?\d+/.test(sql)
            ? [Object.fromEntries(bindings.map((value, index) => [String(index + 1), value]))]
            : bindings;
          const before = sqlite.prepare("SELECT total_changes() AS count").get().count;
          const results = prepared.all(...parameters).map((row) => ({ ...row }));
          const changes = sqlite.prepare("SELECT total_changes() AS count").get().count - before;
          return {
            success: true,
            results,
            meta: { changes, rows_read: results.length, rows_written: changes },
          };
        },
        async first() {
          return (await statement.all()).results[0] || null;
        },
        async run() {
          return statement.all();
        },
      };
      return statement;
    },
  };
  return database;
}
