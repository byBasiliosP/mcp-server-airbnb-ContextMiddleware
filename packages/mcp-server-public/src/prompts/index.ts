import type { GetPromptResult, Prompt } from "@modelcontextprotocol/sdk/types.js";

export const PUBLIC_PROMPTS: Prompt[] = [
  {
    name: "compare_top_listings",
    description: "Compare a small set of listings against shared constraints and summarize tradeoffs.",
    arguments: [
      { name: "tripId", required: false, description: "Optional trip session id." },
      { name: "goal", required: false, description: "What the traveler cares about most." },
    ],
  },
  {
    name: "build_trip_brief",
    description: "Turn saved constraints, shortlist, and decision notes into a concise trip brief.",
    arguments: [
      { name: "tripId", required: true, description: "Trip session id." },
    ],
  },
  {
    name: "narrow_search",
    description: "Suggest the next filter changes to narrow a result set while preserving user constraints.",
    arguments: [
      { name: "tripId", required: false, description: "Optional trip session id." },
      { name: "currentResultCount", required: false, description: "Approximate result count." },
    ],
  },
  {
    name: "explain_listing_tradeoffs",
    description: "Explain the pros, cons, and tradeoffs of one listing relative to stored trip context.",
    arguments: [
      { name: "tripId", required: false, description: "Optional trip session id." },
      { name: "listingId", required: true, description: "Listing id." },
    ],
  },
  {
    name: "public_agent_instructions",
    description: "Generic agent-facing routing instructions for hosts that want a lightweight MCP workflow guide.",
    arguments: [
      { name: "route", required: false, description: "Optional route such as search, listing_details, compare, or trip_brief." },
    ],
  },
];

export function getPrompt(name: string, args: Record<string, string | undefined>): GetPromptResult | undefined {
  if (name === "compare_top_listings") {
    return {
      description: "Generic comparison prompt for top listings.",
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Compare the top listings using only the provided constraints and resource data. Focus on tradeoffs, unmet constraints, and what additional data is still needed. Goal: ${args.goal || "rank the best options"}.`,
        },
      }],
    };
  }

  if (name === "build_trip_brief") {
    return {
      description: "Generic trip brief prompt.",
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Build a concise trip brief for tripId=${args.tripId || ""}. Use saved constraints, candidate set, shortlist, and decision log resources. Keep unknowns explicit.`,
        },
      }],
    };
  }

  if (name === "narrow_search") {
    return {
      description: "Generic narrowing prompt.",
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Propose the next narrowing step for the current search. Preserve saved constraints, avoid assumptions, and prefer deterministic filter changes over free-form preference inference. Current result count: ${args.currentResultCount || "unknown"}.`,
        },
      }],
    };
  }

  if (name === "explain_listing_tradeoffs") {
    return {
      description: "Generic listing tradeoff prompt.",
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Explain the tradeoffs of listingId=${args.listingId || ""} relative to the trip context. Separate confirmed facts from missing information.`,
        },
      }],
    };
  }

  if (name === "public_agent_instructions") {
    return {
      description: "Generic agent-facing workflow instructions.",
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            "Use this server as a workflow primitive layer, not as a full agent loop.",
            "Choose a route first: search, listing_details, compare, or trip_brief.",
            "Persist structured context with save_trip_constraints when session state matters.",
            "Build candidate sets explicitly from search results before comparison.",
            "Only use compare_listings on normalized listings or shortlist candidates.",
            "Read resources for trip state instead of rehydrating large prompts whenever possible.",
            `Requested route: ${args.route || "unspecified"}.`,
          ].join(" "),
        },
      }],
    };
  }

  return undefined;
}
