import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { UnknownRecord } from "../schemas/types.js";
import { SessionStore } from "../storage/sessionStore.js";
import { jsonTextError, jsonTextResult, parseOptionalString } from "../utils/common.js";

export const clearTripSessionTool: Tool = {
  name: "clear_trip_session",
  description: "Reset a trip working session and remove stored constraints, shortlist, and decision log entries.",
  inputSchema: {
    type: "object",
    properties: {
      tripId: { type: "string", description: "Trip session id." },
    },
    required: ["tripId"],
  },
};

export async function handleClearTripSession(raw: UnknownRecord, store: SessionStore) {
  const tripId = parseOptionalString(raw.tripId);
  if (!tripId) {
    return jsonTextError("tripId is required");
  }

  const cleared = store.clearTrip(tripId);
  return jsonTextResult({
    tripId,
    cleared,
  });
}
