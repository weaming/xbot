/**
 * `bun:sqlite` 的最小类型声明：Job 存储只在 bun 运行时加载。
 *
 * 与 server/bun-http.d.ts 同样取舍：只声明实际用到的形状，
 * 不引入 @types/bun 以避免整套 Bun 全局与本项目的 node 类型环境互相干扰。
 */
declare module "bun:sqlite" {
    export interface SQLiteRunResult {
        changes: number;
        lastInsertRowid: number | bigint;
    }

    export interface SQLiteStatement<Row = Record<string, unknown>> {
        all(...params: unknown[]): Row[];
        get(...params: unknown[]): Row | null;
        run(...params: unknown[]): SQLiteRunResult;
        finalize(): void;
    }

    export class Database {
        constructor(filename?: string, options?: { create?: boolean; readonly?: boolean; strict?: boolean });
        prepare<Row = Record<string, unknown>>(sql: string): SQLiteStatement<Row>;
        query<Row = Record<string, unknown>>(sql: string): SQLiteStatement<Row>;
        run(sql: string, ...params: unknown[]): SQLiteRunResult;
        exec(sql: string): void;
        transaction<T>(fn: (...args: never[]) => T): (...args: never[]) => T;
        close(throwOnError?: boolean): void;
    }
}
