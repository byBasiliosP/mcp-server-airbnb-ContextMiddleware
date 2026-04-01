import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ListingDetailsArgs, UnknownRecord } from "../schemas/types.js";
import { SessionStore } from "../storage/sessionStore.js";
import { fetchListingDetails } from "../utils/airbnb.js";
import { jsonTextError, jsonTextResult, parseBoolean, parseOptionalNumber, parseOptionalString, parseStringArray } from "../utils/common.js";

export const airbnbListingDetailsTool: Tool = {
  name: "airbnb_listing_details",
  description: "Fetch one Airbnb listing and return normalized details plus stable resource URIs.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Airbnb listing id." },
      checkin: { type: "string", description: "Check-in date (YYYY-MM-DD)." },
      checkout: { type: "string", description: "Check-out date (YYYY-MM-DD)." },
      adults: { type: "number", description: "Number of adults." },
      children: { type: "number", description: "Number of children." },
      infants: { type: "number", description: "Number of infants." },
      pets: { type: "number", description: "Number of pets." },
      compact: { type: "boolean", description: "Return compact sections." },
      includeSections: { type: "array", items: { type: "string" }, description: "Restrict returned sections." },
      ignoreRobotsText: { type: "boolean", description: "Ignore robots.txt restrictions." },
    },
    required: ["id"],
  },
};

export async function handleAirbnbListingDetails(raw: UnknownRecord, store: SessionStore) {
  const id = parseOptionalString(raw.id);
  if (!id) {
    return jsonTextError("id is required for listing details");
  }

  const args: ListingDetailsArgs = {
    id,
    checkin: parseOptionalString(raw.checkin),
    checkout: parseOptionalString(raw.checkout),
    adults: parseOptionalNumber(raw.adults),
    children: parseOptionalNumber(raw.children),
    infants: parseOptionalNumber(raw.infants),
    pets: parseOptionalNumber(raw.pets),
    compact: parseBoolean(raw.compact, true),
    includeSections: parseStringArray(raw.includeSections),
    ignoreRobotsText: parseBoolean(raw.ignoreRobotsText, false),
  };

  try {
    const result = await fetchListingDetails(args);
    const normalized = {
      id,
      title: result.normalized.title || `Listing ${id}`,
      url: result.listingUrl,
      ...result.normalized,
    };
    store.saveListing({
      id,
      fetchedAt: new Date().toISOString(),
      listingUrl: result.listingUrl,
      normalized,
      sections: result.sections,
    });
    return jsonTextResult({
      listingId: id,
      listingUrl: result.listingUrl,
      normalized,
      sections: args.compact ? result.compactSections : result.sections,
      resourceUris: [
        `airbnb://listing/${id}`,
        `airbnb://listing/${id}/normalized`,
      ],
    });
  } catch (error) {
    return jsonTextError(error instanceof Error ? error.message : String(error));
  }
}
