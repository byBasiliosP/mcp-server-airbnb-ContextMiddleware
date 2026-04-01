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
      }
    },
    required: ["id"]
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
      }
    }
  }
};

const AIRBNB_TOOLS = [
  AIRBNB_SEARCH_TOOL,
  AIRBNB_LISTING_DETAILS_TOOL,
  AIRBNB_CONTEXT_TOOL,
] as const;

const ALLOW_SEARCH_RESULT_SCHEMA: Record<string, any> = {
  demandStayListing: {
    id: true,
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
        title: true
      }
    }
  },
  HIGHLIGHTS_DEFAULT: {
    highlights: {
      title: true
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
  mustHaveAmenities: string[];
  preferredAmenities: string[];
  avoidAmenities: string[];
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
  amenitiesFromContext: boolean;
};

type ContextualSearchArgs = ReturnType<typeof parseSearchArgs> & {
  minRating: number;
  maxPricePerNight: number;
  mustHaveAmenities: string[];
  preferredAmenities: string[];
  avoidAmenities: string[];
  context: {
    source: string;
    parsed: ContextParsedSignals;
    used: ContextUsage;
  };
};

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

function parseString(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  return '';
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value
    .map(item => (typeof item === 'string' ? item.toLowerCase().trim() : ''))
    .filter(Boolean)));
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
    .split(/[.;]/)
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

function parseContext(context: string): ContextParsedSignals {
  const source = parseString(context);
  if (!source) {
    return {
      mustHaveAmenities: [],
      preferredAmenities: [],
      avoidAmenities: [],
      notes: ['no context provided'],
    };
  }

  const location = parseContextLocation(source);
  const dates = parseContextDates(source);
  const guests = parseContextGuests(source);
  const budget = parseContextBudget(source);
  const rating = parseContextRating(source);
  const amenities = parseContextAmenities(source);

  return {
    location: location.location,
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
    mustHaveAmenities: amenities.mustHaveAmenities,
    preferredAmenities: amenities.preferredAmenities,
    avoidAmenities: amenities.avoidAmenities,
    notes: [
      ...location.notes,
      ...dates.notes,
      ...guests.notes,
      ...budget.notes,
      ...rating.notes,
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

  const title = firstText(
    demandStayListing.title,
    demandStayListing.name,
    (structuredContent.primaryLine as UnknownRecord)?.body,
    (structuredContent.mapCategoryInfo as UnknownRecord)?.body,
    demandStayListing.description?.title,
    demandStayListing.titleLine,
  );

  const locationLine = firstText(
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
    rating: trimText(firstText(item.avgRatingA11yLabel), 48),
    price: trimText(priceLine, 80),
    priceAmount: parsePrice(priceLine),
    highlights: trimText((structuredContent.mapCategoryInfo as UnknownRecord)?.body, 220),
    badges: trimText(badgeLine, 240),
    description: trimText(stripHtml(rawDescription), CONTEXT_SUMMARY_LENGTH),
    url: listingId ? `${BASE_URL}/rooms/${listingId}` : undefined,
  };
}

function compactListingSection(section: UnknownRecord, maxTextLength = DETAIL_SUMMARY_LENGTH): UnknownRecord {
  const sectionId = String(section?.sectionId || 'UNKNOWN');
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
            const text = trimText(firstText(item?.title), 160);
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

function scoreResultForContext(summary: UnknownRecord, context: UnknownRecord): { score: number; reasons: string[] } {
  let score = 60;
  const reasons: string[] = [];
  const price = typeof summary.priceAmount === 'number' ? summary.priceAmount : undefined;
  const rating = parseFloat(String(summary.rating || '').replace(/[^0-9.]/g, ''));

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

  const searchBlob = JSON.stringify(summary).toLowerCase();
  const mustHave: string[] = parseStringArray(context.mustHaveAmenities);
  const preferred: string[] = parseStringArray(context.preferredAmenities);
  const avoid: string[] = parseStringArray(context.avoidAmenities);

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

  const searchUrl = new URL(`${BASE_URL}/s/${encodeURIComponent(String(location))}/homes`);
  if (placeId) {
    searchUrl.searchParams.append("place_id", String(placeId));
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

function parseSearchArgs(raw: UnknownRecord) {
  return {
    location: parseString(raw.location),
    placeId: parseString(raw.placeId),
    checkin: parseString(raw.checkin),
    checkout: parseString(raw.checkout),
    adults: parseNumber(raw.adults, 1),
    children: parseNumber(raw.children, 0),
    infants: parseNumber(raw.infants, 0),
    pets: parseNumber(raw.pets, 0),
    minPrice: parseNumber(raw.minPrice, NaN),
    maxPrice: parseNumber(raw.maxPrice, NaN),
    cursor: parseString(raw.cursor),
    ignoreRobotsText: parseBoolean(raw.ignoreRobotsText, false),
    compact: parseBoolean(raw.compact, true),
    maxResults: clampInt(parseNumber(raw.maxResults, DEFAULT_SEARCH_RESULTS), 1, MAX_SEARCH_RESULTS),
    includeFields: parseStringArray(raw.includeFields),
  };
}

function parseListingArgs(raw: UnknownRecord) {
  return {
    id: parseString(raw.id),
    checkin: parseString(raw.checkin),
    checkout: parseString(raw.checkout),
    adults: parseNumber(raw.adults, 1),
    children: parseNumber(raw.children, 0),
    infants: parseNumber(raw.infants, 0),
    pets: parseNumber(raw.pets, 0),
    ignoreRobotsText: parseBoolean(raw.ignoreRobotsText, false),
    compact: parseBoolean(raw.compact, true),
    includeSections: parseStringArray(raw.includeSections),
  };
}

function parseContextArgs(raw: UnknownRecord) {
  const base = parseSearchArgs(raw || {});
  const contextInput = parseString(raw.context);
  const parsedContext = parseContext(contextInput);

  const hasLocation = hasOwnField(raw, 'location') && base.location.length > 0;
  const hasPlaceId = hasOwnField(raw, 'placeId') && base.placeId.length > 0;
  const hasCheckin = hasOwnField(raw, 'checkin') && base.checkin.length > 0;
  const hasCheckout = hasOwnField(raw, 'checkout') && base.checkout.length > 0;
  const hasAdults = hasOwnField(raw, 'adults');
  const hasChildren = hasOwnField(raw, 'children');
  const hasInfants = hasOwnField(raw, 'infants');
  const hasPets = hasOwnField(raw, 'pets');
  const hasMinPrice = hasOwnField(raw, 'minPrice') && Number.isFinite(base.minPrice);
  const hasMaxPrice = hasOwnField(raw, 'maxPrice') && Number.isFinite(base.maxPrice);
  const parsedMinRating = parseNumber(raw.minRating, NaN);
  const parsedMaxPricePerNight = parseNumber(raw.maxPricePerNight, NaN);
  const hasMinRating = hasOwnField(raw, 'minRating') && Number.isFinite(parsedMinRating);
  const hasMaxPricePerNight = hasOwnField(raw, 'maxPricePerNight') && Number.isFinite(parsedMaxPricePerNight);

  const explicitMustHaveAmenities = parseStringArray(raw.mustHaveAmenities);
  const explicitPreferredAmenities = parseStringArray(raw.preferredAmenities);
  const explicitAvoidAmenities = parseStringArray(raw.avoidAmenities);

  const mergedMinPrice = hasMinPrice
    ? base.minPrice
    : (parsedContext.minPrice ?? base.minPrice);
  const mergedMaxPrice = hasMaxPrice
    ? base.maxPrice
    : (parsedContext.maxPrice ?? parsedContext.maxPricePerNight ?? base.maxPrice);
  const mergedMaxPricePerNight = hasMaxPricePerNight
    ? parsedMaxPricePerNight
    : (parsedContext.maxPricePerNight ?? parsedMaxPricePerNight);
  const mergedMinRating = hasMinRating
    ? parsedMinRating
    : (parsedContext.minRating ?? NaN);

  const maxResultsFromInput = raw.maxResults === undefined
    ? DEFAULT_CONTEXT_RESULTS
    : parseNumber(raw.maxResults, DEFAULT_CONTEXT_RESULTS);

  const parsedContextAppliedPrice = !hasMinPrice
    && !hasMaxPrice
    && (parsedContext.minPrice !== undefined || parsedContext.maxPrice !== undefined || parsedContext.maxPricePerNight !== undefined);
  return {
    ...base,
    location: hasLocation ? base.location : (parsedContext.location || base.location),
    placeId: hasPlaceId ? base.placeId : '',
    checkin: hasCheckin ? base.checkin : (parsedContext.checkin || base.checkin),
    checkout: hasCheckout ? base.checkout : (parsedContext.checkout || base.checkout),
    adults: hasAdults ? base.adults : (parsedContext.adults ?? base.adults),
    children: hasChildren ? base.children : (parsedContext.children ?? base.children),
    infants: hasInfants ? base.infants : (parsedContext.infants ?? base.infants),
    pets: hasPets ? base.pets : (parsedContext.pets ?? base.pets),
    minPrice: mergedMinPrice,
    maxPrice: mergedMaxPrice,
    maxResults: clampInt(maxResultsFromInput, 1, MAX_SEARCH_RESULTS),
    minRating: mergedMinRating,
    maxPricePerNight: mergedMaxPricePerNight,
    mustHaveAmenities: uniqueNormalized([
      ...explicitMustHaveAmenities,
      ...parsedContext.mustHaveAmenities,
    ]),
    preferredAmenities: uniqueNormalized([
      ...explicitPreferredAmenities,
      ...parsedContext.preferredAmenities,
    ]),
    avoidAmenities: uniqueNormalized([
      ...explicitAvoidAmenities,
      ...parsedContext.avoidAmenities,
    ]),
    context: {
      source: contextInput,
      parsed: parsedContext,
      used: {
        locationFromContext: !hasLocation && Boolean(parsedContext.location),
        checkinFromContext: !hasCheckin && Boolean(parsedContext.checkin),
        checkoutFromContext: !hasCheckout && Boolean(parsedContext.checkout),
        adultsFromContext: !hasAdults && parsedContext.adults !== undefined,
        childrenFromContext: !hasChildren && parsedContext.children !== undefined,
        infantsFromContext: !hasInfants && parsedContext.infants !== undefined,
        petsFromContext: !hasPets && parsedContext.pets !== undefined,
        priceFromContext: parsedContextAppliedPrice,
        ratingFromContext: !hasMinRating && parsedContext.minRating !== undefined,
        amenitiesFromContext:
          !hasOwnField(raw, 'mustHaveAmenities')
          || !hasOwnField(raw, 'preferredAmenities')
          || !hasOwnField(raw, 'avoidAmenities'),
      },
    },
  } as ContextualSearchArgs;
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
        const sectionObj = section as UnknownRecord;
        const sectionId = String(sectionObj.sectionId || '');
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
  if (!parsed.location) {
    return toJsonError('location is required for contextual search');
  }

  const searchUrl = buildSearchUrl(parsed);
  const path = searchUrl.pathname + searchUrl.search;
  if (!parsed.ignoreRobotsText && !isPathAllowed(path)) {
    log('warn', 'Contextual search blocked by robots.txt', { path, url: searchUrl.toString() });
    return toJsonError(robotsErrorMessage, {
      url: searchUrl.toString(),
      suggestion: "Consider enabling 'ignore_robots_txt' in extension settings if needed for testing",
    });
  }

  try {
    log('info', 'Performing contextual Airbnb search', {
      location: parsed.location,
      maxPricePerNight: parsed.maxPricePerNight,
      minRating: parsed.minRating,
      mustHaveAmenities: parsed.mustHaveAmenities,
      preferredAmenities: parsed.preferredAmenities,
      avoidAmenities: parsed.avoidAmenities,
    });

    const { searchResults, paginationInfo } = await fetchSearchData(searchUrl);
    const candidates = searchResults.slice(0, Math.min(MAX_SEARCH_RESULTS, Math.max(parsed.maxResults * 2, parsed.maxResults + 10)));
    const scored = candidates.map((result) => {
      const summary = compactSearchResult(result);
      const score = scoreResultForContext(summary, parsed);
      return {
        summary,
        matchScore: score.score,
        matchReasons: score.reasons,
      };
    })
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, parsed.maxResults);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          searchUrl: searchUrl.toString(),
          paginationInfo,
          context: {
            source: parsed.context.source,
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
            },
            mustHaveAmenities: parsed.mustHaveAmenities,
            preferredAmenities: parsed.preferredAmenities,
            avoidAmenities: parsed.avoidAmenities,
          },
          recommendations: parsed.compact
            ? scored
            : scored.map((result) => result),
        }, null, 2),
      }],
      isError: false,
    };
  } catch (error) {
    log('error', 'Contextual search failed', {
      error: error instanceof Error ? error.message : String(error),
      url: searchUrl.toString(),
    });

    return toJsonError(
      error instanceof Error ? error.message : String(error),
      { searchUrl: searchUrl.toString() },
    );
  }
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
      arguments: request.params.arguments,
    });

    if (!robotsTxtContent && !IGNORE_ROBOTS_TXT) {
      await fetchRobotsTxt();
    }

    let result;
    switch (request.params.name) {
      case 'airbnb_search':
        result = await handleAirbnbSearch(request.params.arguments as UnknownRecord);
        break;
      case 'airbnb_listing_details':
        result = await handleAirbnbListingDetails(request.params.arguments as UnknownRecord);
        break;
      case 'airbnb_search_contextual':
        result = await handleAirbnbContextualSearch(request.params.arguments as UnknownRecord);
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
