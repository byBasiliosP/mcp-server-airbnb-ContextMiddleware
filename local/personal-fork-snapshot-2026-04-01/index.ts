#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { cleanObject, flattenArraysInObject, pickBySchema } from "./util.js";
import robotsParser from "robots-parser";
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHash, randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
    return process.env.MCP_SERVER_VERSION || packageJson.version || "unknown";
  } catch {
    return process.env.MCP_SERVER_VERSION || "unknown";
  }
}

const VERSION = getVersion();

const USER_AGENT = "ModelContextProtocol/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)";
const BASE_URL = "https://www.airbnb.com";
const REQUEST_TIMEOUT_MS = getEnvInt("AIRBNB_REQUEST_TIMEOUT_MS", 30000, 1_000, 120_000);
const DEFAULT_SEARCH_RESULTS = getEnvInt("AIRBNB_DEFAULT_SEARCH_RESULTS", 8, 1, 25);
const MAX_SEARCH_RESULTS = getEnvInt("AIRBNB_MAX_SEARCH_RESULTS", 25, 1, 80);
const DEFAULT_CONTEXT_RESULTS = getEnvInt("AIRBNB_DEFAULT_CONTEXT_RESULTS", 6, 1, 25);
const CONTEXT_SUMMARY_LENGTH = getEnvInt("AIRBNB_CONTEXT_SUMMARY_LENGTH", 180, 40, 500);
const DETAIL_SUMMARY_LENGTH = getEnvInt("AIRBNB_DETAIL_SUMMARY_LENGTH", 500, 80, 1200);
const CONTEXT_CACHE_TTL_MS = getEnvInt("AIRBNB_CONTEXT_CACHE_TTL_MS", 900_000, 60_000, 86_400_000);
const AUTO_EXPAND_CONTEXTUAL_LOCATIONS = parseBoolean(process.env.AIRBNB_AUTO_EXPAND_CONTEXTUAL_LOCATIONS, true);
const AUTO_EXPAND_LOCATION_LIMIT = getEnvInt("AIRBNB_AUTO_EXPAND_LOCATION_LIMIT", 2, 0, 5);
const AUTO_EXPAND_SCORE_THRESHOLD = getEnvInt("AIRBNB_AUTO_EXPAND_SCORE_THRESHOLD", 72, 0, 200);
const HARDENED_ENV = process.env.AIRBNB_HARDENED_ENV === "true";
const CURRENT_YEAR = new Date().getFullYear();

const IGNORE_ROBOTS_TXT = process.env.IGNORE_ROBOTS_TXT === "true" || process.argv.slice(2).includes("--ignore-robots-txt");
const robotsErrorMessage = "This path is disallowed by Airbnb's robots.txt to this User-agent. You may or may not want to run the server with '--ignore-robots-txt' args";
let robotsTxtContent = "";

const AIRBNB_SEARCH_TOOL: Tool = {
  name: "airbnb_search",
  description: "Search Airbnb listings and return context-efficient summaries by default. Increase result size only when needed.",
  inputSchema: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "Location to search for (city, state, etc.)"
      },
      placeId: {
        type: "string",
        description: "Google Maps Place ID (overrides the location parameter)"
      },
      candidateLocations: {
        type: "array",
        description: "Optional list of neighborhood or district queries to search instead of a single broad location. Useful for nightlife-oriented trip matching.",
        items: {
          type: "string"
        }
      },
      checkin: {
        type: "string",
        description: "Check-in date (YYYY-MM-DD)"
      },
      checkout: {
        type: "string",
        description: "Check-out date (YYYY-MM-DD)"
      },
      adults: {
        type: "number",
        description: "Number of adults"
      },
      children: {
        type: "number",
        description: "Number of children"
      },
      infants: {
        type: "number",
        description: "Number of infants"
      },
      pets: {
        type: "number",
        description: "Number of pets"
      },
      minPrice: {
        type: "number",
        description: "Minimum price for the stay"
      },
      maxPrice: {
        type: "number",
        description: "Maximum price for the stay"
      },
      cursor: {
        type: "string",
        description: "Base64-encoded string used for pagination"
      },
      ignoreRobotsText: {
        type: "boolean",
        description: "Ignore robots.txt rules for this request"
      },
      contextCacheKey: {
        type: "string",
        description: "Ephemeral cache key returned by airbnb_prepare_context. Stored parameters are used as fallbacks when explicit arguments are missing."
      },
      compact: {
        type: "boolean",
        description: "Return concise listings that are cheaper for prompt context (default true)"
      },
      maxResults: {
        type: "number",
        description: "Maximum number of listings to return. Helps keep context size manageable."
      },
      includeFields: {
        type: "array",
        description: "Top-level fields to keep in compact mode (optional).",
        items: {
          type: "string"
        }
      },
      agentCompact: {
        type: "boolean",
        description: "Return a smaller agent-oriented response envelope to reduce prompt context usage."
      }
    }
  }
};

const AIRBNB_LISTING_DETAILS_TOOL: Tool = {
  name: "airbnb_listing_details",
  description: "Get details for a listing and return a compact summary by default, with optional structured sections.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The Airbnb listing ID"
      },
      checkin: {
        type: "string",
        description: "Check-in date (YYYY-MM-DD)"
      },
      checkout: {
        type: "string",
        description: "Check-out date (YYYY-MM-DD)"
      },
      adults: {
        type: "number",
        description: "Number of adults"
      },
      children: {
        type: "number",
        description: "Number of children"
      },
      infants: {
        type: "number",
        description: "Number of infants"
      },
      pets: {
        type: "number",
        description: "Number of pets"
      },
      ignoreRobotsText: {
        type: "boolean",
        description: "Ignore robots.txt rules for this request"
      },
      contextCacheKey: {
        type: "string",
        description: "Ephemeral cache key returned by airbnb_prepare_context. Stored listing parameters are used as fallbacks."
      },
      compact: {
        type: "boolean",
        description: "Return concise listing details by default."
      },
      includeSections: {
        type: "array",
        description: "Limit the listing sections to include in compact/full responses.",
        items: {
          type: "string"
        }
      },
      agentCompact: {
        type: "boolean",
        description: "Return a smaller agent-oriented response envelope to reduce prompt context usage."
      }
    },
    anyOf: [
      { required: ["id"] },
      { required: ["contextCacheKey"] }
    ]
  }
};

const AIRBNB_CONTEXT_TOOL: Tool = {
  name: "airbnb_search_contextual",
  description: "Search listings and rank candidates using a traveler context (budget, rating preference, amenities).",
  inputSchema: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "Location to search for (city, state, etc.)"
      },
      placeId: {
        type: "string",
        description: "Google Maps Place ID (overrides the location parameter)"
      },
      candidateLocations: {
        type: "array",
        description: "Optional narrower location queries such as neighborhoods or districts. When omitted, the server may derive bounded follow-up targets from broad search results.",
        items: {
          type: "string"
        }
      },
      checkin: {
        type: "string",
        description: "Check-in date (YYYY-MM-DD)"
      },
      checkout: {
        type: "string",
        description: "Check-out date (YYYY-MM-DD)"
      },
      adults: {
        type: "number",
        description: "Number of adults"
      },
      children: {
        type: "number",
        description: "Number of children"
      },
      infants: {
        type: "number",
        description: "Number of infants"
      },
      pets: {
        type: "number",
        description: "Number of pets"
      },
      minPrice: {
        type: "number",
        description: "Minimum price for the stay"
      },
      maxPrice: {
        type: "number",
        description: "Maximum price for the stay"
      },
      context: {
        type: "string",
        description: "Free-form traveler context to parse into structured search signals (e.g. 'family of 4, 2 adults + 2 kids, max $250/night, no smoking')."
      },
      ignoreRobotsText: {
        type: "boolean",
        description: "Ignore robots.txt rules for this request"
      },
      contextCacheKey: {
        type: "string",
        description: "Ephemeral cache key returned by airbnb_prepare_context. Stored search and preference parameters are used as fallbacks."
      },
      compact: {
        type: "boolean",
        description: "Return concise context-aware results (default true)"
      },
      maxResults: {
        type: "number",
        description: "Maximum returned ranked recommendations."
      },
      maxPricePerNight: {
        type: "number",
        description: "Budget cap for ranking in local currency notation."
      },
      minRating: {
        type: "number",
        description: "Minimum rating score for ranking candidates (e.g., 4.5)."
      },
      requiredBedrooms: {
        type: "number",
        description: "Minimum bedroom count required for a result to be considered a fit."
      },
      requiredBeds: {
        type: "number",
        description: "Minimum bed count required for a result to be considered a fit."
      },
      mustHaveAmenities: {
        type: "array",
        description: "Amenities that should appear in listing content. Candidates missing many of these are de-prioritized.",
        items: {
          type: "string"
        }
      },
      preferredAmenities: {
        type: "array",
        description: "Amenities that are nice to have; used as positive ranking signals.",
        items: {
          type: "string"
        }
      },
      avoidAmenities: {
        type: "array",
        description: "Amenity words to avoid; candidates with these terms are de-prioritized.",
        items: {
          type: "string"
        }
      },
      tripStyles: {
        type: "array",
        description: "Reusable trip-intent signals for deterministic ranking, such as nightlife, quiet, transit, remote-work, modern, or group-friendly.",
        items: {
          type: "string"
        }
      },
      agentCompact: {
        type: "boolean",
        description: "Return a smaller agent-oriented response envelope to reduce prompt context usage."
      }
    }
  }
};

const AIRBNB_PREPARE_CONTEXT_TOOL: Tool = {
  name: "airbnb_prepare_context",
  description: "Normalize free-form traveler context into organized parameter signals and tool-ready argument stores before calling Airbnb network tools.",
  inputSchema: {
    type: "object",
    properties: {
      context: {
        type: "string",
        description: "Free-form user request or traveler context to convert into structured tool parameters."
      },
      location: {
        type: "string",
        description: "Explicit location override."
      },
      placeId: {
        type: "string",
        description: "Explicit Google Maps Place ID."
      },
      candidateLocations: {
        type: "array",
        description: "Explicit neighborhood or district queries to preserve in the prepared context store.",
        items: {
          type: "string"
        }
      },
      checkin: {
        type: "string",
        description: "Explicit check-in date override (YYYY-MM-DD)."
      },
      checkout: {
        type: "string",
        description: "Explicit check-out date override (YYYY-MM-DD)."
      },
      adults: {
        type: "number",
        description: "Explicit adult guest count."
      },
      children: {
        type: "number",
        description: "Explicit child guest count."
      },
      infants: {
        type: "number",
        description: "Explicit infant guest count."
      },
      pets: {
        type: "number",
        description: "Explicit pet count."
      },
      minPrice: {
        type: "number",
        description: "Explicit minimum nightly or stay price filter."
      },
      maxPrice: {
        type: "number",
        description: "Explicit maximum nightly or stay price filter."
      },
      maxPricePerNight: {
        type: "number",
        description: "Explicit nightly budget cap for contextual ranking."
      },
      minRating: {
        type: "number",
        description: "Explicit minimum rating threshold."
      },
      requiredBedrooms: {
        type: "number",
        description: "Explicit minimum bedroom requirement."
      },
      requiredBeds: {
        type: "number",
        description: "Explicit minimum bed requirement."
      },
      mustHaveAmenities: {
        type: "array",
        description: "Explicit must-have amenity list.",
        items: {
          type: "string"
        }
      },
      preferredAmenities: {
        type: "array",
        description: "Explicit preferred amenity list.",
        items: {
          type: "string"
        }
      },
      avoidAmenities: {
        type: "array",
        description: "Explicit amenity or feature avoid list.",
        items: {
          type: "string"
        }
      },
      tripStyles: {
        type: "array",
        description: "Explicit trip-intent ranking signals such as nightlife, quiet, remote-work, modern, transit, or group-friendly.",
        items: {
          type: "string"
        }
      },
      id: {
        type: "string",
        description: "Explicit Airbnb listing ID for listing detail flows."
      },
      cursor: {
        type: "string",
        description: "Pagination cursor to preserve in the prepared store."
      },
      compact: {
        type: "boolean",
        description: "Explicit compact response preference."
      },
      maxResults: {
        type: "number",
        description: "Explicit result limit preference."
      },
      includeFields: {
        type: "array",
        description: "Explicit search response field projection.",
        items: {
          type: "string"
        }
      },
      includeSections: {
        type: "array",
        description: "Explicit listing detail section filter.",
        items: {
          type: "string"
        }
      },
      ignoreRobotsText: {
        type: "boolean",
        description: "Explicit robots.txt override flag for downstream tool hints."
      },
      agentCompact: {
        type: "boolean",
        description: "Return a smaller agent-oriented response envelope to reduce prompt context usage."
      }
    }
  }
};

const AIRBNB_RECONCILE_RESULTS_TOOL: Tool = {
  name: "airbnb_reconcile_results",
  description: "Reapply cached traveler context to previously returned search options so an agent can resume later without carrying full user context in prompt memory.",
  inputSchema: {
    type: "object",
    properties: {
      contextCacheKey: {
        type: "string",
        description: "Ephemeral cache key returned by airbnb_prepare_context."
      },
      results: {
        type: "array",
        description: "Previously returned Airbnb search results. Can be compact summaries or raw search result objects.",
        items: {
          type: "object"
        }
      },
      maxResults: {
        type: "number",
        description: "Maximum ranked recommendations to return."
      },
      agentCompact: {
        type: "boolean",
        description: "Return a smaller agent-oriented response envelope to reduce prompt context usage."
      }
    },
    required: ["contextCacheKey", "results"]
  }
};

const AIRBNB_TOOLS = [
  AIRBNB_PREPARE_CONTEXT_TOOL,
  AIRBNB_SEARCH_TOOL,
  AIRBNB_LISTING_DETAILS_TOOL,
  AIRBNB_CONTEXT_TOOL,
  AIRBNB_RECONCILE_RESULTS_TOOL,
] as const;

const ALLOW_SEARCH_RESULT_SCHEMA: Record<string, any> = {
  title: true,
  subtitle: true,
  nameLocalized: {
    localizedStringWithTranslationPreference: true,
  },
  demandStayListing: {
    id: true,
    location: {
      coordinate: {
        latitude: true,
        longitude: true,
      }
    },
    description: true,
  },
  badges: {
    text: true,
  },
  structuredContent: {
    mapCategoryInfo: {
      body: true
    },
    mapSecondaryLine: {
      body: true
    },
    primaryLine: {
      body: true
    },
    secondaryLine: {
      body: true
    },
  },
  avgRatingA11yLabel: true,
  listingParamOverrides: true,
  structuredDisplayPrice: {
    primaryLine: {
      accessibilityLabel: true,
      text: true
    },
    secondaryLine: {
      accessibilityLabel: true,
      text: true
    },
    explanationData: {
      title: true,
      priceDetails: {
        items: {
          description: true,
          priceString: true
        }
      }
    }
  },
};

const ALLOW_SECTION_SCHEMA: Record<string, any> = {
  LOCATION_DEFAULT: {
    lat: true,
    lng: true,
    subtitle: true,
    title: true
  },
  POLICIES_DEFAULT: {
    title: true,
    subtitle: true,
    houseRulesSections: {
      title: true,
      items: {
        title: true,
        subtitle: true,
        html: {
          htmlText: true,
        },
      }
    },
    previewSafetyAndProperties: {
      title: true,
    },
  },
  HIGHLIGHTS_DEFAULT: {
    highlights: {
      title: true,
      subtitle: true,
    }
  },
  DESCRIPTION_DEFAULT: {
    title: true,
    htmlDescription: {
      htmlText: true
    }
  },
  AMENITIES_DEFAULT: {
    title: true,
    seeAllAmenitiesGroups: {
      title: true,
      amenities: {
        title: true
      }
    }
  },
};

type UnknownRecord = Record<string, any>;

type ContextParsedSignals = {
  location?: string;
  checkin?: string;
  checkout?: string;
  adults?: number;
  children?: number;
  infants?: number;
  pets?: number;
  minPrice?: number;
  maxPrice?: number;
  maxPricePerNight?: number;
  minRating?: number;
  listingId?: string;
  candidateLocations: string[];
  requiredBedrooms?: number;
  requiredBeds?: number;
  mustHaveAmenities: string[];
  preferredAmenities: string[];
  avoidAmenities: string[];
  tripStyles: string[];
  notes: string[];
};

type ContextGroup = 'search' | 'guests' | 'pricing' | 'preferences' | 'space' | 'listing' | 'response' | 'execution';
type ContextValueSource = 'explicit' | 'context' | 'cache';
type PrivacyMode = 'anonymous' | 'hardened';

type PreparedContextStore = {
  search: {
    location?: string;
    placeId?: string;
    checkin?: string;
    checkout?: string;
    cursor?: string;
    candidateLocations: string[];
  };
  guests: {
    adults?: number;
    children?: number;
    infants?: number;
    pets?: number;
  };
  pricing: {
    minPrice?: number;
    maxPrice?: number;
    maxPricePerNight?: number;
  };
  preferences: {
    minRating?: number;
    mustHaveAmenities: string[];
    preferredAmenities: string[];
    avoidAmenities: string[];
    tripStyles: string[];
  };
  space: {
    requiredBedrooms?: number;
    requiredBeds?: number;
  };
  listing: {
    id?: string;
  };
  response: {
    compact?: boolean;
    maxResults?: number;
    includeFields: string[];
    includeSections: string[];
  };
  execution: {
    ignoreRobotsText?: boolean;
  };
};

type ContextSignal = {
  pattern: string;
  group: ContextGroup;
  parameter: string;
  value: unknown;
  source: ContextValueSource;
  tools: string[];
};

type ToolName = 'airbnb_search' | 'airbnb_search_contextual' | 'airbnb_listing_details' | 'airbnb_reconcile_results';

type ToolHint = {
  ready: boolean;
  missingRequired: string[];
  cacheArguments: UnknownRecord;
  resolvedArguments: UnknownRecord;
};

type AgentRepairAction = {
  parameter: string;
  action: 'set_explicit_value' | 'confirm' | 'ask_user' | 'defer';
  reason: string;
  suggestedValue?: unknown;
};

type AgentGuidance = {
  readyForNetworkSearch: boolean;
  shouldAskUserBeforeSearch: boolean;
  recommendedTool?: ToolName;
  missingRequiredSignals: string[];
  weakSignals: string[];
  repairs: AgentRepairAction[];
  workflow: Array<{
    step: string;
    status: 'completed' | 'ready' | 'blocked' | 'defer';
    tool?: ToolName;
    rationale?: string;
    arguments?: UnknownRecord;
  }>;
};

type ReconcileArgs = {
  contextCacheKey?: string;
  contextCache?: ContextCacheEntry;
  maxResults: number;
  agentCompact: boolean;
  parsed: PreparedContextResult;
  results: UnknownRecord[];
};

type PreparedContextResult = {
  rawSource: string;
  parsed: ContextParsedSignals;
  store: PreparedContextStore;
  signalSources: Record<string, ContextValueSource | undefined>;
  signals: ContextSignal[];
  privacyMode: PrivacyMode;
  publicSource: string;
  sourceFingerprint?: string;
  notes: string[];
};

type ContextCacheEntry = {
  key: string;
  createdAt: string;
  expiresAt: string;
  privacyMode: PrivacyMode;
  sourceFingerprint?: string;
  source?: string;
  parsed: ContextParsedSignals;
  store: PreparedContextStore;
  notes: string[];
};

type ContextUsage = {
  locationFromContext: boolean;
  checkinFromContext: boolean;
  checkoutFromContext: boolean;
  adultsFromContext: boolean;
  childrenFromContext: boolean;
  infantsFromContext: boolean;
  petsFromContext: boolean;
  priceFromContext: boolean;
  ratingFromContext: boolean;
  candidateLocationsFromContext: boolean;
  amenitiesFromContext: boolean;
  tripStylesFromContext: boolean;
  spaceFromContext: boolean;
};

type ContextualSearchArgs = ReturnType<typeof parseSearchArgs> & {
  minRating: number;
  maxPricePerNight: number;
  mustHaveAmenities: string[];
  preferredAmenities: string[];
  avoidAmenities: string[];
  candidateLocations: string[];
  tripStyles: string[];
  requiredBedrooms: number;
  requiredBeds: number;
  contextCacheKey?: string;
  contextCache?: ContextCacheEntry;
  context: {
    source: string;
    sourceFingerprint?: string;
    privacyMode: PrivacyMode;
    parsed: ContextParsedSignals;
    used: ContextUsage;
  };
};

type ContextualSearchResponse = {
  targetLocation: string;
  searchUrl: string;
  paginationInfo: unknown;
  searchResults: UnknownRecord[];
  source: 'requested' | 'auto-expanded';
};

type RankedRecommendation = {
  summary: UnknownRecord;
  matchScore: number;
  matchReasons: string[];
  searchTarget: string;
  searchTargetSource: 'requested' | 'auto-expanded';
};

const contextCache = new Map<string, ContextCacheEntry>();

function getEnvInt(name: string, fallback: number, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return clampInt(parsed, min, max);
}

function clampInt(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }
  return fallback;
}

function parseNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function parseString(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  return '';
}

function parseOptionalString(value: unknown): string | undefined {
  const parsed = parseString(value);
  return parsed.length > 0 ? parsed : undefined;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }
  return undefined;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value
    .map(item => (typeof item === 'string' ? item.toLowerCase().trim() : ''))
    .filter(Boolean)));
}

function parseLiteralStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(
    value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean),
  ));
}

function escapeRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const AMENITY_PATTERNS: Array<{ canonical: string; terms: string[] }> = [
  { canonical: "wifi", terms: ["wi-fi", "wifi", "wireless internet", "internet"] },
  { canonical: "parking", terms: ["parking", "car park", "garage", "private parking"] },
  { canonical: "pool", terms: ["pool"] },
  { canonical: "hot tub", terms: ["hot tub", "jacuzzi"] },
  { canonical: "gym", terms: ["gym", "fitness center", "fitness"] },
  { canonical: "kitchen", terms: ["kitchen", "kitchenette"] },
  { canonical: "washer", terms: ["washer", "washing machine", "laundry"] },
  { canonical: "dryer", terms: ["dryer"] },
  { canonical: "workspace", terms: ["workspace", "work desk", "dedicated workspace", "desk"] },
  { canonical: "ac", terms: ["air conditioning", "air-conditioner", "ac"] },
  { canonical: "heating", terms: ["heating", "central heating"] },
  { canonical: "balcony", terms: ["balcony", "terrace", "patio", "deck"] },
  { canonical: "tv", terms: ["tv", "television"] },
  { canonical: "pet-friendly", terms: ["pet friendly", "pets allowed", "pet-friendly"] },
];

const TRIP_STYLE_PATTERNS: Array<{ canonical: string; terms: string[] }> = [
  { canonical: "nightlife", terms: ["nightlife", "going out", "bars", "clubs", "late night", "bar scene"] },
  { canonical: "walkable", terms: ["walkable", "walk everywhere", "on foot", "walk to"] },
  { canonical: "transit", terms: ["public transit", "train", "subway", "metro", "station", "near transit"] },
  { canonical: "remote-work", terms: ["remote work", "work remotely", "working during the day", "business trip", "workspace", "desk"] },
  { canonical: "family-friendly", terms: ["family trip", "family friendly", "family-friendly", "kid friendly", "kid-friendly", "child friendly", "child-friendly", "children"] },
  { canonical: "quiet", terms: ["quiet", "peaceful", "calm", "serene", "low-key"] },
  { canonical: "modern", terms: ["modern", "stylish", "renovated", "updated", "designer", "contemporary"] },
  { canonical: "group-friendly", terms: ["group trip", "hang out", "hangout", "common area", "spacious", "lounge"] },
  { canonical: "dining", terms: ["restaurants", "restaurant", "food scene", "cafes", "dining"] },
];

const TRIP_STYLE_RANKING_RULES: Record<string, { positive: string[]; negative?: string[]; score: number }> = {
  nightlife: {
    positive: ["nightlife", "bars", "bar", "clubs", "restaurant", "restaurants", "entertainment", "music", "live music", "downtown", "central", "walkable"],
    score: 5,
  },
  walkable: {
    positive: ["walkable", "walk to", "steps from", "nearby", "central", "downtown"],
    score: 4,
  },
  transit: {
    positive: ["train", "subway", "metro", "station", "bus", "transit", "walkable", "central"],
    score: 4,
  },
  "remote-work": {
    positive: ["workspace", "desk", "wifi", "quiet", "business", "laptop"],
    score: 5,
  },
  "family-friendly": {
    positive: ["family", "kid", "children", "kitchen", "washer", "dryer", "parking", "yard", "spacious"],
    score: 4,
  },
  quiet: {
    positive: ["quiet", "peaceful", "serene", "calm", "private", "residential"],
    negative: ["nightlife", "bars", "clubs", "late night"],
    score: 5,
  },
  modern: {
    positive: ["modern", "stylish", "renovated", "updated", "designer", "luxury", "contemporary"],
    score: 5,
  },
  "group-friendly": {
    positive: ["spacious", "large", "open", "living room", "common area", "lounge", "patio", "balcony", "deck"],
    score: 5,
  },
  dining: {
    positive: ["restaurant", "restaurants", "cafe", "cafes", "dining", "food"],
    score: 3,
  },
};

const LOCATION_LIST_STOP_WORDS = new Set([
  'and',
  'or',
  'near',
  'around',
  'in',
  'at',
  'with',
  'the',
  'area',
  'areas',
  'district',
  'districts',
  'neighborhood',
  'neighborhoods',
  'part',
  'parts',
]);

const MUST_AMENITY_CUES = /\b(must|must have|must-haves?|must\s+include|needs?|need|required|non-negotiable|essential)\b/i;
const PREFER_AMENITY_CUES = /\b(prefer|preferred|ideally|nice|nice to have|would like|looking for|should have)\b/i;
const AVOID_AMENITY_CUES = /\b(no|not|without|avoid|avoid of|exclude|don't|doesn't|cant|can't|cannot)\b/i;

function hasOwnField(raw: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key);
}

function uniqueNormalized(values: (string | undefined | null)[]): string[] {
  return Array.from(new Set(
    values
      .map((value) => {
        if (typeof value !== 'string') {
          return '';
        }
        return value.trim().toLowerCase();
      })
      .filter(Boolean),
  ));
}

function resolveLayeredValue<T>(layers: Array<{ present: boolean; value: T; source: ContextValueSource }>): { value?: T; source?: ContextValueSource } {
  for (const layer of layers) {
    if (layer.present) {
      return {
        value: layer.value,
        source: layer.source,
      };
    }
  }
  return {};
}

function sanitizeToolArguments(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => sanitizeToolArguments(item))
      .filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }

  if (value && typeof value === 'object') {
    const output: UnknownRecord = {};
    for (const [key, entry] of Object.entries(value as UnknownRecord)) {
      const sanitized = sanitizeToolArguments(entry);
      if (sanitized !== undefined) {
        output[key] = sanitized;
      }
    }
    return Object.keys(output).length > 0 ? output : undefined;
  }

  if (typeof value === 'string') {
    return value.trim().length > 0 ? value.trim() : undefined;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  return value === undefined ? undefined : value;
}

function pickKnownKeys(source: UnknownRecord, keys: string[]): UnknownRecord {
  const output: UnknownRecord = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      output[key] = source[key];
    }
  }
  return output;
}

function compactRecommendationForAgent(entry: RankedRecommendation): UnknownRecord {
  return {
    id: entry.summary.id,
    title: entry.summary.title,
    location: entry.summary.location,
    layoutSummary: entry.summary.layoutSummary,
    bedrooms: entry.summary.bedrooms,
    beds: entry.summary.beds,
    rating: entry.summary.rating,
    price: entry.summary.price,
    matchScore: entry.matchScore,
    matchReasons: entry.matchReasons.slice(0, 3),
    url: entry.summary.url,
  };
}

function sanitizeArgumentsForLogging(args: UnknownRecord): UnknownRecord {
  const output: UnknownRecord = { ...args };
  if (!HARDENED_ENV && typeof output.context === 'string') {
    output.contextFingerprint = hashContextSource(output.context);
    output.context = '[anonymous]';
  }
  return output;
}

function hashContextSource(source: string): string | undefined {
  const normalized = parseString(source);
  if (!normalized) {
    return undefined;
  }
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function getPrivacyMode(): PrivacyMode {
  return HARDENED_ENV ? 'hardened' : 'anonymous';
}

function getPublicContextSource(source: string, mode: PrivacyMode = getPrivacyMode()): string {
  const normalized = parseString(source);
  if (!normalized) {
    return '';
  }
  return mode === 'hardened' ? normalized : '[anonymous]';
}

function purgeExpiredContextCache(now = Date.now()) {
  for (const [key, entry] of contextCache.entries()) {
    if (Date.parse(entry.expiresAt) <= now) {
      contextCache.delete(key);
    }
  }
}

function getContextCacheEntry(key: unknown): ContextCacheEntry | undefined {
  const parsedKey = parseOptionalString(key);
  if (!parsedKey) {
    return undefined;
  }

  purgeExpiredContextCache();
  const entry = contextCache.get(parsedKey);
  if (!entry) {
    return undefined;
  }

  if (Date.parse(entry.expiresAt) <= Date.now()) {
    contextCache.delete(parsedKey);
    return undefined;
  }

  return entry;
}

function putContextCacheEntry(prepared: PreparedContextResult): ContextCacheEntry {
  purgeExpiredContextCache();
  const now = Date.now();
  const entry: ContextCacheEntry = {
    key: randomUUID(),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CONTEXT_CACHE_TTL_MS).toISOString(),
    privacyMode: prepared.privacyMode,
    sourceFingerprint: prepared.sourceFingerprint,
    source: prepared.privacyMode === 'hardened' ? prepared.rawSource : undefined,
    parsed: prepared.parsed,
    store: prepared.store,
    notes: prepared.notes,
  };
  contextCache.set(entry.key, entry);
  return entry;
}

function parseYear(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return CURRENT_YEAR;
  }
  if (value < 100 && value >= 0) {
    return 2000 + value;
  }
  return value;
}

function monthNameToIndex(month?: string): number | undefined {
  if (!month) {
    return undefined;
  }
  const normalized = month.toLowerCase().slice(0, 3);
  const names = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  return names.indexOf(normalized) >= 0 ? names.indexOf(normalized) : undefined;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() + 1 === month && candidate.getUTCDate() === day;
}

function toIsoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addDays(base: Date, days: number): Date {
  const output = new Date(base);
  output.setDate(output.getDate() + days);
  return output;
}

function toLocalIsoDate(date: Date): string {
  return toIsoDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function nextWeekday(weekdayName: string, baseDate: Date): string | undefined {
  const normalized = weekdayName.toLowerCase().slice(0, 3);
  const order = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const target = order.indexOf(normalized);
  if (target < 0) {
    return undefined;
  }
  const current = baseDate.getDay();
  let delta = (target + 7 - current) % 7;
  if (delta === 0) {
    delta = 7;
  }
  return toLocalIsoDate(addDays(baseDate, delta));
}

function parseDateWithReference(raw: string, referenceDate = new Date()): string | undefined {
  const trimmed = raw.toLowerCase().replace(/\b(st|nd|rd|th)\b/g, '').trim();
  const simpleRelative = trimmed.match(/\b(today|tomorrow|day after tomorrow)\b/i);
  if (simpleRelative) {
    if (simpleRelative[1] === 'today') {
      return toLocalIsoDate(referenceDate);
    }
    if (simpleRelative[1] === 'tomorrow') {
      return toLocalIsoDate(addDays(referenceDate, 1));
    }
    if (simpleRelative[1] === 'day after tomorrow') {
      return toLocalIsoDate(addDays(referenceDate, 2));
    }
  }

  const nextWeekdayMatch = trimmed.match(/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (nextWeekdayMatch) {
    return nextWeekday(nextWeekdayMatch[1], referenceDate);
  }

  const monthDate = trimmed.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:\s*,?\s*(\d{2,4}))?\b/);
  if (monthDate) {
    const month = monthNameToIndex(monthDate[1]);
    const day = Number(monthDate[2]);
    const year = parseYear(monthDate[3] ? Number(monthDate[3]) : referenceDate.getFullYear());
    if (Number.isFinite(day) && month !== undefined && isValidCalendarDate(year, month + 1, day)) {
      return toIsoDate(year, month + 1, day);
    }
  }

  const dayMonthDate = trimmed.match(/\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s*,?\s*(\d{2,4}))?\b/);
  if (dayMonthDate) {
    const day = Number(dayMonthDate[1]);
    const month = monthNameToIndex(dayMonthDate[2]);
    const year = parseYear(dayMonthDate[3] ? Number(dayMonthDate[3]) : referenceDate.getFullYear());
    if (Number.isFinite(day) && month !== undefined && isValidCalendarDate(year, month + 1, day)) {
      return toIsoDate(year, month + 1, day);
    }
  }

  const isoDate = trimmed.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (isoDate) {
    const year = Number(isoDate[1]);
    const month = Number(isoDate[2]);
    const day = Number(isoDate[3]);
    if (isValidCalendarDate(year, month, day)) {
      return toIsoDate(year, month, day);
    }
  }

  const slashDate = trimmed.match(/\b(\d{1,2})[-/](\d{1,2})(?:[-/](\d{2,4}))?\b/);
  if (slashDate) {
    const first = Number(slashDate[1]);
    const second = Number(slashDate[2]);
    const inferredYear = parseYear(slashDate[3] ? Number(slashDate[3]) : referenceDate.getFullYear());
    if (isValidCalendarDate(inferredYear, first, second)) {
      return toIsoDate(inferredYear, first, second);
    }
    if (isValidCalendarDate(inferredYear, second, first)) {
      return toIsoDate(inferredYear, second, first);
    }
  }

  return undefined;
}

function extractDateMentions(context: string, referenceDate = new Date()): string[] {
  const normalized = context.replace(/\b(st|nd|rd|th)\b/g, '');
  const matches = [
    ...normalized.matchAll(/(today|tomorrow|day after tomorrow|next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))/gi),
    ...normalized.matchAll(/(\d{4}-\d{1,2}-\d{1,2})/gi),
    ...normalized.matchAll(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g),
    ...normalized.matchAll(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:\s*,?\s*\d{2,4})?\b/gi),
    ...normalized.matchAll(/\b\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s*,?\s*\d{2,4})?\b/gi),
  ];

  const dates = Array.from(new Set(matches.map((match) => match[0])));
  return dates
    .map((match) => parseDateWithReference(match))
    .filter((value): value is string => typeof value === 'string');
}

function parseContextDates(context: string): { checkin?: string; checkout?: string; notes: string[] } {
  const notes: string[] = [];
  const lower = context.toLowerCase();
  const rangeMatch = lower.match(/(?:from|between)\s+(.{0,80}?)\s+(?:to|through|until)\s+(.{0,80}?)(?:[.,;]|$)/i);
  if (rangeMatch) {
    const startDate = parseDateWithReference(rangeMatch[1]);
    const endDate = parseDateWithReference(rangeMatch[2]);
    if (startDate && endDate) {
      notes.push('extracted date range from context');
      return { checkin: startDate, checkout: endDate, notes };
    }
  }

  const checkinMatch = lower.match(/check(?:-|\s)in(?:\s+date)?\s*(?:on)?\s*([^.;,]{0,80}?)(?:\s*(?:for|to|and|,|\.|\n)|$)/i);
  const checkoutMatch = lower.match(/check(?:-|\s)out(?:\s+date)?\s*(?:on)?\s*([^.;,]{0,80}?)(?:\s*(?:for|to|and|,|\.|\n)|$)/i);
  const checksIn = checkinMatch ? parseDateWithReference(checkinMatch[1]) : undefined;
  const checksOut = checkoutMatch ? parseDateWithReference(checkoutMatch[1]) : undefined;

  const dates = extractDateMentions(context);

  if (checksIn && checksOut) {
    notes.push('extracted check-in/check-out phrases');
    return { checkin: checksIn, checkout: checksOut, notes };
  }

  if (checksIn) {
    return {
      checkin: checksIn,
      checkout: checksOut || dates.find((date) => date !== checksIn),
      notes,
    };
  }

  if (checksOut) {
    return {
      checkin: dates.find((date) => date !== checksOut),
      checkout: checksOut,
      notes: [...notes, 'inferred check-in from nearby date mention'],
    };
  }

  if (dates.length >= 2) {
    return {
      checkin: dates[0],
      checkout: dates[1],
      notes: [...notes, 'inferred check-in and check-out from date mentions'],
    };
  }
  if (dates.length === 1) {
    return { checkin: dates[0], notes: [...notes, 'single date mapped to check-in'] };
  }

  return { notes };
}

function parseContextGuests(context: string): { adults?: number; children?: number; infants?: number; pets?: number; notes: string[] } {
  const notes: string[] = [];
  const lower = context.toLowerCase();
  let adults: number | undefined;
  let children: number | undefined;
  let infants: number | undefined;
  let pets: number | undefined;

  const familyMatch = lower.match(/\bfamily\s+of\s+(\d{1,2})\b/i);
  if (familyMatch) {
    const total = Number(familyMatch[1]);
    if (Number.isFinite(total) && total > 0) {
      adults = Math.min(2, total);
      children = total > 2 ? total - adults : undefined;
      notes.push(`family size inferred as ${total}`);
    }
  }

  if (/\bcouple\b/i.test(lower) && adults === undefined) {
    adults = 2;
    notes.push('couple interpreted as 2 adults');
  }

  const adultsChildrenMatch = lower.match(/(\d+)\s+adults?\s*(?:and|,|&)\s*(\d+)\s+(?:children|child|kids?)/i);
  if (adultsChildrenMatch) {
    const parsedAdults = Number(adultsChildrenMatch[1]);
    const parsedChildren = Number(adultsChildrenMatch[2]);
    if (Number.isFinite(parsedAdults) && Number.isFinite(parsedChildren) && parsedAdults > 0) {
      adults = parsedAdults;
      children = parsedChildren;
      notes.push(`explicit adults/children pair found: ${adults} adults, ${children} children`);
    }
  }

  const meAndOthersMatch = lower.match(/\b(?:me|us)\s+and\s+(\d+)\s+other\s+(?:people|person|guests?|friends?|guys?|men|women|adults?)\b/i);
  if (meAndOthersMatch && adults === undefined) {
    const parsedOthers = Number(meAndOthersMatch[1]);
    if (Number.isFinite(parsedOthers) && parsedOthers >= 0) {
      adults = parsedOthers + 1;
      notes.push(`adult group inferred from "me and ${parsedOthers} other": ${adults}`);
    }
  }

  const peopleMatch = lower.match(/\b(\d+)\s+(?:single\s+)?(?:adult\s+)?(?:males?|men|guys?|women|girls?|adults?|people|persons|guests?|friends?)\b/i);
  if (peopleMatch && adults === undefined) {
    const parsedAdults = Number(peopleMatch[1]);
    if (Number.isFinite(parsedAdults) && parsedAdults > 0) {
      adults = parsedAdults;
      notes.push(`adult group inferred as ${adults}`);
    }
  }

  const adultsMatch = lower.match(/\b(\d+)\s+adults?\b/i);
  if (adultsMatch && adults === undefined) {
    const parsedAdults = Number(adultsMatch[1]);
    if (Number.isFinite(parsedAdults) && parsedAdults >= 0) {
      adults = parsedAdults;
      notes.push(`adults inferred as ${adults}`);
    }
  }

  const childrenMatch = lower.match(/\b(\d+)\s+(?:children|child|kids?)\b/i);
  if (childrenMatch && children === undefined) {
    const parsedChildren = Number(childrenMatch[1]);
    if (Number.isFinite(parsedChildren) && parsedChildren >= 0) {
      children = parsedChildren;
      notes.push(`children inferred as ${children}`);
    }
  }

  const infantsMatch = lower.match(/\b(\d+)\s+infants?\b/i);
  if (infantsMatch && infants === undefined) {
    const parsedInfants = Number(infantsMatch[1]);
    if (Number.isFinite(parsedInfants) && parsedInfants >= 0) {
      infants = parsedInfants;
      notes.push(`infants inferred as ${infants}`);
    }
  }

  const petsMatch = lower.match(/\b(\d+)\s+pets?\b/i);
  if (petsMatch && pets === undefined) {
    const parsedPets = Number(petsMatch[1]);
    if (Number.isFinite(parsedPets) && parsedPets >= 0) {
      pets = parsedPets;
      notes.push(`pets inferred as ${pets}`);
    }
  }

  return { adults, children, infants, pets, notes };
}

function parseContextBudget(context: string): { minPrice?: number; maxPrice?: number; maxPricePerNight?: number; notes: string[] } {
  const notes: string[] = [];
  const lower = context.toLowerCase();
  let minPrice: number | undefined;
  let maxPrice: number | undefined;

  const rangeMatch = lower.match(/(?:between|from)\s+\$?(\d{2,6})\s*(?:to|-|through)\s*\$?(\d{2,6})/i);
  if (rangeMatch) {
    const minCandidate = Number(rangeMatch[1]);
    const maxCandidate = Number(rangeMatch[2]);
    if (Number.isFinite(minCandidate) && Number.isFinite(maxCandidate) && maxCandidate >= minCandidate) {
      minPrice = minCandidate;
      maxPrice = maxCandidate;
      notes.push(`budget range inferred: ${minPrice}-${maxPrice}`);
    }
  }

  if (minPrice === undefined) {
    const minMatch = lower.match(/(?:minimum|min|at least|from)\s+\$?(\d{2,6})(?:\s*(?:per\s*night|\/night|\/ night|a\s*night))?/i);
    if (minMatch) {
      const parsed = Number(minMatch[1]);
      if (Number.isFinite(parsed)) {
        minPrice = parsed;
        notes.push(`minimum budget inferred: ${minPrice}`);
      }
    }
  }

  if (maxPrice === undefined) {
    const maxMatch = lower.match(/(?:max(?:imum)?|up to|at most|below|under|no more than)\s+\$?(\d{2,6})(?:\s*(?:per\s*night|\/night|\/ night|a\s*night))?/i);
    if (maxMatch) {
      const parsed = Number(maxMatch[1]);
      if (Number.isFinite(parsed)) {
        maxPrice = parsed;
        notes.push(`maximum budget inferred: ${maxPrice}`);
      }
    }
  }

  const nightlyMatch = lower.match(/\$?(\d{2,6})(?:\s*(?:per\s*night|\/night|\s*\/ night|a\s*night))/i);
  if (nightlyMatch) {
    const parsed = Number(nightlyMatch[1]);
    if (Number.isFinite(parsed)) {
      if (maxPrice === undefined || parsed < maxPrice) {
        maxPrice = parsed;
      }
      notes.push(`nightly budget inferred: ${parsed}`);
      return { minPrice, maxPrice, maxPricePerNight: parsed, notes };
    }
  }

  return { minPrice, maxPrice, maxPricePerNight: undefined, notes };
}

function parseContextRating(context: string): { minRating?: number; notes: string[] } {
  const notes: string[] = [];
  const lower = context.toLowerCase();
  const explicitMatch = lower.match(/(?:minimum|min)\s*(?:rating|stars?)\s*(?:of|is|:)?\s*(\d(?:\.\d)?)/i);
  const starMatch = lower.match(/\b(\d(?:\.\d)?)\s*stars?\b/i);
  const directMatch = lower.match(/\b(at least|min)\s+(\d(?:\.\d)?)\b/i);
  const raw = explicitMatch?.[1] || starMatch?.[1] || directMatch?.[2];
  if (!raw) {
    return { notes };
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return { notes };
  }

  const normalized = parsed > 10 ? parsed / 10 : parsed;
  const clipped = Math.min(5, Math.max(0, normalized));
  notes.push(`minimum rating inferred: ${clipped}`);
  return { minRating: clipped, notes };
}

function parseContextAmenities(context: string): { mustHaveAmenities: string[]; preferredAmenities: string[]; avoidAmenities: string[]; notes: string[] } {
  const notes: string[] = [];
  const clauses = context
    .split(/[.;,]|\bbut\b/gi)
    .map((value) => value.trim())
    .filter(Boolean);

  const mustHaveAmenities = new Set<string>();
  const preferredAmenities = new Set<string>();
  const avoidAmenities = new Set<string>();

  for (const clause of clauses) {
    const lower = clause.toLowerCase();
    const isAvoid = AVOID_AMENITY_CUES.test(lower);
    const isMust = MUST_AMENITY_CUES.test(lower);
    const isPrefer = PREFER_AMENITY_CUES.test(lower);

    for (const amenity of AMENITY_PATTERNS) {
      const matched = amenity.terms.some((term) => {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}\\b`, 'i').test(lower);
      });
      if (!matched) {
        continue;
      }

      if (isAvoid) {
        avoidAmenities.add(amenity.canonical);
      } else if (isMust) {
        mustHaveAmenities.add(amenity.canonical);
      } else {
        preferredAmenities.add(amenity.canonical);
      }
      notes.push(`amenity detected: ${amenity.canonical}`);
    }

    if (/\bsmoking\b/.test(lower) && isAvoid) {
      avoidAmenities.add('smoking');
      notes.push('avoidance detected: smoking');
    }
    if (/\bpet.?friendly|pets allowed|petfriendly\b/.test(lower) && !isAvoid) {
      preferredAmenities.add('pet-friendly');
    }
  }

  return {
    mustHaveAmenities: Array.from(mustHaveAmenities),
    preferredAmenities: Array.from(preferredAmenities),
    avoidAmenities: Array.from(avoidAmenities),
    notes,
  };
}

function parseContextLocation(context: string): { location?: string; notes: string[] } {
  const notes: string[] = [];
  const locationPatterns = [
    /(?:location|trip|stay|visit)\s+(?:is|to|near)?\s+([a-z0-9][a-z0-9\s,'-]{2,60}?)(?=\s+(?:for|with|on|from|next|check|$))/i,
    /(?:go|going|travel|traveling)\s+(?:to|in|near)\s+([a-z0-9][a-z0-9\s,'-]{2,60}?)(?=\s+(?:for|with|on|from|between|check|$))/i,
    /(?:place|stay|staying|find|looking)\s+(?:for\s+.*?\s+)?(?:in|near)\s+([a-z0-9][a-z0-9\s,'-]{2,60}?)(?=\s+(?:\d{1,2}[/-]\d{1,2}|for|with|on|from|between|check|next|$)|[.,;])/i,
    /(?:somewhere|anywhere)\s+in\s+([a-z0-9][a-z0-9\s,'-]{2,60}?)(?=\s+(?:for|with|on|from|between|check|next|$)|[.,;])/i,
    /(?:nightlife|restaurants?|bars?|weekend)\s+in\s+([a-z0-9][a-z0-9\s,'-]{2,60}?)(?=\s+(?:for|with|on|from|between|check|next|$)|[.,;])/i,
  ];

  for (const pattern of locationPatterns) {
    const match = context.match(pattern);
    if (!match?.[1]) {
      continue;
    }
    const candidate = match[1].trim().replace(/[;,.\n]$/, '');
    if (candidate.length > 1) {
      notes.push(`location inferred: ${candidate}`);
      return { location: candidate, notes };
    }
  }

  return { notes };
}

function normalizeLocationCandidate(value: string): string {
  return value
    .replace(/^[\s,/-]+|[\s,/-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyLocationCandidate(value: string): boolean {
  const normalized = normalizeLocationCandidate(value);
  if (!normalized || normalized.length < 2 || normalized.length > 60) {
    return false;
  }
  if (/\d/.test(normalized)) {
    return false;
  }
  const lower = normalized.toLowerCase();
  if (LOCATION_LIST_STOP_WORDS.has(lower)) {
    return false;
  }
  if (/\b(check|checkout|checkin|adults?|children|kids?|infants?|pets?|budget|rating|wifi|pool|night|nights|bedrooms?|beds?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|weekend|next)\b/i.test(lower)) {
    return false;
  }
  return /[a-z]/i.test(normalized);
}

function splitLocationCandidateList(raw: string): string[] {
  return Array.from(new Set(
    raw
      .split(/\s*(?:,|\/|\bor\b|\band\b)\s*/i)
      .map((value) => normalizeLocationCandidate(value))
      .filter((value) => isLikelyLocationCandidate(value)),
  ));
}

function parseContextCandidateLocations(context: string): { candidateLocations: string[]; notes: string[] } {
  const notes: string[] = [];
  const candidates = new Set<string>();
  const patterns = [
    /\b(?:neighborhoods?|areas?|districts?|parts? of town)\s*(?:like|such as|including|in|near)?\s+([^.;\n]{4,140})/gi,
    /\b(?:candidate\s+locations?|candidate\s+areas?|locations?)\s*[:=-]\s*([^.;\n]{4,140})/gi,
    /\b(?:stay|staying|searching|looking|hang(?:ing)? out|go(?:ing)? out)\s+(?:in|near|around)\s+([a-z][^.;\n]{0,120}(?:\/|\bor\b)[^.;\n]{2,120})/gi,
  ];

  for (const pattern of patterns) {
    for (const match of context.matchAll(pattern)) {
      const rawList = match[1];
      if (!rawList) {
        continue;
      }
      for (const value of splitLocationCandidateList(rawList)) {
        candidates.add(value);
      }
    }
  }

  if (candidates.size > 0) {
    notes.push(`candidate locations inferred: ${Array.from(candidates).join(', ')}`);
  }

  return {
    candidateLocations: Array.from(candidates),
    notes,
  };
}

function parseContextListingReference(context: string): { listingId?: string; notes: string[] } {
  const notes: string[] = [];
  const urlMatch = context.match(/airbnb\.[^\s/]+\/rooms\/(\d{5,20})/i);
  if (urlMatch?.[1]) {
    notes.push(`listing id inferred from Airbnb URL: ${urlMatch[1]}`);
    return { listingId: urlMatch[1], notes };
  }

  const idMatch = context.match(/\b(?:listing|room|property|airbnb(?:\s+listing)?(?:\s+id)?|id)\s*(?:#|:)?\s*(\d{5,20})\b/i);
  if (idMatch?.[1]) {
    notes.push(`listing id inferred from text: ${idMatch[1]}`);
    return { listingId: idMatch[1], notes };
  }

  return { notes };
}

function parseContextTripStyles(context: string): { tripStyles: string[]; notes: string[] } {
  const notes: string[] = [];
  const tripStyles = new Set<string>();
  const lower = context.toLowerCase();

  for (const style of TRIP_STYLE_PATTERNS) {
    if (style.terms.some((term) => new RegExp(`\\b${escapeRegex(term)}\\b`, 'i').test(lower))) {
      tripStyles.add(style.canonical);
      notes.push(`trip style inferred: ${style.canonical}`);
    }
  }

  return {
    tripStyles: Array.from(tripStyles),
    notes,
  };
}

function parseContextSpaceRequirements(context: string): { requiredBedrooms?: number; requiredBeds?: number; notes: string[] } {
  const notes: string[] = [];

  const bedroomMatch = context.match(/\b(\d+)\s*(?:bedrooms?|beds?rooms?|br)\b/i);
  const bedMatch = context.match(/\b(\d+)\s*beds?\b/i);

  const requiredBedrooms = bedroomMatch ? Number(bedroomMatch[1]) : undefined;
  const requiredBeds = bedMatch ? Number(bedMatch[1]) : undefined;

  if (requiredBedrooms !== undefined && Number.isFinite(requiredBedrooms) && requiredBedrooms > 0) {
    notes.push(`minimum bedrooms inferred: ${requiredBedrooms}`);
  }

  if (requiredBeds !== undefined && Number.isFinite(requiredBeds) && requiredBeds > 0) {
    notes.push(`minimum beds inferred: ${requiredBeds}`);
  }

  return {
    requiredBedrooms: Number.isFinite(requiredBedrooms) ? requiredBedrooms : undefined,
    requiredBeds: Number.isFinite(requiredBeds) ? requiredBeds : undefined,
    notes,
  };
}

function parseContext(context: string): ContextParsedSignals {
  const source = parseString(context);
  if (!source) {
    return {
      candidateLocations: [],
      mustHaveAmenities: [],
      preferredAmenities: [],
      avoidAmenities: [],
      tripStyles: [],
      notes: ['no context provided'],
    };
  }

  const location = parseContextLocation(source);
  const candidateLocations = parseContextCandidateLocations(source);
  const listingReference = parseContextListingReference(source);
  const dates = parseContextDates(source);
  const guests = parseContextGuests(source);
  const budget = parseContextBudget(source);
  const rating = parseContextRating(source);
  const tripStyles = parseContextTripStyles(source);
  const space = parseContextSpaceRequirements(source);
  const amenities = parseContextAmenities(source);

  return {
    location: location.location,
    listingId: listingReference.listingId,
    candidateLocations: candidateLocations.candidateLocations,
    checkin: dates.checkin,
    checkout: dates.checkout,
    adults: guests.adults,
    children: guests.children,
    infants: guests.infants,
    pets: guests.pets,
    minPrice: budget.minPrice,
    maxPrice: budget.maxPrice,
    maxPricePerNight: budget.maxPricePerNight,
    minRating: rating.minRating,
    requiredBedrooms: space.requiredBedrooms,
    requiredBeds: space.requiredBeds,
    mustHaveAmenities: amenities.mustHaveAmenities,
    preferredAmenities: amenities.preferredAmenities,
    avoidAmenities: amenities.avoidAmenities,
    tripStyles: tripStyles.tripStyles,
    notes: [
      ...location.notes,
      ...candidateLocations.notes,
      ...listingReference.notes,
      ...dates.notes,
      ...guests.notes,
      ...budget.notes,
      ...rating.notes,
      ...tripStyles.notes,
      ...space.notes,
      ...amenities.notes,
    ],
  };
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return '';
}

function trimText(value: unknown, maxLength = 250): string {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength).trim()}…`;
}

function stripHtml(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parsePrice(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const found = value.match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!found) {
    return undefined;
  }
  const parsed = Number(found[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCountFromLayout(layout: string, label: 'bedrooms' | 'beds'): number | undefined {
  const match = layout.match(new RegExp(`(\\d+)\\s+${label.slice(0, -1)}s?\\b`, 'i'));
  if (!match?.[1]) {
    return undefined;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toJsonError(message: string, details: UnknownRecord = {}, extra: UnknownRecord = {}): { content: Array<{ type: 'text'; text: string }>; isError: boolean } {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: message,
        ...details,
        timestamp: new Date().toISOString(),
        ...extra,
      }, null, 2)
    }],
    isError: true,
  };
}

function filterByAllowedFields(payload: unknown, fields: string[]): unknown {
  if (!fields || fields.length === 0) {
    return payload;
  }
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
    return payload;
  }
  const allow = new Set(fields.map((field) => field.trim()).filter(Boolean));
  const out: UnknownRecord = {};
  for (const key of Object.keys(payload as UnknownRecord)) {
    if (allow.has(key) || allow.has('*')) {
      out[key] = (payload as UnknownRecord)[key];
    }
  }
  return out;
}

function projectSummaryFields(payload: UnknownRecord, fields?: string[]): UnknownRecord {
  if (!fields || fields.length === 0) {
    return payload;
  }
  return filterByAllowedFields(payload, fields) as UnknownRecord;
}

function resolveListingId(rawId: unknown): string {
  if (typeof rawId !== 'string') {
    return '';
  }
  const direct = rawId.trim();
  if (direct.length === 0) {
    return '';
  }
  const colonParts = direct.split(':');
  const maybeDirect = colonParts[colonParts.length - 1];
  if (/^\d+$/.test(maybeDirect)) {
    return maybeDirect;
  }
  try {
    const decoded = Buffer.from(direct, 'base64').toString('utf8');
    const decodedParts = decoded.split(':');
    const maybeDecoded = decodedParts[decodedParts.length - 1];
    if (/^\d+$/.test(maybeDecoded)) {
      return maybeDecoded;
    }
  } catch {
    // ignore
  }
  return direct;
}

function compactSearchResult(item: UnknownRecord): UnknownRecord {
  const demandStayListing = (item.demandStayListing ?? {}) as UnknownRecord;
  const structuredContent = (item.structuredContent ?? {}) as UnknownRecord;
  const structuredPrice = (item.structuredDisplayPrice ?? {}) as UnknownRecord;
  const listingId = resolveListingId(demandStayListing.id);
  const layoutSummary = trimText(firstText(
    structuredContent.primaryLine,
    (structuredContent.primaryLine as UnknownRecord)?.body,
  ), 120);

  const title = firstText(
    item.subtitle,
    (item.nameLocalized as UnknownRecord)?.localizedStringWithTranslationPreference,
    demandStayListing.title,
    demandStayListing.name,
    (demandStayListing.description as UnknownRecord)?.name,
    ((demandStayListing.description as UnknownRecord)?.name as UnknownRecord)?.localizedStringWithTranslationPreference,
    (demandStayListing.description as UnknownRecord)?.title,
    (structuredContent.primaryLine as UnknownRecord)?.body,
    structuredContent.primaryLine,
    (structuredContent.mapCategoryInfo as UnknownRecord)?.body,
    demandStayListing.description?.title,
    demandStayListing.titleLine,
  );

  const locationLine = firstText(
    item.title,
    (item.location as UnknownRecord)?.title,
    (item.location as UnknownRecord)?.subtitle,
    (item.location as UnknownRecord)?.name,
    (structuredContent.mapSecondaryLine as UnknownRecord)?.body,
    (structuredContent.secondaryLine as UnknownRecord)?.body,
  );

  const badgeLine = firstText(
    ...(Array.isArray(demandStayListing.badges) ? demandStayListing.badges : []) as string[],
    (item.badges as UnknownRecord)?.text,
  );

  const priceLine = firstText(
    (structuredPrice.primaryLine as UnknownRecord)?.accessibilityLabel,
    (structuredPrice.primaryLine as UnknownRecord)?.text,
    (structuredPrice.secondaryLine as UnknownRecord)?.accessibilityLabel,
    (structuredPrice.secondaryLine as UnknownRecord)?.text,
  );

  const rawDescription = firstText(
    demandStayListing.description,
    (structuredContent.mapCategoryInfo as UnknownRecord)?.body,
    (structuredContent.primaryLine as UnknownRecord)?.body,
  );

  return {
    id: listingId,
    title: trimText(title, 120),
    location: trimText(locationLine, 160),
    layoutSummary,
    bedrooms: parseCountFromLayout(layoutSummary, 'bedrooms'),
    beds: parseCountFromLayout(layoutSummary, 'beds'),
    rating: trimText(firstText(item.avgRatingA11yLabel), 48),
    price: trimText(priceLine, 80),
    priceAmount: parsePrice(priceLine),
    highlights: trimText((structuredContent.mapCategoryInfo as UnknownRecord)?.body, 220),
    badges: trimText(badgeLine, 240),
    description: trimText(stripHtml(rawDescription), CONTEXT_SUMMARY_LENGTH),
    coordinates: (demandStayListing.location as UnknownRecord)?.coordinate,
    url: listingId ? `${BASE_URL}/rooms/${listingId}` : undefined,
  };
}

function compactListingSection(section: UnknownRecord, maxTextLength = DETAIL_SUMMARY_LENGTH): UnknownRecord {
  const sectionId = String(section?.sectionId || section?.id || 'UNKNOWN');
  const title = trimText(firstText(section.title, section.sectionTitle, section.titleLine, sectionId), 120);

  if (sectionId === 'DESCRIPTION_DEFAULT') {
    return {
      id: sectionId,
      title,
      summary: trimText(stripHtml(section?.htmlDescription?.htmlText), maxTextLength),
    };
  }

  if (sectionId === 'AMENITIES_DEFAULT') {
    const amenities = new Set<string>();
    const groups = section?.seeAllAmenitiesGroups || [];
    if (Array.isArray(groups)) {
      for (const group of groups) {
        if (group?.amenities && Array.isArray(group.amenities)) {
          for (const amenity of group.amenities) {
            const name = trimText(firstText(amenity?.title), 80);
            if (name) {
              amenities.add(name);
            }
          }
        }
      }
    }
    return {
      id: sectionId,
      title,
      amenities: Array.from(amenities),
    };
  }

  if (sectionId === 'HIGHLIGHTS_DEFAULT') {
    const highlights = section?.highlights || [];
    const compacted = Array.isArray(highlights)
      ? highlights.map((highlight) => trimText(firstText(highlight?.title), 120)).filter(Boolean)
      : [];

    return {
      id: sectionId,
      title,
      highlights: compacted,
    };
  }

  if (sectionId === 'POLICIES_DEFAULT') {
    const groups = section?.houseRulesSections || [];
    const houseRules: string[] = [];
    if (Array.isArray(groups)) {
      for (const group of groups) {
        const heading = trimText(firstText(group?.title), 80);
        if (heading) {
          houseRules.push(heading);
        }
        if (Array.isArray(group?.items)) {
          for (const item of group.items) {
            const text = trimText(firstText(item?.title, item?.subtitle, item?.html?.htmlText), 160);
            if (text) {
              houseRules.push(`- ${text}`);
            }
          }
        }
      }
    }
    return {
      id: sectionId,
      title,
      houseRules,
    };
  }

  return {
    id: sectionId,
    title,
    summary: trimText(stripHtml(section), maxTextLength),
  };
}

function buildSummarySearchBlob(summary: UnknownRecord): string {
  return JSON.stringify(summary).toLowerCase();
}

function scoreTripStylesForSummary(searchBlob: string, tripStyles: string[]): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  for (const tripStyle of tripStyles) {
    const rule = TRIP_STYLE_RANKING_RULES[tripStyle];
    if (!rule) {
      continue;
    }

    const positiveMatches = rule.positive.filter((term) => searchBlob.includes(term.toLowerCase()));
    const negativeMatches = (rule.negative ?? []).filter((term) => searchBlob.includes(term.toLowerCase()));

    if (positiveMatches.length > 0) {
      score += rule.score + Math.min(2, positiveMatches.length - 1);
      reasons.push(`${tripStyle} matched ${positiveMatches[0]}`);
      continue;
    }

    if (negativeMatches.length > 0) {
      score -= Math.max(2, Math.floor(rule.score / 2));
      reasons.push(`${tripStyle} conflicts with ${negativeMatches[0]}`);
    }
  }

  return { score, reasons };
}

function scoreResultForContext(summary: UnknownRecord, context: UnknownRecord): { score: number; reasons: string[] } {
  let score = 60;
  const reasons: string[] = [];
  const price = typeof summary.priceAmount === 'number' ? summary.priceAmount : undefined;
  const rating = parseFloat(String(summary.rating || '').replace(/[^0-9.]/g, ''));
  const bedrooms = typeof summary.bedrooms === 'number' ? summary.bedrooms : undefined;
  const beds = typeof summary.beds === 'number' ? summary.beds : undefined;
  const searchBlob = buildSummarySearchBlob(summary);

  const maxPricePerNight = typeof context.maxPricePerNight === 'number' ? context.maxPricePerNight : undefined;
  if (typeof maxPricePerNight === 'number' && Number.isFinite(maxPricePerNight)) {
    if (typeof price === 'number' && Number.isFinite(price)) {
      if (price <= maxPricePerNight) {
        score += 10;
        reasons.push(`price within budget (${summary.price})`);
      } else {
        score -= 20;
        reasons.push(`price above budget (cap ${maxPricePerNight})`);
      }
    }
  }

  const minRating = typeof context.minRating === 'number' ? context.minRating : undefined;
  if (typeof minRating === 'number' && Number.isFinite(minRating)) {
    if (Number.isFinite(rating) && rating >= minRating) {
      score += 6;
      reasons.push(`rating >= ${minRating}`);
    } else {
      score -= 8;
      reasons.push(`rating below ${minRating}`);
    }
  }

  const requiredBedrooms = typeof context.requiredBedrooms === 'number' ? context.requiredBedrooms : undefined;
  if (typeof requiredBedrooms === 'number' && Number.isFinite(requiredBedrooms)) {
    if (typeof bedrooms === 'number' && bedrooms >= requiredBedrooms) {
      score += 8;
      reasons.push(`bedrooms >= ${requiredBedrooms}`);
    } else {
      score -= 25;
      reasons.push(`fewer than ${requiredBedrooms} bedrooms`);
    }
  }

  const requiredBeds = typeof context.requiredBeds === 'number' ? context.requiredBeds : undefined;
  if (typeof requiredBeds === 'number' && Number.isFinite(requiredBeds)) {
    if (typeof beds === 'number' && beds >= requiredBeds) {
      score += 6;
      reasons.push(`beds >= ${requiredBeds}`);
    } else {
      score -= 18;
      reasons.push(`fewer than ${requiredBeds} beds`);
    }
  }

  const mustHave: string[] = parseStringArray(context.mustHaveAmenities);
  const preferred: string[] = parseStringArray(context.preferredAmenities);
  const avoid: string[] = parseStringArray(context.avoidAmenities);
  const tripStyles: string[] = parseStringArray(context.tripStyles);

  if (tripStyles.length > 0) {
    const tripStyleScore = scoreTripStylesForSummary(searchBlob, tripStyles);
    score += tripStyleScore.score;
    reasons.push(...tripStyleScore.reasons);
  }

  for (const amenity of mustHave) {
    if (searchBlob.includes(amenity)) {
      score += 4;
      reasons.push(`has ${amenity}`);
    } else {
      score -= 4;
      reasons.push(`missing ${amenity}`);
    }
  }

  for (const amenity of preferred) {
    if (searchBlob.includes(amenity)) {
      score += 2;
      reasons.push(`preferred amenity present: ${amenity}`);
    }
  }

  for (const amenity of avoid) {
    if (searchBlob.includes(amenity)) {
      score -= 8;
      reasons.push(`avoid flagged: ${amenity}`);
    }
  }

  return {
    score,
    reasons,
  };
}

function normalizeLocationToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripGenericLocationPrefix(value: string): string {
  return value
    .replace(/^(?:apartment|home|house|condo|loft|rental unit|villa|guest suite|room|townhouse|cabin|bungalow|place)\s+in\s+/i, '')
    .replace(/^(?:entire\s+)?(?:rental\s+unit|home|apartment)\s+hosted\s+by\s+.+$/i, '')
    .trim();
}

function resolveLocationTargets(location: string, candidateLocations: string[]): string[] {
  const explicitCandidates = candidateLocations
    .map((value) => value.trim())
    .filter(Boolean);

  if (explicitCandidates.length > 0) {
    return Array.from(new Set(explicitCandidates));
  }

  return location ? [location] : [];
}

function hasContextualRankingSignals(context: ContextualSearchArgs): boolean {
  return Number.isFinite(context.maxPricePerNight)
    || Number.isFinite(context.minRating)
    || Number.isFinite(context.requiredBedrooms)
    || Number.isFinite(context.requiredBeds)
    || context.mustHaveAmenities.length > 0
    || context.preferredAmenities.length > 0
    || context.avoidAmenities.length > 0
    || context.tripStyles.length > 0;
}

function deriveLocationSearchTarget(locationLine: string, baseLocation: string): string | undefined {
  const trimmed = stripGenericLocationPrefix(parseString(locationLine));
  if (!trimmed) {
    return undefined;
  }

  const parts = trimmed
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return undefined;
  }

  const normalizedBase = normalizeLocationToken(baseLocation);
  const normalizedParts = parts.map((part) => normalizeLocationToken(part));
  if (normalizedBase && normalizedParts[0] === normalizedBase) {
    return undefined;
  }

  let target = parts.slice(0, Math.min(2, parts.length)).join(', ').trim();
  if (normalizedBase && normalizedParts[0].includes(normalizedBase)) {
    target = parts[0];
  } else if (normalizedBase && normalizedParts[1] === normalizedBase) {
    target = parts.slice(0, 2).join(', ').trim();
  }

  if (!target) {
    return undefined;
  }

  if (normalizedBase && normalizeLocationToken(target) === normalizedBase) {
    return undefined;
  }

  return target;
}

function deriveAutoExpandedLocationTargets(
  recommendations: RankedRecommendation[],
  baseLocation: string,
  existingTargets: string[],
): string[] {
  if (!AUTO_EXPAND_CONTEXTUAL_LOCATIONS || AUTO_EXPAND_LOCATION_LIMIT < 1) {
    return [];
  }

  const seen = new Set(
    [baseLocation, ...existingTargets]
      .map((value) => normalizeLocationToken(value))
      .filter(Boolean),
  );
  const derived: string[] = [];

  for (const recommendation of recommendations) {
    if (recommendation.matchScore < AUTO_EXPAND_SCORE_THRESHOLD) {
      continue;
    }

    const target = deriveLocationSearchTarget(parseString(recommendation.summary.location), baseLocation);
    if (!target) {
      continue;
    }

    const normalized = normalizeLocationToken(target);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    derived.push(target);
    if (derived.length >= AUTO_EXPAND_LOCATION_LIMIT) {
      break;
    }
  }

  return derived;
}

function satisfiesHardSearchSignals(summary: UnknownRecord, context: UnknownRecord): boolean {
  const requiredBedrooms = typeof context.requiredBedrooms === 'number' && Number.isFinite(context.requiredBedrooms)
    ? context.requiredBedrooms
    : undefined;
  const requiredBeds = typeof context.requiredBeds === 'number' && Number.isFinite(context.requiredBeds)
    ? context.requiredBeds
    : undefined;

  if (requiredBedrooms !== undefined) {
    const bedrooms = typeof summary.bedrooms === 'number' ? summary.bedrooms : undefined;
    if (bedrooms === undefined || bedrooms < requiredBedrooms) {
      return false;
    }
  }

  if (requiredBeds !== undefined) {
    const beds = typeof summary.beds === 'number' ? summary.beds : undefined;
    if (beds === undefined || beds < requiredBeds) {
      return false;
    }
  }

  return true;
}

function buildLocationSearchSlug(location: string): string {
  const normalized = parseString(location);
  if (!normalized) {
    return '';
  }

  const segments = normalized
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => segment
      .normalize('NFKD')
      .replace(/['.]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    )
    .filter(Boolean);

  return segments.join('--') || encodeURIComponent(normalized);
}

function buildSearchUrl(params: UnknownRecord): URL {
  const {
    location,
    placeId,
    checkin,
    checkout,
    adults,
    children,
    infants,
    pets,
    minPrice,
    maxPrice,
    cursor,
  } = params;

  const searchUrl = new URL(`${BASE_URL}/s/${buildLocationSearchSlug(String(location))}/homes`);
  if (placeId) {
    searchUrl.searchParams.append("place_id", String(placeId));
  } else if (location) {
    searchUrl.searchParams.append("query", String(location));
  }

  if (checkin) {
    searchUrl.searchParams.append("checkin", String(checkin));
  }
  if (checkout) {
    searchUrl.searchParams.append("checkout", String(checkout));
  }

  const adultsInt = clampInt(parseNumber(adults, 1), 0, 20);
  const childrenInt = clampInt(parseNumber(children, 0), 0, 20);
  const infantsInt = clampInt(parseNumber(infants, 0), 0, 20);
  const petsInt = clampInt(parseNumber(pets, 0), 0, 10);

  const totalGuests = adultsInt + childrenInt;
  if (totalGuests > 0) {
    searchUrl.searchParams.append("adults", String(adultsInt));
    searchUrl.searchParams.append("children", String(childrenInt));
    searchUrl.searchParams.append("infants", String(infantsInt));
    searchUrl.searchParams.append("pets", String(petsInt));
  }

  if (Number.isFinite(minPrice)) {
    searchUrl.searchParams.append("price_min", String(minPrice));
  }
  if (Number.isFinite(maxPrice)) {
    searchUrl.searchParams.append("price_max", String(maxPrice));
  }
  if (cursor) {
    searchUrl.searchParams.append("cursor", String(cursor));
  }

  return searchUrl;
}

function buildListingUrl(id: string, params: UnknownRecord): URL {
  const listingUrl = new URL(`${BASE_URL}/rooms/${encodeURIComponent(id)}`);

  const { checkin, checkout, adults, children, infants, pets } = params;
  if (checkin) {
    listingUrl.searchParams.append("check_in", String(checkin));
  }
  if (checkout) {
    listingUrl.searchParams.append("check_out", String(checkout));
  }

  const adultsInt = clampInt(parseNumber(adults, 1), 0, 20);
  const childrenInt = clampInt(parseNumber(children, 0), 0, 20);
  const infantsInt = clampInt(parseNumber(infants, 0), 0, 20);
  const petsInt = clampInt(parseNumber(pets, 0), 0, 10);
  const totalGuests = adultsInt + childrenInt;
  if (totalGuests > 0) {
    listingUrl.searchParams.append("adults", String(adultsInt));
    listingUrl.searchParams.append("children", String(childrenInt));
    listingUrl.searchParams.append("infants", String(infantsInt));
    listingUrl.searchParams.append("pets", String(petsInt));
  }

  return listingUrl;
}

function isPathAllowed(path: string): boolean {
  if (!robotsTxtContent) {
    return true;
  }

  try {
    const robots = robotsParser(`${BASE_URL}/robots.txt`, robotsTxtContent);
    const allowed = robots.isAllowed(path, USER_AGENT);
    if (!allowed) {
      log('warn', 'Path disallowed by robots.txt', { path, userAgent: USER_AGENT });
    }
    return Boolean(allowed);
  } catch (error) {
    log('warn', 'Error parsing robots.txt, allowing path', {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

async function fetchRobotsTxt() {
  if (IGNORE_ROBOTS_TXT) {
    log('info', 'Skipping robots.txt fetch (ignored by configuration)');
    return;
  }

  try {
    log('info', 'Fetching robots.txt from Airbnb');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const response = await fetch(`${BASE_URL}/robots.txt`, {
      headers: {
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    robotsTxtContent = await response.text();
    log('info', 'Successfully fetched robots.txt');
  } catch (error) {
    log('warn', 'Error fetching robots.txt, assuming all paths allowed', {
      error: error instanceof Error ? error.message : String(error),
    });
    robotsTxtContent = '';
  }
}

function getScriptContent(html: string): string {
  const $ = cheerio.load(html);
  const candidates = [
    $("#data-deferred-state-0"),
    $("script[data-hydration-data='airbnb']"),
    $("script[type='application/json']"),
  ];

  for (const container of candidates) {
    const el = container.first();
    if (el.length > 0) {
      const text = (el.text() || '').trim();
      if (text && text.includes('niobeClientData')) {
        return text;
      }
    }
  }

  let fallback = '';
  const scriptTags = $('script').toArray();
  for (const script of scriptTags) {
    const candidate = ($(script).text() || '').trim();
    if (candidate.includes('niobeClientData')) {
      fallback = candidate;
      break;
    }
  }

  return fallback;
}

async function fetchWithUserAgent(url: string, timeout: number = REQUEST_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Cache-Control": "no-cache",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.text();
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout}ms`);
    }
    throw error;
  }
}

async function fetchSearchData(searchUrl: URL): Promise<{ searchResults: UnknownRecord[]; paginationInfo: UnknownRecord | undefined } > {
  const responseText = await fetchWithUserAgent(searchUrl.toString());
  const $ = cheerio.load(responseText);
  const scriptContent = getScriptContent(responseText);
  if (!scriptContent) {
    throw new Error("Could not find Airbnb data payload on page (possibly a page structure change)");
  }

  const payload = JSON.parse(scriptContent);
  const clientData = payload?.niobeClientData?.[0]?.[1];
  const results = clientData?.data?.presentation?.staysSearch?.results;

  if (!results) {
    throw new Error("Could not locate staysSearch results in Airbnb payload");
  }

  const rawResults = (results.searchResults || []) as UnknownRecord[];
  const cleaned = rawResults
    .filter((value): value is UnknownRecord => value !== null && typeof value === 'object')
    .map((result) => flattenArraysInObject(pickBySchema(result, ALLOW_SEARCH_RESULT_SCHEMA)));

  return {
    searchResults: cleaned,
    paginationInfo: results.paginationInfo,
  };
}

const SIGNAL_TOOL_MAP: Record<string, ToolName[]> = {
  'search.location': ['airbnb_search', 'airbnb_search_contextual'],
  'search.placeId': ['airbnb_search', 'airbnb_search_contextual'],
  'search.candidateLocations': ['airbnb_search_contextual'],
  'search.checkin': ['airbnb_search', 'airbnb_search_contextual', 'airbnb_listing_details'],
  'search.checkout': ['airbnb_search', 'airbnb_search_contextual', 'airbnb_listing_details'],
  'search.cursor': ['airbnb_search'],
  'guests.adults': ['airbnb_search', 'airbnb_search_contextual', 'airbnb_listing_details'],
  'guests.children': ['airbnb_search', 'airbnb_search_contextual', 'airbnb_listing_details'],
  'guests.infants': ['airbnb_search', 'airbnb_search_contextual', 'airbnb_listing_details'],
  'guests.pets': ['airbnb_search', 'airbnb_search_contextual', 'airbnb_listing_details'],
  'pricing.minPrice': ['airbnb_search', 'airbnb_search_contextual'],
  'pricing.maxPrice': ['airbnb_search', 'airbnb_search_contextual'],
  'pricing.maxPricePerNight': ['airbnb_search_contextual'],
  'preferences.minRating': ['airbnb_search_contextual'],
  'preferences.mustHaveAmenities': ['airbnb_search_contextual'],
  'preferences.preferredAmenities': ['airbnb_search_contextual'],
  'preferences.avoidAmenities': ['airbnb_search_contextual'],
  'preferences.tripStyles': ['airbnb_search_contextual', 'airbnb_reconcile_results'],
  'space.requiredBedrooms': ['airbnb_search_contextual', 'airbnb_reconcile_results'],
  'space.requiredBeds': ['airbnb_search_contextual', 'airbnb_reconcile_results'],
  'listing.id': ['airbnb_listing_details'],
  'response.compact': ['airbnb_search', 'airbnb_search_contextual', 'airbnb_listing_details'],
  'response.maxResults': ['airbnb_search', 'airbnb_search_contextual'],
  'response.includeFields': ['airbnb_search'],
  'response.includeSections': ['airbnb_listing_details'],
  'execution.ignoreRobotsText': ['airbnb_search', 'airbnb_search_contextual', 'airbnb_listing_details'],
};

function hasUsableSignalValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value === 'boolean') {
    return true;
  }
  return value !== undefined && value !== null;
}

function buildContextSignals(store: PreparedContextStore, signalSources: Record<string, ContextValueSource | undefined>): ContextSignal[] {
  const definitions: Array<Omit<ContextSignal, 'source' | 'tools'> & { value: unknown }> = [
    { pattern: 'search.location', group: 'search', parameter: 'location', value: store.search.location },
    { pattern: 'search.placeId', group: 'search', parameter: 'placeId', value: store.search.placeId },
    { pattern: 'search.candidateLocations', group: 'search', parameter: 'candidateLocations', value: store.search.candidateLocations },
    { pattern: 'search.checkin', group: 'search', parameter: 'checkin', value: store.search.checkin },
    { pattern: 'search.checkout', group: 'search', parameter: 'checkout', value: store.search.checkout },
    { pattern: 'search.cursor', group: 'search', parameter: 'cursor', value: store.search.cursor },
    { pattern: 'guests.adults', group: 'guests', parameter: 'adults', value: store.guests.adults },
    { pattern: 'guests.children', group: 'guests', parameter: 'children', value: store.guests.children },
    { pattern: 'guests.infants', group: 'guests', parameter: 'infants', value: store.guests.infants },
    { pattern: 'guests.pets', group: 'guests', parameter: 'pets', value: store.guests.pets },
    { pattern: 'pricing.minPrice', group: 'pricing', parameter: 'minPrice', value: store.pricing.minPrice },
    { pattern: 'pricing.maxPrice', group: 'pricing', parameter: 'maxPrice', value: store.pricing.maxPrice },
    { pattern: 'pricing.maxPricePerNight', group: 'pricing', parameter: 'maxPricePerNight', value: store.pricing.maxPricePerNight },
    { pattern: 'preferences.minRating', group: 'preferences', parameter: 'minRating', value: store.preferences.minRating },
    { pattern: 'preferences.mustHaveAmenities', group: 'preferences', parameter: 'mustHaveAmenities', value: store.preferences.mustHaveAmenities },
    { pattern: 'preferences.preferredAmenities', group: 'preferences', parameter: 'preferredAmenities', value: store.preferences.preferredAmenities },
    { pattern: 'preferences.avoidAmenities', group: 'preferences', parameter: 'avoidAmenities', value: store.preferences.avoidAmenities },
    { pattern: 'preferences.tripStyles', group: 'preferences', parameter: 'tripStyles', value: store.preferences.tripStyles },
    { pattern: 'space.requiredBedrooms', group: 'space', parameter: 'requiredBedrooms', value: store.space.requiredBedrooms },
    { pattern: 'space.requiredBeds', group: 'space', parameter: 'requiredBeds', value: store.space.requiredBeds },
    { pattern: 'listing.id', group: 'listing', parameter: 'id', value: store.listing.id },
    { pattern: 'response.compact', group: 'response', parameter: 'compact', value: store.response.compact },
    { pattern: 'response.maxResults', group: 'response', parameter: 'maxResults', value: store.response.maxResults },
    { pattern: 'response.includeFields', group: 'response', parameter: 'includeFields', value: store.response.includeFields },
    { pattern: 'response.includeSections', group: 'response', parameter: 'includeSections', value: store.response.includeSections },
    { pattern: 'execution.ignoreRobotsText', group: 'execution', parameter: 'ignoreRobotsText', value: store.execution.ignoreRobotsText },
  ];

  return definitions
    .filter((definition) => hasUsableSignalValue(definition.value) && signalSources[definition.pattern])
    .map((definition) => ({
      ...definition,
      source: signalSources[definition.pattern] as ContextValueSource,
      tools: SIGNAL_TOOL_MAP[definition.pattern] ?? [],
    }));
}

function buildResolvedToolArguments(store: PreparedContextStore, toolName: ToolName): UnknownRecord {
  if (toolName === 'airbnb_search') {
    return (sanitizeToolArguments({
      location: store.search.location,
      placeId: store.search.placeId,
      checkin: store.search.checkin,
      checkout: store.search.checkout,
      adults: store.guests.adults,
      children: store.guests.children,
      infants: store.guests.infants,
      pets: store.guests.pets,
      minPrice: store.pricing.minPrice,
      maxPrice: store.pricing.maxPrice ?? store.pricing.maxPricePerNight,
      cursor: store.search.cursor,
      compact: store.response.compact,
      maxResults: store.response.maxResults,
      includeFields: store.response.includeFields,
      ignoreRobotsText: store.execution.ignoreRobotsText,
    }) ?? {}) as UnknownRecord;
  }

  if (toolName === 'airbnb_listing_details') {
    return (sanitizeToolArguments({
      id: store.listing.id,
      checkin: store.search.checkin,
      checkout: store.search.checkout,
      adults: store.guests.adults,
      children: store.guests.children,
      infants: store.guests.infants,
      pets: store.guests.pets,
      compact: store.response.compact,
      includeSections: store.response.includeSections,
      ignoreRobotsText: store.execution.ignoreRobotsText,
    }) ?? {}) as UnknownRecord;
  }

  if (toolName === 'airbnb_reconcile_results') {
    return (sanitizeToolArguments({
      maxResults: store.response.maxResults,
    }) ?? {}) as UnknownRecord;
  }

  return (sanitizeToolArguments({
    location: store.search.location,
    placeId: store.search.placeId,
    candidateLocations: store.search.candidateLocations,
    checkin: store.search.checkin,
    checkout: store.search.checkout,
    adults: store.guests.adults,
    children: store.guests.children,
    infants: store.guests.infants,
    pets: store.guests.pets,
    minPrice: store.pricing.minPrice,
    maxPrice: store.pricing.maxPrice,
    maxPricePerNight: store.pricing.maxPricePerNight,
    minRating: store.preferences.minRating,
    requiredBedrooms: store.space.requiredBedrooms,
    requiredBeds: store.space.requiredBeds,
    mustHaveAmenities: store.preferences.mustHaveAmenities,
    preferredAmenities: store.preferences.preferredAmenities,
    avoidAmenities: store.preferences.avoidAmenities,
    tripStyles: store.preferences.tripStyles,
    compact: store.response.compact,
    maxResults: store.response.maxResults,
    ignoreRobotsText: store.execution.ignoreRobotsText,
  }) ?? {}) as UnknownRecord;
}

function buildToolHint(store: PreparedContextStore, toolName: ToolName, cacheKey?: string): ToolHint {
  const hasSearchLocation = Boolean(store.search.location) || store.search.candidateLocations.length > 0;
  const missingRequired =
    toolName === 'airbnb_reconcile_results'
      ? ['results']
      : toolName === 'airbnb_listing_details'
      ? (store.listing.id ? [] : ['id'])
      : (toolName === 'airbnb_search'
        ? (store.search.location ? [] : ['location'])
        : (hasSearchLocation ? [] : ['location or candidateLocations']));

  return {
    ready: missingRequired.length === 0,
    missingRequired,
    cacheArguments: cacheKey ? { contextCacheKey: cacheKey } : {},
    resolvedArguments: buildResolvedToolArguments(store, toolName),
  };
}

function recommendTool(store: PreparedContextStore): ToolName | undefined {
  if (store.listing.id) {
    return 'airbnb_listing_details';
  }

  const hasLocationSignal = Boolean(store.search.location) || store.search.candidateLocations.length > 0;
  const hasContextualSignals = store.pricing.maxPricePerNight !== undefined
    || store.preferences.minRating !== undefined
    || store.space.requiredBedrooms !== undefined
    || store.space.requiredBeds !== undefined
    || store.preferences.mustHaveAmenities.length > 0
    || store.preferences.preferredAmenities.length > 0
    || store.preferences.avoidAmenities.length > 0
    || store.preferences.tripStyles.length > 0;

  if (hasContextualSignals && hasLocationSignal) {
    return 'airbnb_search_contextual';
  }

  if (store.search.location) {
    return 'airbnb_search';
  }

  return undefined;
}

function buildAgentGuidance(prepared: PreparedContextResult, toolHints: Record<ToolName, ToolHint>, cacheKey?: string): AgentGuidance {
  const recommendedTool = recommendTool(prepared.store);
  const recommendedHint = recommendedTool ? toolHints[recommendedTool] : undefined;
  const missingRequiredSignals = recommendedHint?.missingRequired ?? [];
  const weakSignals: string[] = [];
  const repairs: AgentRepairAction[] = [];

  if (!prepared.store.search.location && prepared.store.search.candidateLocations.length === 0) {
    weakSignals.push('location is missing');
    repairs.push({
      parameter: 'location',
      action: 'ask_user',
      reason: 'No grounded search location was extracted or supplied.',
    });
  }

  if (prepared.rawSource && prepared.store.guests.adults === undefined && prepared.store.guests.children === undefined) {
    weakSignals.push('guest count is missing and would default to 1 adult');
    repairs.push({
      parameter: 'adults',
      action: 'confirm',
      reason: 'Search tools default to 1 adult when guest counts are missing.',
      suggestedValue: 1,
    });
  }

  if (prepared.store.search.location && prepared.signalSources['search.location'] === 'context') {
    weakSignals.push('location was inferred from free-form context');
  }

  if (prepared.store.search.candidateLocations.length === 0 && prepared.store.preferences.tripStyles.length > 0) {
    repairs.push({
      parameter: 'candidateLocations',
      action: 'defer',
      reason: 'Trip-style signals are present; allow contextual search to auto-expand bounded sublocations if needed.',
    });
  }

  if (prepared.store.response.maxResults === undefined) {
    repairs.push({
      parameter: 'maxResults',
      action: 'set_explicit_value',
      reason: 'Agents should keep ranking calls compact by setting a deliberate result limit.',
      suggestedValue: recommendedTool === 'airbnb_listing_details' ? undefined : DEFAULT_CONTEXT_RESULTS,
    });
  }

  const workflow: AgentGuidance['workflow'] = [
    {
      step: 'prepare_context',
      status: 'completed',
      rationale: 'Structured context cache and parsed signals are available.',
    },
  ];

  if (recommendedTool) {
    workflow.push({
      step: 'execute_recommended_tool',
      status: missingRequiredSignals.length === 0 ? 'ready' : 'blocked',
      tool: recommendedTool,
      rationale: missingRequiredSignals.length === 0
        ? 'Prepared context is sufficient for the next network call.'
        : `Missing required signals: ${missingRequiredSignals.join(', ')}`,
      arguments: cacheKey ? { contextCacheKey: cacheKey } : recommendedHint?.resolvedArguments,
    });
  } else {
    workflow.push({
      step: 'select_network_tool',
      status: 'blocked',
      rationale: 'Prepared context does not yet have enough grounded signals to choose a downstream tool.',
    });
  }

  workflow.push({
    step: 'reconcile_returned_options',
    status: 'ready',
    tool: 'airbnb_reconcile_results',
    rationale: 'If the agent performs a broad search first, send the returned options back with contextCacheKey to re-score them against cached context.',
    arguments: cacheKey ? { contextCacheKey: cacheKey } : undefined,
  });

  workflow.push({
    step: 'fetch_listing_details_for_top_matches',
    status: recommendedTool === 'airbnb_listing_details' ? 'defer' : 'ready',
    tool: 'airbnb_listing_details',
    rationale: 'After ranking, fetch details only for the top 1-3 listings that survive hard filters.',
  });

  return {
    readyForNetworkSearch: missingRequiredSignals.length === 0 && Boolean(recommendedTool),
    shouldAskUserBeforeSearch: missingRequiredSignals.length > 0,
    recommendedTool,
    missingRequiredSignals,
    weakSignals,
    repairs,
    workflow,
  };
}

function prepareContextResult(raw: UnknownRecord, cacheEntry?: ContextCacheEntry): PreparedContextResult {
  const cacheStore = cacheEntry?.store;
  const rawSource = parseString(raw.context);
  const parsed = parseContext(rawSource);

  const explicitLocation = parseOptionalString(raw.location);
  const explicitPlaceId = parseOptionalString(raw.placeId);
  const explicitCandidateLocations = parseLiteralStringArray(raw.candidateLocations);
  const explicitCheckin = parseOptionalString(raw.checkin);
  const explicitCheckout = parseOptionalString(raw.checkout);
  const explicitAdults = parseOptionalNumber(raw.adults);
  const explicitChildren = parseOptionalNumber(raw.children);
  const explicitInfants = parseOptionalNumber(raw.infants);
  const explicitPets = parseOptionalNumber(raw.pets);
  const explicitMinPrice = parseOptionalNumber(raw.minPrice);
  const explicitMaxPrice = parseOptionalNumber(raw.maxPrice);
  const explicitMaxPricePerNight = parseOptionalNumber(raw.maxPricePerNight);
  const explicitMinRating = parseOptionalNumber(raw.minRating);
  const explicitRequiredBedrooms = parseOptionalNumber(raw.requiredBedrooms);
  const explicitRequiredBeds = parseOptionalNumber(raw.requiredBeds);
  const explicitId = parseOptionalString(raw.id);
  const explicitCursor = parseOptionalString(raw.cursor);
  const explicitCompact = parseOptionalBoolean(raw.compact);
  const explicitMaxResults = parseOptionalNumber(raw.maxResults);
  const explicitIgnoreRobotsText = parseOptionalBoolean(raw.ignoreRobotsText);

  const explicitMustHaveAmenities = parseStringArray(raw.mustHaveAmenities);
  const explicitPreferredAmenities = parseStringArray(raw.preferredAmenities);
  const explicitAvoidAmenities = parseStringArray(raw.avoidAmenities);
  const explicitTripStyles = parseStringArray(raw.tripStyles);
  const explicitIncludeFields = parseStringArray(raw.includeFields);
  const explicitIncludeSections = parseStringArray(raw.includeSections);

  const resolvedLocation = resolveLayeredValue<string>([
    { present: explicitLocation !== undefined, value: explicitLocation ?? '', source: 'explicit' },
    { present: parsed.location !== undefined, value: parsed.location ?? '', source: 'context' },
    { present: cacheStore?.search.location !== undefined, value: cacheStore?.search.location ?? '', source: 'cache' },
  ]);
  const resolvedPlaceId = resolveLayeredValue<string>([
    { present: explicitPlaceId !== undefined, value: explicitPlaceId ?? '', source: 'explicit' },
    { present: cacheStore?.search.placeId !== undefined, value: cacheStore?.search.placeId ?? '', source: 'cache' },
  ]);
  const resolvedCandidateLocations = resolveLayeredValue<string[]>([
    { present: hasOwnField(raw, 'candidateLocations'), value: explicitCandidateLocations, source: 'explicit' },
    { present: parsed.candidateLocations.length > 0, value: parsed.candidateLocations, source: 'context' },
    { present: (cacheStore?.search.candidateLocations.length ?? 0) > 0, value: cacheStore?.search.candidateLocations ?? [], source: 'cache' },
  ]);
  const resolvedCheckin = resolveLayeredValue<string>([
    { present: explicitCheckin !== undefined, value: explicitCheckin ?? '', source: 'explicit' },
    { present: parsed.checkin !== undefined, value: parsed.checkin ?? '', source: 'context' },
    { present: cacheStore?.search.checkin !== undefined, value: cacheStore?.search.checkin ?? '', source: 'cache' },
  ]);
  const resolvedCheckout = resolveLayeredValue<string>([
    { present: explicitCheckout !== undefined, value: explicitCheckout ?? '', source: 'explicit' },
    { present: parsed.checkout !== undefined, value: parsed.checkout ?? '', source: 'context' },
    { present: cacheStore?.search.checkout !== undefined, value: cacheStore?.search.checkout ?? '', source: 'cache' },
  ]);
  const resolvedAdults = resolveLayeredValue<number>([
    { present: explicitAdults !== undefined, value: explicitAdults ?? 0, source: 'explicit' },
    { present: parsed.adults !== undefined, value: parsed.adults ?? 0, source: 'context' },
    { present: cacheStore?.guests.adults !== undefined, value: cacheStore?.guests.adults ?? 0, source: 'cache' },
  ]);
  const resolvedChildren = resolveLayeredValue<number>([
    { present: explicitChildren !== undefined, value: explicitChildren ?? 0, source: 'explicit' },
    { present: parsed.children !== undefined, value: parsed.children ?? 0, source: 'context' },
    { present: cacheStore?.guests.children !== undefined, value: cacheStore?.guests.children ?? 0, source: 'cache' },
  ]);
  const resolvedInfants = resolveLayeredValue<number>([
    { present: explicitInfants !== undefined, value: explicitInfants ?? 0, source: 'explicit' },
    { present: parsed.infants !== undefined, value: parsed.infants ?? 0, source: 'context' },
    { present: cacheStore?.guests.infants !== undefined, value: cacheStore?.guests.infants ?? 0, source: 'cache' },
  ]);
  const resolvedPets = resolveLayeredValue<number>([
    { present: explicitPets !== undefined, value: explicitPets ?? 0, source: 'explicit' },
    { present: parsed.pets !== undefined, value: parsed.pets ?? 0, source: 'context' },
    { present: cacheStore?.guests.pets !== undefined, value: cacheStore?.guests.pets ?? 0, source: 'cache' },
  ]);
  const resolvedMinPrice = resolveLayeredValue<number>([
    { present: explicitMinPrice !== undefined, value: explicitMinPrice ?? 0, source: 'explicit' },
    { present: parsed.minPrice !== undefined, value: parsed.minPrice ?? 0, source: 'context' },
    { present: cacheStore?.pricing.minPrice !== undefined, value: cacheStore?.pricing.minPrice ?? 0, source: 'cache' },
  ]);
  const resolvedMaxPrice = resolveLayeredValue<number>([
    { present: explicitMaxPrice !== undefined, value: explicitMaxPrice ?? 0, source: 'explicit' },
    { present: parsed.maxPrice !== undefined || parsed.maxPricePerNight !== undefined, value: parsed.maxPrice ?? parsed.maxPricePerNight ?? 0, source: 'context' },
    { present: cacheStore?.pricing.maxPrice !== undefined || cacheStore?.pricing.maxPricePerNight !== undefined, value: cacheStore?.pricing.maxPrice ?? cacheStore?.pricing.maxPricePerNight ?? 0, source: 'cache' },
  ]);
  const resolvedMaxPricePerNight = resolveLayeredValue<number>([
    { present: explicitMaxPricePerNight !== undefined, value: explicitMaxPricePerNight ?? 0, source: 'explicit' },
    { present: parsed.maxPricePerNight !== undefined, value: parsed.maxPricePerNight ?? 0, source: 'context' },
    { present: cacheStore?.pricing.maxPricePerNight !== undefined, value: cacheStore?.pricing.maxPricePerNight ?? 0, source: 'cache' },
  ]);
  const resolvedMinRating = resolveLayeredValue<number>([
    { present: explicitMinRating !== undefined, value: explicitMinRating ?? 0, source: 'explicit' },
    { present: parsed.minRating !== undefined, value: parsed.minRating ?? 0, source: 'context' },
    { present: cacheStore?.preferences.minRating !== undefined, value: cacheStore?.preferences.minRating ?? 0, source: 'cache' },
  ]);
  const resolvedRequiredBedrooms = resolveLayeredValue<number>([
    { present: explicitRequiredBedrooms !== undefined, value: explicitRequiredBedrooms ?? 0, source: 'explicit' },
    { present: parsed.requiredBedrooms !== undefined, value: parsed.requiredBedrooms ?? 0, source: 'context' },
    { present: cacheStore?.space.requiredBedrooms !== undefined, value: cacheStore?.space.requiredBedrooms ?? 0, source: 'cache' },
  ]);
  const resolvedRequiredBeds = resolveLayeredValue<number>([
    { present: explicitRequiredBeds !== undefined, value: explicitRequiredBeds ?? 0, source: 'explicit' },
    { present: parsed.requiredBeds !== undefined, value: parsed.requiredBeds ?? 0, source: 'context' },
    { present: cacheStore?.space.requiredBeds !== undefined, value: cacheStore?.space.requiredBeds ?? 0, source: 'cache' },
  ]);
  const resolvedMustHaveAmenities = resolveLayeredValue<string[]>([
    { present: hasOwnField(raw, 'mustHaveAmenities'), value: explicitMustHaveAmenities, source: 'explicit' },
    { present: parsed.mustHaveAmenities.length > 0, value: parsed.mustHaveAmenities, source: 'context' },
    { present: (cacheStore?.preferences.mustHaveAmenities.length ?? 0) > 0, value: cacheStore?.preferences.mustHaveAmenities ?? [], source: 'cache' },
  ]);
  const resolvedPreferredAmenities = resolveLayeredValue<string[]>([
    { present: hasOwnField(raw, 'preferredAmenities'), value: explicitPreferredAmenities, source: 'explicit' },
    { present: parsed.preferredAmenities.length > 0, value: parsed.preferredAmenities, source: 'context' },
    { present: (cacheStore?.preferences.preferredAmenities.length ?? 0) > 0, value: cacheStore?.preferences.preferredAmenities ?? [], source: 'cache' },
  ]);
  const resolvedAvoidAmenities = resolveLayeredValue<string[]>([
    { present: hasOwnField(raw, 'avoidAmenities'), value: explicitAvoidAmenities, source: 'explicit' },
    { present: parsed.avoidAmenities.length > 0, value: parsed.avoidAmenities, source: 'context' },
    { present: (cacheStore?.preferences.avoidAmenities.length ?? 0) > 0, value: cacheStore?.preferences.avoidAmenities ?? [], source: 'cache' },
  ]);
  const resolvedTripStyles = resolveLayeredValue<string[]>([
    { present: hasOwnField(raw, 'tripStyles'), value: explicitTripStyles, source: 'explicit' },
    { present: parsed.tripStyles.length > 0, value: parsed.tripStyles, source: 'context' },
    { present: (cacheStore?.preferences.tripStyles.length ?? 0) > 0, value: cacheStore?.preferences.tripStyles ?? [], source: 'cache' },
  ]);
  const resolvedId = resolveLayeredValue<string>([
    { present: explicitId !== undefined, value: explicitId ?? '', source: 'explicit' },
    { present: parsed.listingId !== undefined, value: parsed.listingId ?? '', source: 'context' },
    { present: cacheStore?.listing.id !== undefined, value: cacheStore?.listing.id ?? '', source: 'cache' },
  ]);
  const resolvedCursor = resolveLayeredValue<string>([
    { present: explicitCursor !== undefined, value: explicitCursor ?? '', source: 'explicit' },
    { present: cacheStore?.search.cursor !== undefined, value: cacheStore?.search.cursor ?? '', source: 'cache' },
  ]);
  const resolvedCompact = resolveLayeredValue<boolean>([
    { present: explicitCompact !== undefined, value: explicitCompact ?? true, source: 'explicit' },
    { present: cacheStore?.response.compact !== undefined, value: cacheStore?.response.compact ?? true, source: 'cache' },
  ]);
  const resolvedMaxResults = resolveLayeredValue<number>([
    { present: explicitMaxResults !== undefined, value: explicitMaxResults ?? DEFAULT_SEARCH_RESULTS, source: 'explicit' },
    { present: cacheStore?.response.maxResults !== undefined, value: cacheStore?.response.maxResults ?? DEFAULT_SEARCH_RESULTS, source: 'cache' },
  ]);
  const resolvedIncludeFields = resolveLayeredValue<string[]>([
    { present: hasOwnField(raw, 'includeFields'), value: explicitIncludeFields, source: 'explicit' },
    { present: (cacheStore?.response.includeFields.length ?? 0) > 0, value: cacheStore?.response.includeFields ?? [], source: 'cache' },
  ]);
  const resolvedIncludeSections = resolveLayeredValue<string[]>([
    { present: hasOwnField(raw, 'includeSections'), value: explicitIncludeSections, source: 'explicit' },
    { present: (cacheStore?.response.includeSections.length ?? 0) > 0, value: cacheStore?.response.includeSections ?? [], source: 'cache' },
  ]);
  const resolvedIgnoreRobotsText = resolveLayeredValue<boolean>([
    { present: explicitIgnoreRobotsText !== undefined, value: explicitIgnoreRobotsText ?? false, source: 'explicit' },
    { present: cacheStore?.execution.ignoreRobotsText !== undefined, value: cacheStore?.execution.ignoreRobotsText ?? false, source: 'cache' },
  ]);

  const store: PreparedContextStore = {
    search: {
      location: resolvedLocation.value,
      placeId: resolvedPlaceId.value,
      candidateLocations: resolvedCandidateLocations.value ?? [],
      checkin: resolvedCheckin.value,
      checkout: resolvedCheckout.value,
      cursor: resolvedCursor.value,
    },
    guests: {
      adults: resolvedAdults.value,
      children: resolvedChildren.value,
      infants: resolvedInfants.value,
      pets: resolvedPets.value,
    },
    pricing: {
      minPrice: resolvedMinPrice.value,
      maxPrice: resolvedMaxPrice.value,
      maxPricePerNight: resolvedMaxPricePerNight.value,
    },
    preferences: {
      minRating: resolvedMinRating.value,
      mustHaveAmenities: resolvedMustHaveAmenities.value ?? [],
      preferredAmenities: resolvedPreferredAmenities.value ?? [],
      avoidAmenities: resolvedAvoidAmenities.value ?? [],
      tripStyles: resolvedTripStyles.value ?? [],
    },
    space: {
      requiredBedrooms: resolvedRequiredBedrooms.value,
      requiredBeds: resolvedRequiredBeds.value,
    },
    listing: {
      id: resolvedId.value,
    },
    response: {
      compact: resolvedCompact.value,
      maxResults: resolvedMaxResults.value !== undefined
        ? clampInt(resolvedMaxResults.value, 1, MAX_SEARCH_RESULTS)
        : undefined,
      includeFields: resolvedIncludeFields.value ?? [],
      includeSections: resolvedIncludeSections.value ?? [],
    },
    execution: {
      ignoreRobotsText: resolvedIgnoreRobotsText.value,
    },
  };

  const privacyMode = cacheEntry?.privacyMode ?? getPrivacyMode();
  const sourceFingerprint = hashContextSource(rawSource) ?? cacheEntry?.sourceFingerprint;
  const publicSourceSeed = rawSource || cacheEntry?.source || (sourceFingerprint ? 'cached context' : '');
  const publicSource = getPublicContextSource(publicSourceSeed, privacyMode);

  const signalSources: Record<string, ContextValueSource | undefined> = {
    'search.location': resolvedLocation.source,
    'search.placeId': resolvedPlaceId.source,
    'search.candidateLocations': resolvedCandidateLocations.source,
    'search.checkin': resolvedCheckin.source,
    'search.checkout': resolvedCheckout.source,
    'search.cursor': resolvedCursor.source,
    'guests.adults': resolvedAdults.source,
    'guests.children': resolvedChildren.source,
    'guests.infants': resolvedInfants.source,
    'guests.pets': resolvedPets.source,
    'pricing.minPrice': resolvedMinPrice.source,
    'pricing.maxPrice': resolvedMaxPrice.source,
    'pricing.maxPricePerNight': resolvedMaxPricePerNight.source,
    'preferences.minRating': resolvedMinRating.source,
    'preferences.mustHaveAmenities': resolvedMustHaveAmenities.source,
    'preferences.preferredAmenities': resolvedPreferredAmenities.source,
    'preferences.avoidAmenities': resolvedAvoidAmenities.source,
    'preferences.tripStyles': resolvedTripStyles.source,
    'space.requiredBedrooms': resolvedRequiredBedrooms.source,
    'space.requiredBeds': resolvedRequiredBeds.source,
    'listing.id': resolvedId.source,
    'response.compact': resolvedCompact.source,
    'response.maxResults': resolvedMaxResults.source,
    'response.includeFields': resolvedIncludeFields.source,
    'response.includeSections': resolvedIncludeSections.source,
    'execution.ignoreRobotsText': resolvedIgnoreRobotsText.source,
  };

  const notes = [
    ...parsed.notes,
    ...(cacheEntry ? [`context cache applied: ${cacheEntry.key}`] : []),
  ];

  return {
    rawSource,
    parsed,
    store,
    signalSources,
    signals: buildContextSignals(store, signalSources),
    privacyMode,
    publicSource,
    sourceFingerprint,
    notes,
  };
}

function parseSearchArgs(raw: UnknownRecord) {
  const contextCache = getContextCacheEntry(raw.contextCacheKey);
  const prepared = prepareContextResult(raw, contextCache);

  return {
    location: prepared.store.search.location ?? '',
    placeId: prepared.store.search.placeId ?? '',
    candidateLocations: prepared.store.search.candidateLocations,
    checkin: prepared.store.search.checkin ?? '',
    checkout: prepared.store.search.checkout ?? '',
    adults: prepared.store.guests.adults ?? 1,
    children: prepared.store.guests.children ?? 0,
    infants: prepared.store.guests.infants ?? 0,
    pets: prepared.store.guests.pets ?? 0,
    minPrice: prepared.store.pricing.minPrice ?? NaN,
    maxPrice: prepared.store.pricing.maxPrice ?? prepared.store.pricing.maxPricePerNight ?? NaN,
    cursor: prepared.store.search.cursor ?? '',
    ignoreRobotsText: prepared.store.execution.ignoreRobotsText ?? false,
    compact: prepared.store.response.compact ?? true,
    maxResults: clampInt(prepared.store.response.maxResults ?? DEFAULT_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS),
    includeFields: prepared.store.response.includeFields,
    contextCacheKey: contextCache?.key,
    contextCache,
  };
}

function parseListingArgs(raw: UnknownRecord) {
  const contextCache = getContextCacheEntry(raw.contextCacheKey);
  const prepared = prepareContextResult(raw, contextCache);

  return {
    id: prepared.store.listing.id ?? '',
    checkin: prepared.store.search.checkin ?? '',
    checkout: prepared.store.search.checkout ?? '',
    adults: prepared.store.guests.adults ?? 1,
    children: prepared.store.guests.children ?? 0,
    infants: prepared.store.guests.infants ?? 0,
    pets: prepared.store.guests.pets ?? 0,
    ignoreRobotsText: prepared.store.execution.ignoreRobotsText ?? false,
    compact: prepared.store.response.compact ?? true,
    includeSections: prepared.store.response.includeSections,
    contextCacheKey: contextCache?.key,
    contextCache,
  };
}

function parseContextArgs(raw: UnknownRecord) {
  const contextCache = getContextCacheEntry(raw.contextCacheKey);
  const prepared = prepareContextResult(raw, contextCache);

  return {
    location: prepared.store.search.location ?? '',
    placeId: prepared.store.search.placeId ?? '',
    checkin: prepared.store.search.checkin ?? '',
    checkout: prepared.store.search.checkout ?? '',
    adults: prepared.store.guests.adults ?? 1,
    children: prepared.store.guests.children ?? 0,
    infants: prepared.store.guests.infants ?? 0,
    pets: prepared.store.guests.pets ?? 0,
    minPrice: prepared.store.pricing.minPrice ?? NaN,
    maxPrice: prepared.store.pricing.maxPrice ?? NaN,
    cursor: prepared.store.search.cursor ?? '',
    ignoreRobotsText: prepared.store.execution.ignoreRobotsText ?? false,
    compact: prepared.store.response.compact ?? true,
    maxResults: clampInt(prepared.store.response.maxResults ?? DEFAULT_CONTEXT_RESULTS, 1, MAX_SEARCH_RESULTS),
    includeFields: prepared.store.response.includeFields,
    minRating: prepared.store.preferences.minRating ?? NaN,
    maxPricePerNight: prepared.store.pricing.maxPricePerNight ?? NaN,
    candidateLocations: prepared.store.search.candidateLocations,
    requiredBedrooms: prepared.store.space.requiredBedrooms ?? NaN,
    requiredBeds: prepared.store.space.requiredBeds ?? NaN,
    mustHaveAmenities: prepared.store.preferences.mustHaveAmenities,
    preferredAmenities: prepared.store.preferences.preferredAmenities,
    avoidAmenities: prepared.store.preferences.avoidAmenities,
    tripStyles: prepared.store.preferences.tripStyles,
    contextCacheKey: contextCache?.key,
    contextCache,
    context: {
      source: prepared.publicSource,
      sourceFingerprint: prepared.sourceFingerprint,
      privacyMode: prepared.privacyMode,
      parsed: prepared.parsed,
      used: {
        locationFromContext: prepared.signalSources['search.location'] === 'context',
        checkinFromContext: prepared.signalSources['search.checkin'] === 'context',
        checkoutFromContext: prepared.signalSources['search.checkout'] === 'context',
        adultsFromContext: prepared.signalSources['guests.adults'] === 'context',
        childrenFromContext: prepared.signalSources['guests.children'] === 'context',
        infantsFromContext: prepared.signalSources['guests.infants'] === 'context',
        petsFromContext: prepared.signalSources['guests.pets'] === 'context',
        priceFromContext:
          prepared.signalSources['pricing.minPrice'] === 'context'
          || prepared.signalSources['pricing.maxPrice'] === 'context'
          || prepared.signalSources['pricing.maxPricePerNight'] === 'context',
        ratingFromContext: prepared.signalSources['preferences.minRating'] === 'context',
        candidateLocationsFromContext: prepared.signalSources['search.candidateLocations'] === 'context',
        amenitiesFromContext:
          prepared.signalSources['preferences.mustHaveAmenities'] === 'context'
          || prepared.signalSources['preferences.preferredAmenities'] === 'context'
          || prepared.signalSources['preferences.avoidAmenities'] === 'context',
        tripStylesFromContext: prepared.signalSources['preferences.tripStyles'] === 'context',
        spaceFromContext:
          prepared.signalSources['space.requiredBedrooms'] === 'context'
          || prepared.signalSources['space.requiredBeds'] === 'context',
      },
    },
  } as ContextualSearchArgs;
}

function normalizeResultForReconciliation(result: UnknownRecord): UnknownRecord {
  const looksRawSearchResult = Boolean(result?.demandStayListing || result?.structuredContent || result?.structuredDisplayPrice);
  if (looksRawSearchResult) {
    return compactSearchResult(result);
  }

  return {
    id: parseOptionalString(result.id),
    title: parseString(result.title),
    location: parseString(result.location),
    layoutSummary: parseString(result.layoutSummary),
    bedrooms: parseOptionalNumber(result.bedrooms),
    beds: parseOptionalNumber(result.beds),
    rating: parseString(result.rating),
    price: parseString(result.price),
    priceAmount: parseOptionalNumber(result.priceAmount) ?? parsePrice(result.price),
    highlights: parseString(result.highlights),
    badges: parseString(result.badges),
    description: parseString(result.description),
    coordinates: result.coordinates,
    url: parseOptionalString(result.url),
  };
}

function parseReconcileArgs(raw: UnknownRecord): ReconcileArgs {
  const contextCache = getContextCacheEntry(raw.contextCacheKey);
  const prepared = prepareContextResult({}, contextCache);
  const maxResults = clampInt(parseOptionalNumber(raw.maxResults) ?? prepared.store.response.maxResults ?? DEFAULT_CONTEXT_RESULTS, 1, MAX_SEARCH_RESULTS);
  const agentCompact = parseBoolean(raw.agentCompact, false);
  const results = Array.isArray(raw.results)
    ? raw.results.filter((value): value is UnknownRecord => value !== null && typeof value === 'object')
    : [];

  return {
    contextCacheKey: contextCache?.key,
    contextCache,
    maxResults,
    agentCompact,
    parsed: prepared,
    results,
  };
}

async function runContextualSearchTargets(
  parsed: ContextualSearchArgs,
  locationTargets: string[],
  source: 'requested' | 'auto-expanded',
): Promise<ContextualSearchResponse[]> {
  const searchRequests = locationTargets.map(async (targetLocation) => {
    const searchUrl = buildSearchUrl({
      ...parsed,
      location: targetLocation,
    });
    const path = searchUrl.pathname + searchUrl.search;
    if (!parsed.ignoreRobotsText && !isPathAllowed(path)) {
      throw new Error(`${robotsErrorMessage} (${searchUrl.toString()})`);
    }

    const { searchResults, paginationInfo } = await fetchSearchData(searchUrl);
    return {
      targetLocation,
      searchUrl: searchUrl.toString(),
      paginationInfo,
      searchResults,
      source,
    } satisfies ContextualSearchResponse;
  });

  return Promise.all(searchRequests);
}

function rankSearchResponses(
  searchResponses: ContextualSearchResponse[],
  parsed: ContextualSearchArgs,
  candidateWindow: number,
): RankedRecommendation[] {
  const deduped = new Map<string, RankedRecommendation>();

  for (const response of searchResponses) {
    const candidates = response.searchResults.slice(0, candidateWindow);
    for (const result of candidates) {
      const summary: UnknownRecord = {
        ...compactSearchResult(result),
        sourceLocation: response.targetLocation,
      };
      const candidateKey = String(summary.id || `${response.targetLocation}:${JSON.stringify(summary)}`);

      if (!satisfiesHardSearchSignals(summary, parsed)) {
        continue;
      }

      const score = scoreResultForContext(summary, parsed);
      const ranked: RankedRecommendation = {
        summary,
        matchScore: score.score,
        matchReasons: score.reasons,
        searchTarget: response.targetLocation,
        searchTargetSource: response.source,
      };
      const existing = deduped.get(candidateKey);
      if (!existing || ranked.matchScore > existing.matchScore) {
        deduped.set(candidateKey, ranked);
      }
    }
  }

  return Array.from(deduped.values()).sort((a, b) => b.matchScore - a.matchScore);
}

function buildContextualAgentGuidance(
  parsed: ContextualSearchArgs,
  recommendations: RankedRecommendation[],
  completedStep: 'contextual_search' | 'reconcile_results' = 'contextual_search',
): AgentGuidance {
  const missingRequiredSignals: string[] = [];
  const weakSignals: string[] = [];
  const repairs: AgentRepairAction[] = [];

  if (!parsed.location && parsed.candidateLocations.length === 0) {
    missingRequiredSignals.push('location or candidateLocations');
  }

  if (parsed.adults === 1 && !parsed.context.used.adultsFromContext) {
    weakSignals.push('adult guest count is still using the default value of 1');
    repairs.push({
      parameter: 'adults',
      action: 'confirm',
      reason: 'The search ran with the default adult count because no explicit or parsed group size was available.',
      suggestedValue: 1,
    });
  }

  if (recommendations.length === 0) {
    repairs.push({
      parameter: 'candidateLocations',
      action: 'set_explicit_value',
      reason: 'No ranked results survived the current hard filters. Narrowing location targets or relaxing hard constraints is the next deterministic move.',
    });
  }

  const topRecommendationIds = recommendations
    .slice(0, 3)
    .map((entry) => parseString(entry.summary.id))
    .filter(Boolean);

  return {
    readyForNetworkSearch: true,
    shouldAskUserBeforeSearch: false,
    recommendedTool: recommendations.length > 0 ? 'airbnb_listing_details' : 'airbnb_search_contextual',
    missingRequiredSignals,
    weakSignals,
    repairs,
    workflow: [
      {
        step: completedStep,
        status: 'completed',
        tool: completedStep === 'reconcile_results' ? 'airbnb_reconcile_results' : 'airbnb_search_contextual',
        rationale: `Ranked ${recommendations.length} recommendation(s) using prepared signals.`,
      },
      {
        step: 'fetch_listing_details_for_top_matches',
        status: topRecommendationIds.length > 0 ? 'ready' : 'defer',
        tool: 'airbnb_listing_details',
        rationale: topRecommendationIds.length > 0
          ? 'Fetch details only for the top 1-3 ranked listings.'
          : 'No viable ranked listings were returned.',
        arguments: topRecommendationIds.length > 0
          ? { ids: topRecommendationIds }
          : undefined,
      },
    ],
  };
}

function buildCompactPrepareContextResponse(
  cacheEntry: ContextCacheEntry,
  prepared: PreparedContextResult,
  recommendedTool: ToolName | undefined,
  toolHints: Record<ToolName, ToolHint>,
  agentGuidance: AgentGuidance,
): UnknownRecord {
  const recommendedHint = recommendedTool ? toolHints[recommendedTool] : undefined;
  return {
    cache: {
      key: cacheEntry.key,
      expiresAt: cacheEntry.expiresAt,
      privacyMode: cacheEntry.privacyMode,
    },
    recommendedTool,
    nextArguments: recommendedHint?.cacheArguments ?? {},
    requiredRepairs: agentGuidance.repairs.filter((repair) => repair.action !== 'defer'),
    missingRequiredSignals: agentGuidance.missingRequiredSignals,
    weakSignals: agentGuidance.weakSignals,
    parsed: pickKnownKeys(prepared.parsed as UnknownRecord, [
      'location',
      'candidateLocations',
      'checkin',
      'checkout',
      'adults',
      'children',
      'infants',
      'pets',
      'maxPricePerNight',
      'minRating',
      'requiredBedrooms',
      'requiredBeds',
      'mustHaveAmenities',
      'preferredAmenities',
      'avoidAmenities',
      'tripStyles',
      'listingId',
    ]),
    workflow: agentGuidance.workflow,
  };
}

function buildCompactContextualSearchResponse(
  parsed: ContextualSearchArgs,
  recommendations: RankedRecommendation[],
  contextCacheKey?: string,
): UnknownRecord {
  const agentGuidance = buildContextualAgentGuidance(parsed, recommendations);
  return {
    contextCache: contextCacheKey
      ? {
        key: contextCacheKey,
        privacyMode: parsed.contextCache?.privacyMode,
      }
      : undefined,
    resolved: {
      location: parsed.location,
      candidateLocations: parsed.candidateLocations,
      checkin: parsed.checkin,
      checkout: parsed.checkout,
      adults: parsed.adults,
      children: parsed.children,
      requiredBedrooms: Number.isFinite(parsed.requiredBedrooms) ? parsed.requiredBedrooms : undefined,
      requiredBeds: Number.isFinite(parsed.requiredBeds) ? parsed.requiredBeds : undefined,
      tripStyles: parsed.tripStyles,
    },
    topListingIds: recommendations.slice(0, 3).map((entry) => entry.summary.id).filter(Boolean),
    recommendations: recommendations.slice(0, 5).map(compactRecommendationForAgent),
    agentGuidance,
  };
}

async function handleAirbnbPrepareContext(params: UnknownRecord) {
  const prepared = prepareContextResult(params || {});
  const cacheEntry = putContextCacheEntry(prepared);
  const recommendedTool = recommendTool(prepared.store);
  const agentCompact = parseBoolean((params || {}).agentCompact, false);

  const toolHints: Record<ToolName, ToolHint> = {
    airbnb_search: buildToolHint(prepared.store, 'airbnb_search', cacheEntry.key),
    airbnb_search_contextual: buildToolHint(prepared.store, 'airbnb_search_contextual', cacheEntry.key),
    airbnb_listing_details: buildToolHint(prepared.store, 'airbnb_listing_details', cacheEntry.key),
    airbnb_reconcile_results: buildToolHint(prepared.store, 'airbnb_reconcile_results', cacheEntry.key),
  };
  const agentGuidance = buildAgentGuidance(prepared, toolHints, cacheEntry.key);
  const payload = agentCompact
    ? buildCompactPrepareContextResponse(cacheEntry, prepared, recommendedTool, toolHints, agentGuidance)
    : {
      cache: {
        key: cacheEntry.key,
        createdAt: cacheEntry.createdAt,
        expiresAt: cacheEntry.expiresAt,
        ttlMs: CONTEXT_CACHE_TTL_MS,
        privacyMode: cacheEntry.privacyMode,
        sourceFingerprint: cacheEntry.sourceFingerprint,
      },
      context: {
        source: prepared.publicSource,
        sourceFingerprint: prepared.sourceFingerprint,
        privacyMode: prepared.privacyMode,
        parsed: prepared.parsed,
        notes: prepared.notes,
      },
      store: prepared.store,
      signals: prepared.signals,
      recommendedTool,
      toolHints,
      agentGuidance,
    };

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(payload, null, 2),
    }],
    isError: false,
  };
}

async function handleAirbnbSearch(params: UnknownRecord) {
  const parsed = parseSearchArgs(params || {});
  if (!parsed.location) {
    return toJsonError('location is required for search');
  }

  const searchUrl = buildSearchUrl(parsed);
  const path = searchUrl.pathname + searchUrl.search;
  if (!parsed.ignoreRobotsText && !isPathAllowed(path)) {
    log('warn', 'Search blocked by robots.txt', { path, url: searchUrl.toString() });
    return toJsonError(robotsErrorMessage, {
      url: searchUrl.toString(),
      suggestion: "Consider enabling 'ignore_robots_txt' in extension settings if needed for testing",
    });
  }

  try {
    log('info', 'Performing Airbnb search', {
      location: parsed.location,
      checkin: parsed.checkin,
      checkout: parsed.checkout,
      adults: parsed.adults,
      children: parsed.children,
      contextCacheKey: parsed.contextCacheKey,
    });

    const { searchResults, paginationInfo } = await fetchSearchData(searchUrl);
    const selected = searchResults.slice(0, parsed.maxResults).map((result) => {
      if (parsed.compact) {
        return compactSearchResult(result);
      }
      if (parsed.includeFields.length > 0) {
        return projectSummaryFields(result, parsed.includeFields);
      }
      return result;
    });

    log('info', 'Search completed successfully', {
      resultCount: selected.length,
      requestedResults: parsed.maxResults,
      compact: parsed.compact,
      totalAvailable: searchResults.length,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          searchUrl: searchUrl.toString(),
          contextCache: parsed.contextCacheKey
            ? {
              key: parsed.contextCacheKey,
              privacyMode: parsed.contextCache?.privacyMode,
            }
            : undefined,
          paginationInfo,
          resultsCount: selected.length,
          results: selected,
        }, null, 2),
      }],
      isError: false,
    };
  } catch (error) {
    log('error', 'Search request failed', {
      error: error instanceof Error ? error.message : String(error),
      url: searchUrl.toString(),
    });

    return toJsonError(
      error instanceof Error ? error.message : String(error),
      { searchUrl: searchUrl.toString() },
    );
  }
}

async function handleAirbnbListingDetails(params: UnknownRecord) {
  const parsed = parseListingArgs(params || {});
  if (!parsed.id) {
    return toJsonError('id is required for listing details');
  }

  const listingId = parsed.id.trim();
  const listingUrl = buildListingUrl(listingId, parsed);
  const path = listingUrl.pathname + listingUrl.search;

  if (!parsed.ignoreRobotsText && !isPathAllowed(path)) {
    log('warn', 'Listing details blocked by robots.txt', { path, url: listingUrl.toString() });
    return toJsonError(robotsErrorMessage, {
      url: listingUrl.toString(),
      suggestion: "Consider enabling 'ignore_robots_txt' in extension settings if needed for testing",
    });
  }

  try {
    log('info', 'Fetching listing details', {
      id: listingId,
      checkin: parsed.checkin,
      checkout: parsed.checkout,
      adults: parsed.adults,
      children: parsed.children,
      contextCacheKey: parsed.contextCacheKey,
    });

    const html = await fetchWithUserAgent(listingUrl.toString());
    const $ = cheerio.load(html);
    const scriptContent = getScriptContent(html);
    if (!scriptContent) {
      throw new Error("Could not find Airbnb data payload on listing page");
    }

    const payload = JSON.parse(scriptContent);
    const clientData = payload?.niobeClientData?.[0]?.[1];
    const sections = clientData?.data?.presentation?.stayProductDetailPage?.sections?.sections;

    if (!Array.isArray(sections)) {
      throw new Error("Could not locate stay detail sections in Airbnb payload");
    }

    const includeSections = new Set(parsed.includeSections);
    const parsedSections = sections
      .filter((section) => {
        const sectionId = String((section as UnknownRecord)?.sectionId || '');
        return (!includeSections.size || includeSections.has(sectionId));
      })
      .map((section) => {
        const sectionWrapper = section as UnknownRecord;
        const sectionId = String(sectionWrapper.sectionId || '');
        const sectionObj = ((sectionWrapper.section && typeof sectionWrapper.section === 'object')
          ? sectionWrapper.section
          : sectionWrapper) as UnknownRecord;
        if (ALLOW_SECTION_SCHEMA[sectionId]) {
          cleanObject(sectionObj);
          return {
            id: sectionId,
            ...flattenArraysInObject(pickBySchema(sectionObj, ALLOW_SECTION_SCHEMA[sectionId])),
          };
        }
        return undefined;
      })
      .filter((section): section is UnknownRecord => Boolean(section));

    const details = parsed.compact
      ? parsedSections.map((section) => compactListingSection(section, DETAIL_SUMMARY_LENGTH))
      : parsedSections;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          listingUrl: listingUrl.toString(),
          contextCache: parsed.contextCacheKey
            ? {
              key: parsed.contextCacheKey,
              privacyMode: parsed.contextCache?.privacyMode,
            }
            : undefined,
          details,
        }, null, 2),
      }],
      isError: false,
    };
  } catch (error) {
    log('error', 'Listing details request failed', {
      error: error instanceof Error ? error.message : String(error),
      id: listingId,
      url: listingUrl.toString(),
    });

    return toJsonError(
      error instanceof Error ? error.message : String(error),
      { listingUrl: listingUrl.toString() },
    );
  }
}

async function handleAirbnbContextualSearch(params: UnknownRecord) {
  const parsed = parseContextArgs(params || {});
  const agentCompact = parseBoolean((params || {}).agentCompact, false);
  const requestedLocationTargets = resolveLocationTargets(parsed.location, parsed.candidateLocations);
  if (requestedLocationTargets.length === 0) {
    return toJsonError('location or candidateLocations is required for contextual search');
  }

  try {
    log('info', 'Performing contextual Airbnb search', {
      location: parsed.location,
      candidateLocations: parsed.candidateLocations,
      tripStyles: parsed.tripStyles,
      maxPricePerNight: parsed.maxPricePerNight,
      minRating: parsed.minRating,
      requiredBedrooms: parsed.requiredBedrooms,
      requiredBeds: parsed.requiredBeds,
      mustHaveAmenities: parsed.mustHaveAmenities,
      preferredAmenities: parsed.preferredAmenities,
      avoidAmenities: parsed.avoidAmenities,
      contextCacheKey: parsed.contextCacheKey,
    });

    const requestedSearchResponses = await runContextualSearchTargets(parsed, requestedLocationTargets, 'requested');
    const paginationInfo = requestedSearchResponses[0]?.paginationInfo;
    const candidateWindow = Math.min(MAX_SEARCH_RESULTS, Math.max(parsed.maxResults * 2, parsed.maxResults + 10));
    const initialRanked = rankSearchResponses(requestedSearchResponses, parsed, candidateWindow);
    const autoExpandedLocations =
      parsed.candidateLocations.length === 0
      && Boolean(parsed.location)
      && hasContextualRankingSignals(parsed)
        ? deriveAutoExpandedLocationTargets(initialRanked, parsed.location, requestedLocationTargets)
        : [];

    const autoExpandedResponses = autoExpandedLocations.length > 0
      ? await runContextualSearchTargets(parsed, autoExpandedLocations, 'auto-expanded')
      : [];
    const allSearchResponses = [...requestedSearchResponses, ...autoExpandedResponses];
    const searchUrls = allSearchResponses.map((entry) => entry.searchUrl);
    const searchedLocations = allSearchResponses.map((entry) => entry.targetLocation);
    const scored = rankSearchResponses(allSearchResponses, parsed, candidateWindow).slice(0, parsed.maxResults);
    const agentGuidance = buildContextualAgentGuidance(parsed, scored);
    const payload = agentCompact
      ? buildCompactContextualSearchResponse(parsed, scored, parsed.contextCacheKey)
      : {
        searchUrl: searchUrls[0],
        requestedLocationTargets,
        autoExpandedLocations,
        searchedLocations,
        searchUrls,
        paginationInfo,
        contextCache: parsed.contextCacheKey
          ? {
            key: parsed.contextCacheKey,
            privacyMode: parsed.contextCache?.privacyMode,
          }
          : undefined,
        context: {
          source: parsed.context.source,
          sourceFingerprint: parsed.context.sourceFingerprint,
          privacyMode: parsed.context.privacyMode,
          usage: parsed.context.used,
          extracted: parsed.context.parsed,
          resolved: {
            location: parsed.location,
            checkin: parsed.checkin,
            checkout: parsed.checkout,
            adults: parsed.adults,
            children: parsed.children,
            infants: parsed.infants,
            pets: parsed.pets,
            minPrice: Number.isFinite(parsed.minPrice) ? parsed.minPrice : undefined,
            maxPrice: Number.isFinite(parsed.maxPrice) ? parsed.maxPrice : undefined,
            maxPricePerNight: Number.isFinite(parsed.maxPricePerNight) ? parsed.maxPricePerNight : undefined,
            minRating: Number.isFinite(parsed.minRating) ? parsed.minRating : undefined,
            requiredBedrooms: Number.isFinite(parsed.requiredBedrooms) ? parsed.requiredBedrooms : undefined,
            requiredBeds: Number.isFinite(parsed.requiredBeds) ? parsed.requiredBeds : undefined,
            tripStyles: parsed.tripStyles,
          },
          candidateLocations: parsed.candidateLocations,
          mustHaveAmenities: parsed.mustHaveAmenities,
          preferredAmenities: parsed.preferredAmenities,
          avoidAmenities: parsed.avoidAmenities,
          tripStyles: parsed.tripStyles,
        },
        recommendations: parsed.compact
          ? scored
          : scored.map((result) => result),
        agentGuidance,
      };

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      }],
      isError: false,
    };
  } catch (error) {
    log('error', 'Contextual search failed', {
      error: error instanceof Error ? error.message : String(error),
      location: parsed.location,
      candidateLocations: parsed.candidateLocations,
      tripStyles: parsed.tripStyles,
    });

    return toJsonError(
      error instanceof Error ? error.message : String(error),
      { location: parsed.location, candidateLocations: parsed.candidateLocations, tripStyles: parsed.tripStyles },
    );
  }
}

async function handleAirbnbReconcileResults(params: UnknownRecord) {
  const parsed = parseReconcileArgs(params || {});
  if (!parsed.contextCacheKey || !parsed.contextCache) {
    return toJsonError('valid contextCacheKey is required for result reconciliation');
  }

  if (parsed.results.length === 0) {
    return toJsonError('results is required for result reconciliation');
  }

  const contextForScoring: UnknownRecord = {
    maxPricePerNight: parsed.parsed.store.pricing.maxPricePerNight,
    minRating: parsed.parsed.store.preferences.minRating,
    requiredBedrooms: parsed.parsed.store.space.requiredBedrooms,
    requiredBeds: parsed.parsed.store.space.requiredBeds,
    mustHaveAmenities: parsed.parsed.store.preferences.mustHaveAmenities,
    preferredAmenities: parsed.parsed.store.preferences.preferredAmenities,
    avoidAmenities: parsed.parsed.store.preferences.avoidAmenities,
    tripStyles: parsed.parsed.store.preferences.tripStyles,
  };

  const ranked: RankedRecommendation[] = [];
  const excluded: UnknownRecord[] = [];

  for (const rawResult of parsed.results) {
    const summary = normalizeResultForReconciliation(rawResult);
    if (!satisfiesHardSearchSignals(summary, contextForScoring)) {
      excluded.push({
        id: summary.id,
        title: summary.title,
        location: summary.location,
        reason: 'failed hard context signals',
      });
      continue;
    }

    const score = scoreResultForContext(summary, contextForScoring);
    ranked.push({
      summary,
      matchScore: score.score,
      matchReasons: score.reasons,
      searchTarget: parseString(summary.location),
      searchTargetSource: 'requested',
    });
  }

  ranked.sort((a, b) => b.matchScore - a.matchScore);
  const selected = ranked.slice(0, parsed.maxResults);
  const contextualArgs = {
    location: parsed.parsed.store.search.location ?? '',
    candidateLocations: parsed.parsed.store.search.candidateLocations,
    adults: parsed.parsed.store.guests.adults ?? 1,
    children: parsed.parsed.store.guests.children ?? 0,
    infants: parsed.parsed.store.guests.infants ?? 0,
    pets: parsed.parsed.store.guests.pets ?? 0,
    minPrice: parsed.parsed.store.pricing.minPrice ?? NaN,
    maxPrice: parsed.parsed.store.pricing.maxPrice ?? NaN,
    maxPricePerNight: parsed.parsed.store.pricing.maxPricePerNight ?? NaN,
    minRating: parsed.parsed.store.preferences.minRating ?? NaN,
    mustHaveAmenities: parsed.parsed.store.preferences.mustHaveAmenities,
    preferredAmenities: parsed.parsed.store.preferences.preferredAmenities,
    avoidAmenities: parsed.parsed.store.preferences.avoidAmenities,
    tripStyles: parsed.parsed.store.preferences.tripStyles,
    requiredBedrooms: parsed.parsed.store.space.requiredBedrooms ?? NaN,
    requiredBeds: parsed.parsed.store.space.requiredBeds ?? NaN,
    checkin: parsed.parsed.store.search.checkin ?? '',
    checkout: parsed.parsed.store.search.checkout ?? '',
    contextCacheKey: parsed.contextCacheKey,
    contextCache: parsed.contextCache,
    context: {
      source: parsed.parsed.publicSource,
      sourceFingerprint: parsed.parsed.sourceFingerprint,
      privacyMode: parsed.parsed.privacyMode,
      parsed: parsed.parsed.parsed,
      used: {
        locationFromContext: parsed.parsed.signalSources['search.location'] === 'context',
        checkinFromContext: parsed.parsed.signalSources['search.checkin'] === 'context',
        checkoutFromContext: parsed.parsed.signalSources['search.checkout'] === 'context',
        adultsFromContext: parsed.parsed.signalSources['guests.adults'] === 'context',
        childrenFromContext: parsed.parsed.signalSources['guests.children'] === 'context',
        infantsFromContext: parsed.parsed.signalSources['guests.infants'] === 'context',
        petsFromContext: parsed.parsed.signalSources['guests.pets'] === 'context',
        priceFromContext:
          parsed.parsed.signalSources['pricing.minPrice'] === 'context'
          || parsed.parsed.signalSources['pricing.maxPrice'] === 'context'
          || parsed.parsed.signalSources['pricing.maxPricePerNight'] === 'context',
        ratingFromContext: parsed.parsed.signalSources['preferences.minRating'] === 'context',
        candidateLocationsFromContext: parsed.parsed.signalSources['search.candidateLocations'] === 'context',
        amenitiesFromContext:
          parsed.parsed.signalSources['preferences.mustHaveAmenities'] === 'context'
          || parsed.parsed.signalSources['preferences.preferredAmenities'] === 'context'
          || parsed.parsed.signalSources['preferences.avoidAmenities'] === 'context',
        tripStylesFromContext: parsed.parsed.signalSources['preferences.tripStyles'] === 'context',
        spaceFromContext:
          parsed.parsed.signalSources['space.requiredBedrooms'] === 'context'
          || parsed.parsed.signalSources['space.requiredBeds'] === 'context',
      },
    },
  } as ContextualSearchArgs;
  const agentGuidance = buildContextualAgentGuidance(contextualArgs, selected, 'reconcile_results');

  const payload = parsed.agentCompact
    ? {
      contextCache: {
        key: parsed.contextCacheKey,
        privacyMode: parsed.contextCache.privacyMode,
      },
      topListingIds: selected.slice(0, 3).map((entry) => entry.summary.id).filter(Boolean),
      recommendations: selected.map(compactRecommendationForAgent),
      excludedCount: excluded.length,
      agentGuidance,
    }
    : {
      contextCache: {
        key: parsed.contextCacheKey,
        privacyMode: parsed.contextCache.privacyMode,
      },
      resolved: {
        location: parsed.parsed.store.search.location,
        candidateLocations: parsed.parsed.store.search.candidateLocations,
        checkin: parsed.parsed.store.search.checkin,
        checkout: parsed.parsed.store.search.checkout,
        adults: parsed.parsed.store.guests.adults,
        children: parsed.parsed.store.guests.children,
        requiredBedrooms: parsed.parsed.store.space.requiredBedrooms,
        requiredBeds: parsed.parsed.store.space.requiredBeds,
        tripStyles: parsed.parsed.store.preferences.tripStyles,
      },
      recommendations: selected,
      excluded,
      agentGuidance,
    };

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(payload, null, 2),
    }],
    isError: false,
  };
}

function log(level: 'info' | 'warn' | 'error', message: string, data?: UnknownRecord) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  if (data) {
    console.error(`${logMessage}:`, JSON.stringify(data, null, 2));
  } else {
    console.error(logMessage);
  }
}

const server = new Server(
  {
    name: "airbnb",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

log('info', 'Airbnb MCP Server starting', {
  version: VERSION,
  ignoreRobotsTxt: IGNORE_ROBOTS_TXT,
  privacyMode: getPrivacyMode(),
  nodeVersion: process.version,
  platform: process.platform,
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: AIRBNB_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const startTime = Date.now();

  try {
    if (!request.params.name) {
      throw new McpError(ErrorCode.InvalidParams, "Tool name is required");
    }

    if (!request.params.arguments) {
      throw new McpError(ErrorCode.InvalidParams, "Tool arguments are required");
    }

    log('info', 'Tool call received', {
      tool: request.params.name,
      arguments: sanitizeArgumentsForLogging(request.params.arguments as UnknownRecord),
    });

    if (!robotsTxtContent && !IGNORE_ROBOTS_TXT) {
      await fetchRobotsTxt();
    }

    let result;
    switch (request.params.name) {
      case 'airbnb_prepare_context':
        result = await handleAirbnbPrepareContext(request.params.arguments as UnknownRecord);
        break;
      case 'airbnb_search':
        result = await handleAirbnbSearch(request.params.arguments as UnknownRecord);
        break;
      case 'airbnb_listing_details':
        result = await handleAirbnbListingDetails(request.params.arguments as UnknownRecord);
        break;
      case 'airbnb_search_contextual':
        result = await handleAirbnbContextualSearch(request.params.arguments as UnknownRecord);
        break;
      case 'airbnb_reconcile_results':
        result = await handleAirbnbReconcileResults(request.params.arguments as UnknownRecord);
        break;
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }

    const duration = Date.now() - startTime;
    log('info', 'Tool call completed', {
      tool: request.params.name,
      duration: `${duration}ms`,
      success: !result.isError,
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    log('error', 'Tool call failed', {
      tool: request.params.name,
      duration: `${duration}ms`,
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof McpError) {
      throw error;
    }

    return toJsonError(error instanceof Error ? error.message : String(error));
  }
});

async function runServer() {
  try {
    await fetchRobotsTxt();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('info', 'Airbnb MCP Server running on stdio', {
      version: VERSION,
      robotsRespected: !IGNORE_ROBOTS_TXT,
      privacyMode: getPrivacyMode(),
    });

    process.on('SIGINT', () => {
      log('info', 'Received SIGINT, shutting down gracefully');
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      log('info', 'Received SIGTERM, shutting down gracefully');
      process.exit(0);
    });
  } catch (error) {
    log('error', 'Failed to start server', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

runServer().catch((error) => {
  log('error', 'Fatal error running server', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
