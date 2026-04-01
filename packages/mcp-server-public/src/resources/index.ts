import type { Resource, ResourceTemplate } from "@modelcontextprotocol/sdk/types.js";
import { SessionStore } from "../storage/sessionStore.js";
import { toJsonResource } from "../utils/common.js";

export const PUBLIC_RESOURCE_TEMPLATES: ResourceTemplate[] = [
  { uriTemplate: "airbnb://listing/{listingId}", name: "listing_raw", mimeType: "application/json", description: "Stored listing detail payload." },
  { uriTemplate: "airbnb://listing/{listingId}/normalized", name: "listing_normalized", mimeType: "application/json", description: "Normalized listing view." },
  { uriTemplate: "airbnb://search/{searchId}/results", name: "search_results", mimeType: "application/json", description: "Stored normalized search results." },
  { uriTemplate: "airbnb://search/{searchId}/summary", name: "search_summary", mimeType: "application/json", description: "Stored search summary and metadata." },
  { uriTemplate: "trip://{tripId}/constraints", name: "trip_constraints", mimeType: "application/json", description: "Structured trip constraints." },
  { uriTemplate: "trip://{tripId}/candidate_set", name: "trip_candidate_set", mimeType: "application/json", description: "Stored candidate set for a trip." },
  { uriTemplate: "trip://{tripId}/shortlist", name: "trip_shortlist", mimeType: "application/json", description: "Stored shortlist for a trip." },
  { uriTemplate: "trip://{tripId}/decision_log", name: "trip_decision_log", mimeType: "application/json", description: "Decision log for a trip." },
];

export function listResources(store: SessionStore): Resource[] {
  const resources: Resource[] = [];
  for (const search of store.listSearches()) {
    resources.push(
      { uri: `airbnb://search/${search.searchId}/results`, name: `search_results_${search.searchId}`, mimeType: "application/json", description: "Normalized search results." },
      { uri: `airbnb://search/${search.searchId}/summary`, name: `search_summary_${search.searchId}`, mimeType: "application/json", description: "Search metadata summary." },
    );
  }
  for (const listing of store.listListings()) {
    resources.push(
      { uri: `airbnb://listing/${listing.id}`, name: `listing_${listing.id}`, mimeType: "application/json", description: "Stored listing detail payload." },
      { uri: `airbnb://listing/${listing.id}/normalized`, name: `listing_normalized_${listing.id}`, mimeType: "application/json", description: "Normalized listing view." },
    );
  }
  for (const trip of store.listTrips()) {
    resources.push(
      { uri: `trip://${trip.tripId}/constraints`, name: `trip_constraints_${trip.tripId}`, mimeType: "application/json", description: "Trip constraints." },
      { uri: `trip://${trip.tripId}/candidate_set`, name: `trip_candidate_set_${trip.tripId}`, mimeType: "application/json", description: "Trip candidate set." },
      { uri: `trip://${trip.tripId}/shortlist`, name: `trip_shortlist_${trip.tripId}`, mimeType: "application/json", description: "Trip shortlist." },
      { uri: `trip://${trip.tripId}/decision_log`, name: `trip_decision_log_${trip.tripId}`, mimeType: "application/json", description: "Trip decision log." },
    );
  }
  return resources;
}

export function readResource(store: SessionStore, uri: string) {
  const searchResultsMatch = uri.match(/^airbnb:\/\/search\/([^/]+)\/results$/);
  if (searchResultsMatch) {
    const search = store.getSearch(searchResultsMatch[1]);
    return search ? [toJsonResource(uri, search.results)] : undefined;
  }

  const searchSummaryMatch = uri.match(/^airbnb:\/\/search\/([^/]+)\/summary$/);
  if (searchSummaryMatch) {
    const search = store.getSearch(searchSummaryMatch[1]);
    return search ? [toJsonResource(uri, search)] : undefined;
  }

  const listingNormalizedMatch = uri.match(/^airbnb:\/\/listing\/([^/]+)\/normalized$/);
  if (listingNormalizedMatch) {
    const listing = store.getListing(listingNormalizedMatch[1]);
    return listing ? [toJsonResource(uri, listing.normalized)] : undefined;
  }

  const listingMatch = uri.match(/^airbnb:\/\/listing\/([^/]+)$/);
  if (listingMatch) {
    const listing = store.getListing(listingMatch[1]);
    return listing ? [toJsonResource(uri, listing)] : undefined;
  }

  const tripConstraintsMatch = uri.match(/^trip:\/\/([^/]+)\/constraints$/);
  if (tripConstraintsMatch) {
    const trip = store.getTrip(tripConstraintsMatch[1]);
    return trip ? [toJsonResource(uri, trip.constraints || {})] : undefined;
  }

  const tripCandidateSetMatch = uri.match(/^trip:\/\/([^/]+)\/candidate_set$/);
  if (tripCandidateSetMatch) {
    const trip = store.getTrip(tripCandidateSetMatch[1]);
    return trip ? [toJsonResource(uri, trip.candidateSet || {})] : undefined;
  }

  const tripShortlistMatch = uri.match(/^trip:\/\/([^/]+)\/shortlist$/);
  if (tripShortlistMatch) {
    const trip = store.getTrip(tripShortlistMatch[1]);
    return trip ? [toJsonResource(uri, trip.shortlist)] : undefined;
  }

  const tripDecisionLogMatch = uri.match(/^trip:\/\/([^/]+)\/decision_log$/);
  if (tripDecisionLogMatch) {
    const trip = store.getTrip(tripDecisionLogMatch[1]);
    return trip ? [toJsonResource(uri, trip.decisionLog)] : undefined;
  }

  return undefined;
}
