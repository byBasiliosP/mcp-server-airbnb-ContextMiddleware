import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { SearchArgs, UnknownRecord } from "../schemas/types.js";
import { SessionStore } from "../storage/sessionStore.js";
import { searchListings } from "../utils/airbnb.js";
import { jsonTextError, jsonTextResult, parseBoolean, parseOptionalNumber, parseOptionalString, parseStringArray, pickFields } from "../utils/common.js";

export const airbnbSearchTool: Tool = {
  name: "airbnb_search",
  description: "Search Airbnb listings using structured travel filters and return normalized results.",
  inputSchema: {
    type: "object",
    properties: {
      location: { type: "string", description: "Location to search." },
      placeId: { type: "string", description: "Optional Google Maps place id." },
      checkin: { type: "string", description: "Check-in date (YYYY-MM-DD)." },
      checkout: { type: "string", description: "Check-out date (YYYY-MM-DD)." },
      adults: { type: "number", description: "Number of adults." },
      children: { type: "number", description: "Number of children." },
      infants: { type: "number", description: "Number of infants." },
      pets: { type: "number", description: "Number of pets." },
      minPrice: { type: "number", description: "Minimum stay price." },
      maxPrice: { type: "number", description: "Maximum stay price." },
      cursor: { type: "string", description: "Pagination cursor." },
      compact: { type: "boolean", description: "Return normalized results only." },
      maxResults: { type: "number", description: "Maximum results to return." },
      includeFields: { type: "array", items: { type: "string" }, description: "Optional result field projection." },
      ignoreRobotsText: { type: "boolean", description: "Ignore robots.txt restrictions." },
    },
    required: ["location"],
  },
};

export async function handleAirbnbSearch(raw: UnknownRecord, store: SessionStore) {
  const location = parseOptionalString(raw.location);
  if (!location) {
    return jsonTextError("location is required for search");
  }

  const args: SearchArgs = {
    location,
    placeId: parseOptionalString(raw.placeId),
    checkin: parseOptionalString(raw.checkin),
    checkout: parseOptionalString(raw.checkout),
    adults: parseOptionalNumber(raw.adults),
    children: parseOptionalNumber(raw.children),
    infants: parseOptionalNumber(raw.infants),
    pets: parseOptionalNumber(raw.pets),
    minPrice: parseOptionalNumber(raw.minPrice),
    maxPrice: parseOptionalNumber(raw.maxPrice),
    cursor: parseOptionalString(raw.cursor),
    compact: parseBoolean(raw.compact, true),
    maxResults: parseOptionalNumber(raw.maxResults) ?? 8,
    includeFields: parseStringArray(raw.includeFields),
    ignoreRobotsText: parseBoolean(raw.ignoreRobotsText, false),
  };

  try {
    const result = await searchListings(args);
    const selectedNormalized = result.normalizedResults.slice(0, args.maxResults);
    const returnedResults = selectedNormalized.map((entry) => {
      if (args.includeFields && args.includeFields.length > 0) {
        return pickFields(entry as UnknownRecord, args.includeFields);
      }
      return entry;
    });
    const record = store.saveSearch(args, result.searchUrl, selectedNormalized);
    return jsonTextResult({
      searchId: record.searchId,
      searchUrl: result.searchUrl,
      paginationInfo: result.paginationInfo,
      resultsCount: returnedResults.length,
      results: returnedResults,
      resourceUris: [
        `airbnb://search/${record.searchId}/results`,
        `airbnb://search/${record.searchId}/summary`,
      ],
    });
  } catch (error) {
    return jsonTextError(error instanceof Error ? error.message : String(error));
  }
}
