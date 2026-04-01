import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { NormalizedListing, UnknownRecord } from "../schemas/types.js";
import { SessionStore } from "../storage/sessionStore.js";
import { jsonTextError, jsonTextResult, parseOptionalString } from "../utils/common.js";

export const saveShortlistTool: Tool = {
  name: "save_shortlist",
  description: "Persist the current shortlist for a trip session.",
  inputSchema: {
    type: "object",
    properties: {
      tripId: { type: "string", description: "Trip session id." },
      listings: { type: "array", items: { type: "object" }, description: "Shortlisted normalized listings." },
      summary: { type: "string", description: "Optional derived shortlist summary." },
    },
    required: ["tripId", "listings"],
  },
};

export async function handleSaveShortlist(raw: UnknownRecord, store: SessionStore) {
  const tripId = parseOptionalString(raw.tripId);
  const listings = Array.isArray(raw.listings) ? raw.listings as NormalizedListing[] : [];
  if (!tripId || listings.length === 0) {
    return jsonTextError("tripId and listings are required");
  }

  const trip = store.saveShortlist(tripId, listings);
  const summary = parseOptionalString(raw.summary);
  if (summary) {
    store.addDerivedSummary(tripId, summary);
  }

  return jsonTextResult({
    tripId: trip.tripId,
    shortlistCount: trip.shortlist.length,
    resourceUris: [
      `trip://${trip.tripId}/shortlist`,
    ],
  });
}
