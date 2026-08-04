import { END, MemorySaver, START, StateGraph, type GraphNode } from "@langchain/langgraph";

import {
  AgentGraphState,
  type AgentGraphStateUpdate,
  type AgentGraphStateValue,
} from "./agent-state.js";

export type AgentNodeHandler = (
  state: AgentGraphStateValue,
) => AgentGraphStateUpdate | Promise<AgentGraphStateUpdate>;

export interface AgentNodeHandlers {
  research: AgentNodeHandler;
  curateWrite: AgentNodeHandler;
  review: AgentNodeHandler;
}

export interface CreateAgentGraphOptions {
  checkpoint?: boolean;
}

export function createAgentGraph(
  handlers: AgentNodeHandlers,
  options: CreateAgentGraphOptions = {},
) {
  const research: GraphNode<typeof AgentGraphState> = handlers.research;
  const curateWrite: GraphNode<typeof AgentGraphState> = handlers.curateWrite;
  const review: GraphNode<typeof AgentGraphState> = handlers.review;

  const graph = new StateGraph(AgentGraphState)
    .addNode("research", research)
    .addNode("curate_write", curateWrite)
    .addNode("review", review)
    .addEdge(START, "research")
    .addEdge("research", "curate_write")
    .addEdge("curate_write", "review")
    .addConditionalEdges(
      "review",
      (state) => {
        if (state.approved || state.revisionCount >= state.maxRevisions) {
          return END;
        }

        return state.reviewRoute === "research" ? "research" : "curate_write";
      },
      [END, "research", "curate_write"],
    );

  if (options.checkpoint === false) {
    return graph.compile();
  }

  return graph.compile({
    checkpointer: new MemorySaver(),
  });
}
