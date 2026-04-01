import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CandidateSet, NormalizedListing, UnknownRecord } from "../schemas/types.js";
import { SessionStore } from "../storage/sessionStore.js";
import { jsonTextError, jsonTextResult, parseOptionalNumber, parseOptionalString } from "../utils/common.js";

export const buildCandidateSetTool: Tool = {
  name: "build_candidate_set",
  description: "Create a normalized candidate set from search results and optionally attach it to a trip session.",
  inputSchema: {
    type: "object",
    properties: {
      tripId: { type: "string", description: "Optional trip session id." },
      searchId: { type: "string", description: "Optional stored search id." },
      results: { type: "array", items: { type: "object" }, description: "Normalized search results." },
      limit: { type: "number", description: "Optional maximum candidate count." },
    },
  },
};

export async function handleBuildCandidateSet(raw: UnknownRecord, store: SessionStore) {
  const tripId = parseOptionalString(raw.tripId);
  const searchId = parseOptionalString(raw.searchId);
  const limit = parseOptionalNumber(raw.limit);
  const inputResults = Array.isArray(raw.results) ? raw.results as NormalizedListing[] : [];
  const storedResults = searchId ? (store.getSearch(searchId)?.results || []) : [];
  const listings = (inputResults.length > 0 ? inputResults : storedResults).slice(0, limit || undefined);
  if (listings.length === 0) {
    return jsonTextError("results or searchId with stored results is required");
  }

  const candidateSet: CandidateSet = {
    tripId,
    searchId,
    listings,
    createdAt: new Date().toISOString(),
  };
  const trip = store.saveCandidateSet(tripId, candidateSet);

  return jsonTextResult({
    tripId: trip.tripId,
    candidateSet,
    resourceUris: [
      `trip://${trip.tripId}/candidate_set`,
    ],
  });
}
