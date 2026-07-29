import { Pool, type PoolConfig } from "pg";

export function createPostgresPool(config: PoolConfig): Pool {
  return new Pool(config);
}
