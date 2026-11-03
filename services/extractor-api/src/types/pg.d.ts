declare module "pg" {
  interface QueryResult {
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }

  export interface PoolClient {
    query(text: string, params?: unknown[]): Promise<QueryResult>;
    release(error?: Error | boolean): void;
  }

  export class Pool {
    constructor(config: {
      connectionString: string;
      connectionTimeoutMillis?: number;
      max?: number;
      ssl?: unknown;
    });
    query(text: string, params?: unknown[]): Promise<QueryResult>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
  }
}
