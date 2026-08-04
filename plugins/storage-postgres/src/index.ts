import { Pool, type PoolConfig } from "pg";

export function createPostgresPool(config: PoolConfig): Pool {
  return new Pool(config);
}

export {
  createPostgresCheckpointer,
  type CreatePostgresCheckpointerOptions,
} from "./checkpointer.js";
export { runPostgresMigrations, type RunPostgresMigrationsOptions } from "./migrations.js";
export { PostgresRuntimeStore } from "./runtime-store.js";
