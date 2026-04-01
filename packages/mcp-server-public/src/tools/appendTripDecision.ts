import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { UnknownRecord } from "../schemas/types.js";
import { SessionStore } from "../storage/sessionStore.js";
import { jsonTextError, jsonTextResult, parseOptionalString } from "../utils/common.js";

export const appendTripDecisionTool: Tool = {
  name: "append_trip_decision",
  description: "Append a decision note to the trip decision log.",
  inputSchema: {
    type: "object",
    properties: {
      tripId: { type: "string", description: "Trip session id." },
      note: { type: "string", description: "Decision note to append." },
      decisionType: { type: "string", description: "Optional decision type such as reject, prefer, or question." },
      listingId: { type: "string", description: "Optional associated listing id." },
    },
    required: ["tripId", "note"],
  },
};

export async function handleAppendTripDecision(raw: UnknownRecord, store: SessionStore) {
  const tripId = parseOptionalString(raw.tripId);
  const note = parseOptionalString(raw.note);
  if (!tripId || !note) {
    return jsonTextError("tripId and note are required");
  }

  const trip = store.appendTripDecision(tripId, {
    note,
    decisionType: parseOptionalString(raw.decisionType),
    listingId: parseOptionalString(raw.listingId),
  });

  return jsonTextResult({
    tripId: trip.tripId,
    decisionLogCount: trip.decisionLog.length,
    resourceUris: [
      `trip://${trip.tripId}/decision_log`,
    ],
  });
}
