import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ComparedListing, NormalizedListing, TripConstraints, UnknownRecord } from "../schemas/types.js";
import { SessionStore } from "../storage/sessionStore.js";
import { jsonTextError, jsonTextResult, parseOptionalNumber, parseOptionalString, parseStringArray } from "../utils/common.js";

export const compareListingsTool: Tool = {
  name: "compare_listings",
  description: "Compare normalized listings against shared trip constraints using deterministic scoring.",
  inputSchema: {
    type: "object",
    properties: {
      tripId: { type: "string", description: "Optional trip session id." },
      listings: { type: "array", items: { type: "object" }, description: "Normalized listings to compare." },
      constraints: { type: "object", description: "Optional trip constraints override." },
    },
    required: ["listings"],
  },
};

function normalizeConstraints(raw: UnknownRecord | undefined): TripConstraints {
  return {
    location: parseOptionalString(raw?.location),
    checkin: parseOptionalString(raw?.checkin),
    checkout: parseOptionalString(raw?.checkout),
    adults: parseOptionalNumber(raw?.adults),
    children: parseOptionalNumber(raw?.children),
    infants: parseOptionalNumber(raw?.infants),
    pets: parseOptionalNumber(raw?.pets),
    maxPricePerNight: parseOptionalNumber(raw?.maxPricePerNight),
    minRating: parseOptionalNumber(raw?.minRating),
    requiredBedrooms: parseOptionalNumber(raw?.requiredBedrooms),
    requiredBeds: parseOptionalNumber(raw?.requiredBeds),
    mustHaveAmenities: parseStringArray(raw?.mustHaveAmenities),
    preferredAmenities: parseStringArray(raw?.preferredAmenities),
    avoidAmenities: parseStringArray(raw?.avoidAmenities),
    notes: parseStringArray(raw?.notes),
  };
}

function compareOne(listing: NormalizedListing, constraints: TripConstraints): ComparedListing {
  let score = 0;
  const metConstraints: string[] = [];
  const unmetConstraints: string[] = [];

  if (typeof constraints.requiredBedrooms === "number") {
    if (typeof listing.bedrooms === "number" && listing.bedrooms >= constraints.requiredBedrooms) {
      score += 25;
      metConstraints.push(`bedrooms >= ${constraints.requiredBedrooms}`);
    } else {
      unmetConstraints.push(`bedrooms < ${constraints.requiredBedrooms}`);
    }
  }

  if (typeof constraints.requiredBeds === "number") {
    if (typeof listing.beds === "number" && listing.beds >= constraints.requiredBeds) {
      score += 20;
      metConstraints.push(`beds >= ${constraints.requiredBeds}`);
    } else {
      unmetConstraints.push(`beds < ${constraints.requiredBeds}`);
    }
  }

  if (typeof constraints.maxPricePerNight === "number") {
    if (typeof listing.priceAmount === "number" && listing.priceAmount <= constraints.maxPricePerNight) {
      score += 20;
      metConstraints.push(`price <= ${constraints.maxPricePerNight}`);
    } else {
      unmetConstraints.push(`price > ${constraints.maxPricePerNight}`);
    }
  }

  if (typeof constraints.minRating === "number") {
    if (typeof listing.ratingValue === "number" && listing.ratingValue >= constraints.minRating) {
      score += 15;
      metConstraints.push(`rating >= ${constraints.minRating}`);
    } else {
      unmetConstraints.push(`rating < ${constraints.minRating}`);
    }
  }

  const amenities = new Set((listing.amenities || []).map((value) => value.toLowerCase()));
  for (const amenity of constraints.mustHaveAmenities || []) {
    if (amenities.has(amenity.toLowerCase())) {
      score += 8;
      metConstraints.push(`must-have amenity: ${amenity}`);
    } else {
      unmetConstraints.push(`missing amenity: ${amenity}`);
    }
  }
  for (const amenity of constraints.preferredAmenities || []) {
    if (amenities.has(amenity.toLowerCase())) {
      score += 4;
      metConstraints.push(`preferred amenity: ${amenity}`);
    }
  }
  for (const amenity of constraints.avoidAmenities || []) {
    if (amenities.has(amenity.toLowerCase())) {
      score -= 6;
      unmetConstraints.push(`avoid amenity present: ${amenity}`);
    }
  }

  return {
    listing,
    score,
    meetsHardConstraints: unmetConstraints.every((item) => !/^bedrooms|^beds|^price|^rating|^missing amenity/.test(item)),
    metConstraints,
    unmetConstraints,
  };
}

export async function handleCompareListings(raw: UnknownRecord, store: SessionStore) {
  const listings = Array.isArray(raw.listings) ? raw.listings as NormalizedListing[] : [];
  if (listings.length === 0) {
    return jsonTextError("listings is required for comparison");
  }

  const tripId = parseOptionalString(raw.tripId);
  const tripConstraints = tripId ? store.getTrip(tripId)?.constraints : undefined;
  const constraints = {
    ...tripConstraints,
    ...normalizeConstraints((raw.constraints || {}) as UnknownRecord),
  };

  const compared = listings
    .map((listing) => compareOne(listing, constraints))
    .sort((left, right) => right.score - left.score);

  return jsonTextResult({
    tripId,
    constraints,
    compared,
  });
}
