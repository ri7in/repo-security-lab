export type D1Value = null | number | string | ArrayBuffer | ArrayBufferView;

export interface D1Result<T = Record<string, unknown>> {
  readonly results: T[];
  readonly success: boolean;
  readonly meta: Readonly<Record<string, unknown>>;
}

export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(
    statements: readonly D1PreparedStatement[],
  ): Promise<Array<D1Result<T>>>;
  exec(query: string): Promise<unknown>;
}
