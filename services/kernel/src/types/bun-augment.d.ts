// Augments bun:sqlite to accept unknown[] params in Statement methods.
// bun-types uses strict SQLQueryBindings; this codebase was written against
// better-sqlite3 which accepts unknown[]. This augmentation bridges the gap
// without requiring casts at 60+ call sites.
declare module "bun:sqlite" {
  interface Statement<ReturnType = unknown, ParamsType extends SQLQueryBindings | unknown[] = SQLQueryBindings[]> {
    all(...params: unknown[]): ReturnType[];
    get(...params: unknown[]): ReturnType | null;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  }
  interface Database {
    run(sql: string, ...params: unknown[]): void;
    prepare<ReturnType = unknown>(sql: string): Statement<ReturnType>;
    query<ReturnType = unknown>(sql: string): Statement<ReturnType>;
  }
}
