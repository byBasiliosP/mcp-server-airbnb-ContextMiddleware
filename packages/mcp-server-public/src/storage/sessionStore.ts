import { randomUUID } from "crypto";
import type {
  CandidateSet,
  DecisionLogEntry,
  ListingRecord,
  NormalizedListing,
  SearchRecord,
  TripConstraints,
  TripSession,
} from "../schemas/types.js";

export class SessionStore {
  private searches = new Map<string, SearchRecord>();
  private listings = new Map<string, ListingRecord>();
  private trips = new Map<string, TripSession>();

  saveSearch(args: SearchRecord["args"], searchUrl: string, results: NormalizedListing[]) {
    const searchId = randomUUID();
    const createdAt = new Date().toISOString();
    const record: SearchRecord = {
      searchId,
      createdAt,
      searchUrl,
      args,
      results,
    };
    this.searches.set(searchId, record);
    return record;
  }

  getSearch(searchId: string) {
    return this.searches.get(searchId);
  }

  listSearches() {
    return Array.from(this.searches.values());
  }

  saveListing(record: ListingRecord) {
    this.listings.set(record.id, record);
    return record;
  }

  getListing(id: string) {
    return this.listings.get(id);
  }

  listListings() {
    return Array.from(this.listings.values());
  }

  saveTripConstraints(tripId: string | undefined, constraints: TripConstraints) {
    const trip = this.ensureTrip(tripId);
    trip.constraints = constraints;
    trip.updatedAt = new Date().toISOString();
    this.trips.set(trip.tripId, trip);
    return trip;
  }

  saveCandidateSet(tripId: string | undefined, candidateSet: CandidateSet) {
    const trip = this.ensureTrip(tripId);
    trip.candidateSet = candidateSet;
    trip.updatedAt = new Date().toISOString();
    this.trips.set(trip.tripId, trip);
    return trip;
  }

  saveShortlist(tripId: string, shortlist: NormalizedListing[]) {
    const trip = this.ensureTrip(tripId);
    trip.shortlist = shortlist;
    trip.updatedAt = new Date().toISOString();
    this.trips.set(trip.tripId, trip);
    return trip;
  }

  appendTripDecision(tripId: string, entry: Omit<DecisionLogEntry, "createdAt">) {
    const trip = this.ensureTrip(tripId);
    const storedEntry: DecisionLogEntry = {
      createdAt: new Date().toISOString(),
      ...entry,
    };
    trip.decisionLog.push(storedEntry);
    trip.updatedAt = new Date().toISOString();
    this.trips.set(trip.tripId, trip);
    return trip;
  }

  addDerivedSummary(tripId: string, summary: string) {
    const trip = this.ensureTrip(tripId);
    if (summary.trim()) {
      trip.derivedSummaries.push(summary.trim());
      trip.updatedAt = new Date().toISOString();
      this.trips.set(trip.tripId, trip);
    }
    return trip;
  }

  getTrip(tripId: string) {
    return this.trips.get(tripId);
  }

  listTrips() {
    return Array.from(this.trips.values());
  }

  clearTrip(tripId: string) {
    return this.trips.delete(tripId);
  }

  private ensureTrip(tripId?: string): TripSession {
    const existing = tripId ? this.trips.get(tripId) : undefined;
    if (existing) {
      return existing;
    }
    const now = new Date().toISOString();
    const created: TripSession = {
      tripId: tripId || randomUUID(),
      shortlist: [],
      decisionLog: [],
      derivedSummaries: [],
      createdAt: now,
      updatedAt: now,
    };
    this.trips.set(created.tripId, created);
    return created;
  }
}
