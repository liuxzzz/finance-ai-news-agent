import { END, MemorySaver, START, StateGraph, type GraphNode } from "@langchain/langgraph";

import {
  AgentGraphState,
  type AgentGraphStateUpdate,
  type AgentGraphStateValue,
} from "./agent-state.js";

export type AgentRoleHandler = (
  state: AgentGraphStateValue,
) => AgentGraphStateUpdate | Promise<AgentGraphStateUpdate>;

export interface AgentRoleHandlers {
  planner: AgentRoleHandler;
  researcher: AgentRoleHandler;
  curator: AgentRoleHandler;
  editor: AgentRoleHandler;
  critic: AgentRoleHandler;
  memoryCurator: AgentRoleHandler;
}

export interface CreateAgentGraphOptions {
  checkpoint?: boolean;
}

export function createAgentGraph(
  handlers: AgentRoleHandlers,
  options: CreateAgentGraphOptions = {},
) {
  const planner: GraphNode<typeof AgentGraphState> = handlers.planner;
  const researcher: GraphNode<typeof AgentGraphState> = handlers.researcher;
  const curator: GraphNode<typeof AgentGraphState> = handlers.curator;
  const editor: GraphNode<typeof AgentGraphState> = handlers.editor;
  const critic: GraphNode<typeof AgentGraphState> = handlers.critic;
  const memoryCurator: GraphNode<typeof AgentGraphState> = handlers.memoryCurator;

  const graph = new StateGraph(AgentGraphState)
    .addNode("planner", planner)
    .addNode("researcher", researcher)
    .addNode("curator", curator)
    .addNode("editor", editor)
    .addNode("critic", critic)
    .addNode("memory_curator", memoryCurator)
    .addEdge(START, "planner")
    .addEdge("planner", "researcher")
    .addEdge("researcher", "curator")
    .addEdge("curator", "editor")
    .addEdge("editor", "critic")
    .addConditionalEdges("critic", (state) => {
      if (state.approved || state.revisionCount >= state.maxRevisions) {
        return "memory_curator";
      }

      return "editor";
    })
    .addEdge("memory_curator", END);

  if (options.checkpoint === false) {
    return graph.compile();
  }

  return graph.compile({
    checkpointer: new MemorySaver(),
  });
}
