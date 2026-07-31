declare module "pg" {
  export class Pool {
    constructor(config: { connectionString: string; max?: number; ssl?: unknown });
    query(
      text: string,
      params?: unknown[]
    ): Promise<{
      rows: Record<string, unknown>[];
      rowCount: number | null;
    }>;
    end(): Promise<void>;
  }
}
