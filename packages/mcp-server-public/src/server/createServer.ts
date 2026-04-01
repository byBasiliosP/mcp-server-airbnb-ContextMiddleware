import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { PUBLIC_PROMPTS, getPrompt } from "../prompts/index.js";
import { PUBLIC_RESOURCE_TEMPLATES, listResources, readResource } from "../resources/index.js";
import { SessionStore } from "../storage/sessionStore.js";
import { airbnbListingDetailsTool, handleAirbnbListingDetails } from "../tools/airbnbListingDetails.js";
import { airbnbSearchTool, handleAirbnbSearch } from "../tools/airbnbSearch.js";
import { appendTripDecisionTool, handleAppendTripDecision } from "../tools/appendTripDecision.js";
import { buildCandidateSetTool, handleBuildCandidateSet } from "../tools/buildCandidateSet.js";
import { clearTripSessionTool, handleClearTripSession } from "../tools/clearTripSession.js";
import { compareListingsTool, handleCompareListings } from "../tools/compareListings.js";
import { saveShortlistTool, handleSaveShortlist } from "../tools/saveShortlist.js";
import { saveTripConstraintsTool, handleSaveTripConstraints } from "../tools/saveTripConstraints.js";
import type { UnknownRecord } from "../schemas/types.js";

const PUBLIC_TOOLS: Tool[] = [
  airbnbSearchTool,
  airbnbListingDetailsTool,
  compareListingsTool,
  buildCandidateSetTool,
  saveTripConstraintsTool,
  appendTripDecisionTool,
  saveShortlistTool,
  clearTripSessionTool,
];

export function createPublicServer() {
  const store = new SessionStore();
  const server = new Server(
    {
      name: "airbnb-public",
      version: process.env.MCP_SERVER_VERSION || "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: PUBLIC_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments || {}) as UnknownRecord;
    switch (name) {
      case "airbnb_search":
        return handleAirbnbSearch(args, store);
      case "airbnb_listing_details":
        return handleAirbnbListingDetails(args, store);
      case "compare_listings":
        return handleCompareListings(args, store);
      case "build_candidate_set":
        return handleBuildCandidateSet(args, store);
      case "save_trip_constraints":
        return handleSaveTripConstraints(args, store);
      case "append_trip_decision":
        return handleAppendTripDecision(args, store);
      case "save_shortlist":
        return handleSaveShortlist(args, store);
      case "clear_trip_session":
        return handleClearTripSession(args, store);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: listResources(store),
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: PUBLIC_RESOURCE_TEMPLATES,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const contents = readResource(store, request.params.uri);
    if (!contents) {
      throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${request.params.uri}`);
    }
    return { contents };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PUBLIC_PROMPTS,
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const prompt = getPrompt(request.params.name, (request.params.arguments || {}) as Record<string, string | undefined>);
    if (!prompt) {
      throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: ${request.params.name}`);
    }
    return prompt;
  });

  return server;
}
