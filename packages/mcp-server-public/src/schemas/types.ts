export type UnknownRecord = Record<string, any>;

export type SearchArgs = {
  location: string;
  placeId?: string;
  checkin?: string;
  checkout?: string;
  adults?: number;
  children?: number;
  infants?: number;
  pets?: number;
  minPrice?: number;
  maxPrice?: number;
  cursor?: string;
  compact?: boolean;
  maxResults?: number;
  includeFields?: string[];
  ignoreRobotsText?: boolean;
};

export type ListingDetailsArgs = {
  id: string;
  checkin?: string;
  checkout?: string;
  adults?: number;
  children?: number;
  infants?: number;
  pets?: number;
  compact?: boolean;
  includeSections?: string[];
  ignoreRobotsText?: boolean;
};

export type TripConstraints = {
  location?: string;
  checkin?: string;
  checkout?: string;
  adults?: number;
  children?: number;
  infants?: number;
  pets?: number;
  maxPricePerNight?: number;
  minRating?: number;
  requiredBedrooms?: number;
  requiredBeds?: number;
  mustHaveAmenities?: string[];
  preferredAmenities?: string[];
  avoidAmenities?: string[];
  notes?: string[];
};

export type NormalizedListing = {
  id: string;
  title: string;
  location?: string;
  description?: string;
  bedrooms?: number;
  beds?: number;
  rating?: string;
  ratingValue?: number;
  price?: string;
  priceAmount?: number;
  highlights?: string[];
  amenities?: string[];
  houseRules?: string[];
  summary?: string;
  coordinates?: {
    latitude?: number;
    longitude?: number;
  };
  url?: string;
  source?: "search" | "listing_details";
};

export type CandidateSet = {
  tripId?: string;
  searchId?: string;
  listings: NormalizedListing[];
  createdAt: string;
};

export type ComparedListing = {
  listing: NormalizedListing;
  score: number;
  meetsHardConstraints: boolean;
  metConstraints: string[];
  unmetConstraints: string[];
};

export type DecisionLogEntry = {
  createdAt: string;
  note: string;
  decisionType?: string;
  listingId?: string;
};

export type TripSession = {
  tripId: string;
  constraints?: TripConstraints;
  candidateSet?: CandidateSet;
  shortlist: NormalizedListing[];
  decisionLog: DecisionLogEntry[];
  derivedSummaries: string[];
  createdAt: string;
  updatedAt: string;
};

export type SearchRecord = {
  searchId: string;
  createdAt: string;
  searchUrl: string;
  args: SearchArgs;
  results: NormalizedListing[];
};

export type ListingRecord = {
  id: string;
  fetchedAt: string;
  listingUrl: string;
  normalized: NormalizedListing;
  sections?: UnknownRecord[];
};
