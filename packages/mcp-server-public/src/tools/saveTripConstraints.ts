import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { TripConstraints, UnknownRecord } from "../schemas/types.js";
import { SessionStore } from "../storage/sessionStore.js";
import { jsonTextError, jsonTextResult, parseOptionalNumber, parseOptionalString, parseStringArray } from "../utils/common.js";

export const saveTripConstraintsTool: Tool = {
  name: "save_trip_constraints",
  description: "Persist structured trip constraints in a reusable session-oriented context layer.",
  inputSchema: {
    type: "object",
    properties: {
      tripId: { type: "string", description: "Optional trip session id. Created if omitted." },
      constraints: { type: "object", description: "Structured trip constraints." },
    },
    required: ["constraints"],
  },
};

export async function handleSaveTripConstraints(raw: UnknownRecord, store: SessionStore) {
  const tripId = parseOptionalString(raw.tripId);
  const constraintsRaw = (raw.constraints || {}) as UnknownRecord;
  if (typeof constraintsRaw !== "object" || Array.isArray(constraintsRaw)) {
    return jsonTextError("constraints must be an object");
  }

  const constraints: TripConstraints = {
    location: parseOptionalString(constraintsRaw.location),
    checkin: parseOptionalString(constraintsRaw.checkin),
    checkout: parseOptionalString(constraintsRaw.checkout),
    adults: parseOptionalNumber(constraintsRaw.adults),
    children: parseOptionalNumber(constraintsRaw.children),
    infants: parseOptionalNumber(constraintsRaw.infants),
    pets: parseOptionalNumber(constraintsRaw.pets),
    maxPricePerNight: parseOptionalNumber(constraintsRaw.maxPricePerNight),
    minRating: parseOptionalNumber(constraintsRaw.minRating),
    requiredBedrooms: parseOptionalNumber(constraintsRaw.requiredBedrooms),
    requiredBeds: parseOptionalNumber(constraintsRaw.requiredBeds),
    mustHaveAmenities: parseStringArray(constraintsRaw.mustHaveAmenities),
    preferredAmenities: parseStringArray(constraintsRaw.preferredAmenities),
    avoidAmenities: parseStringArray(constraintsRaw.avoidAmenities),
    notes: parseStringArray(constraintsRaw.notes),
  };

  const trip = store.saveTripConstraints(tripId, constraints);
  return jsonTextResult({
    tripId: trip.tripId,
    constraints: trip.constraints,
    resourceUris: [
      `trip://${trip.tripId}/constraints`,
    ],
  });
}
