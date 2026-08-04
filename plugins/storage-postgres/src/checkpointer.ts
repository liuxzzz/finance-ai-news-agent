import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { Pool } from "pg";

export interface CreatePostgresCheckpointerOptions {
  schema?: string;
  /** Run the checkpointer's idempotent schema setup before returning it. */
  setup?: boolean;
}

/** Creates a LangGraph checkpointer backed by the application's existing pool. */
export async function createPostgresCheckpointer(
  pool: Pool,
  options: CreatePostgresCheckpointerOptions = {},
): Promise<PostgresSaver> {
  const checkpointer = new PostgresSaver(
    pool,
    undefined,
    options.schema === undefined ? undefined : { schema: options.schema },
  );

  if (options.setup !== false) {
    await checkpointer.setup();
  }

  return checkpointer;
}
