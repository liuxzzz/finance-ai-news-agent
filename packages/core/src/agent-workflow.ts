import { AgentGraphStateValueSchema, type AgentGraphStateValue } from "./agent-state.js";
import type { createAgentGraph } from "./agent-graph.js";

export interface AgentWorkflowInput {
  runId: string;
  topic: string;
  maxRevisions: number;
}

export interface AgentWorkflow {
  start(input: AgentWorkflowInput): Promise<AgentGraphStateValue>;
  resume(input: AgentWorkflowInput): Promise<AgentGraphStateValue>;
}

type CompiledAgentGraph = ReturnType<typeof createAgentGraph>;

/**
 * Keeps LangGraph checkpoint semantics behind a small runtime-facing boundary.
 */
export class LangGraphAgentWorkflow implements AgentWorkflow {
  constructor(private readonly graph: CompiledAgentGraph) {}

  async start(input: AgentWorkflowInput): Promise<AgentGraphStateValue> {
    const result = await this.graph.invoke(
      {
        runId: input.runId,
        topic: input.topic,
        maxRevisions: input.maxRevisions,
      },
      graphConfig(input.runId),
    );

    return AgentGraphStateValueSchema.parse(result);
  }

  async resume(input: AgentWorkflowInput): Promise<AgentGraphStateValue> {
    const config = graphConfig(input.runId);
    const snapshot = await this.graph.getState(config);

    if (Object.keys(snapshot.values).length === 0) {
      return this.start(input);
    }

    if (snapshot.next.length === 0) {
      return AgentGraphStateValueSchema.parse(snapshot.values);
    }

    const result = await this.graph.invoke(null, config);
    return AgentGraphStateValueSchema.parse(result);
  }
}

function graphConfig(runId: string) {
  return {
    configurable: {
      thread_id: runId,
    },
  };
}
