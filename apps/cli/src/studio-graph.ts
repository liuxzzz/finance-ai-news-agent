import { createAgentGraph } from "@finance-ai-news-agent/core";

import { fixtureHandlers } from "./fixture-handlers.js";

// Agent Server owns checkpoint persistence when this graph is loaded in Studio.
export const graph = createAgentGraph(fixtureHandlers, { checkpointer: false });
