import fetch from "node-fetch";
import * as cheerio from "cheerio";
import robotsParserModule from "robots-parser";
import type { ListingDetailsArgs, NormalizedListing, SearchArgs, UnknownRecord } from "../schemas/types.js";
import {
  cleanObject,
  clampInt,
  firstText,
  flattenArraysInObject,
  parseCountFromLayout,
  parseNumber,
  parsePrice,
  parseRatingValue,
  pickBySchema,
  stripHtml,
  trimText,
} from "./common.js";

const BASE_URL = "https://www.airbnb.com";
const USER_AGENT = "ModelContextProtocol/1.0 (Reusable Public MCP; +https://github.com/openbnb-org/mcp-server-airbnb)";
const REQUEST_TIMEOUT_MS = Number(process.env.AIRBNB_REQUEST_TIMEOUT_MS || "30000");
const robotsErrorMessage = "This path is disallowed by Airbnb's robots.txt for the configured User-Agent.";

let robotsTxtContent = "";
const robotsParser = robotsParserModule as unknown as (url: string, text: string) => { isAllowed: (path: string, userAgent: string) => boolean | undefined };

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
      },
    },
    description: true,
  },
  badges: {
    text: true,
  },
  structuredContent: {
    mapCategoryInfo: {
      body: true,
    },
    mapSecondaryLine: {
      body: true,
    },
    primaryLine: {
      body: true,
    },
    secondaryLine: {
      body: true,
    },
  },
  avgRatingA11yLabel: true,
  structuredDisplayPrice: {
    primaryLine: {
      accessibilityLabel: true,
      text: true,
    },
    secondaryLine: {
      accessibilityLabel: true,
      text: true,
    },
  },
};

const ALLOW_SECTION_SCHEMA: Record<string, any> = {
  LOCATION_DEFAULT: {
    lat: true,
    lng: true,
    subtitle: true,
    title: true,
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
      },
    },
  },
  HIGHLIGHTS_DEFAULT: {
    highlights: {
      title: true,
      subtitle: true,
    },
  },
  DESCRIPTION_DEFAULT: {
    title: true,
    htmlDescription: {
      htmlText: true,
    },
  },
  AMENITIES_DEFAULT: {
    title: true,
    seeAllAmenitiesGroups: {
      title: true,
      amenities: {
        title: true,
      },
    },
  },
};

export function getBaseUrl() {
  return BASE_URL;
}

export function getRobotsErrorMessage() {
  return robotsErrorMessage;
}

export async function ensureRobotsTxt(ignoreRobotsText: boolean) {
  if (ignoreRobotsText || robotsTxtContent) {
    return;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}/robots.txt`, {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (response.ok) {
      robotsTxtContent = await response.text();
    }
  } catch {
    clearTimeout(timeoutId);
    robotsTxtContent = "";
  }
}

export function isPathAllowed(path: string, ignoreRobotsText: boolean) {
  if (ignoreRobotsText || !robotsTxtContent) {
    return true;
  }
  try {
    const robots = robotsParser(`${BASE_URL}/robots.txt`, robotsTxtContent);
    return Boolean(robots.isAllowed(path, USER_AGENT));
  } catch {
    return true;
  }
}

export function buildLocationSearchSlug(location: string): string {
  const normalized = location.trim();
  if (!normalized) {
    return "";
  }
  const segments = normalized
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => segment
      .normalize("NFKD")
      .replace(/['.]/g, "")
      .replace(/&/g, " and ")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean);
  return segments.join("--") || encodeURIComponent(normalized);
}

export function buildSearchUrl(args: SearchArgs): URL {
  const url = new URL(`${BASE_URL}/s/${buildLocationSearchSlug(args.location)}/homes`);
  if (args.placeId) {
    url.searchParams.append("place_id", args.placeId);
  } else {
    url.searchParams.append("query", args.location);
  }
  if (args.checkin) {
    url.searchParams.append("checkin", args.checkin);
  }
  if (args.checkout) {
    url.searchParams.append("checkout", args.checkout);
  }

  const adults = clampInt(parseNumber(args.adults, 1), 0, 20);
  const children = clampInt(parseNumber(args.children, 0), 0, 20);
  const infants = clampInt(parseNumber(args.infants, 0), 0, 20);
  const pets = clampInt(parseNumber(args.pets, 0), 0, 10);
  if (adults + children > 0) {
    url.searchParams.append("adults", String(adults));
    url.searchParams.append("children", String(children));
    url.searchParams.append("infants", String(infants));
    url.searchParams.append("pets", String(pets));
  }

  if (typeof args.minPrice === "number" && Number.isFinite(args.minPrice)) {
    url.searchParams.append("price_min", String(args.minPrice));
  }
  if (typeof args.maxPrice === "number" && Number.isFinite(args.maxPrice)) {
    url.searchParams.append("price_max", String(args.maxPrice));
  }
  if (args.cursor) {
    url.searchParams.append("cursor", args.cursor);
  }
  return url;
}

export function buildListingUrl(args: ListingDetailsArgs): URL {
  const url = new URL(`${BASE_URL}/rooms/${encodeURIComponent(args.id)}`);
  if (args.checkin) {
    url.searchParams.append("check_in", args.checkin);
  }
  if (args.checkout) {
    url.searchParams.append("check_out", args.checkout);
  }

  const adults = clampInt(parseNumber(args.adults, 1), 0, 20);
  const children = clampInt(parseNumber(args.children, 0), 0, 20);
  const infants = clampInt(parseNumber(args.infants, 0), 0, 20);
  const pets = clampInt(parseNumber(args.pets, 0), 0, 10);
  if (adults + children > 0) {
    url.searchParams.append("adults", String(adults));
    url.searchParams.append("children", String(children));
    url.searchParams.append("infants", String(infants));
    url.searchParams.append("pets", String(pets));
  }
  return url;
}

function resolveListingId(rawId: unknown): string {
  if (typeof rawId !== "string") {
    return "";
  }
  const direct = rawId.trim();
  if (!direct) {
    return "";
  }
  const directParts = direct.split(":");
  const directCandidate = directParts[directParts.length - 1];
  if (/^\d+$/.test(directCandidate)) {
    return directCandidate;
  }
  try {
    const decoded = Buffer.from(direct, "base64").toString("utf8");
    const decodedParts = decoded.split(":");
    const decodedCandidate = decodedParts[decodedParts.length - 1];
    if (/^\d+$/.test(decodedCandidate)) {
      return decodedCandidate;
    }
  } catch {
    return direct;
  }
  return direct;
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
      const text = (el.text() || "").trim();
      if (text.includes("niobeClientData")) {
        return text;
      }
    }
  }

  for (const script of $("script").toArray()) {
    const candidate = ($(script).text() || "").trim();
    if (candidate.includes("niobeClientData")) {
      return candidate;
    }
  }
  return "";
}

async function fetchWithUserAgent(url: string) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Cache-Control": "no-cache",
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.text();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  }
}

function normalizeSearchResult(item: UnknownRecord): NormalizedListing {
  const demandStayListing = (item.demandStayListing ?? {}) as UnknownRecord;
  const structuredContent = (item.structuredContent ?? {}) as UnknownRecord;
  const structuredPrice = (item.structuredDisplayPrice ?? {}) as UnknownRecord;
  const layoutSummary = trimText(firstText(
    structuredContent.primaryLine,
    (structuredContent.primaryLine as UnknownRecord)?.body,
  ), 120);
  const title = firstText(
    item.subtitle,
    (item.nameLocalized as UnknownRecord)?.localizedStringWithTranslationPreference,
    (structuredContent.primaryLine as UnknownRecord)?.body,
  );
  const location = firstText(
    item.title,
    (structuredContent.mapSecondaryLine as UnknownRecord)?.body,
    (structuredContent.secondaryLine as UnknownRecord)?.body,
  );
  const priceLine = firstText(
    (structuredPrice.primaryLine as UnknownRecord)?.accessibilityLabel,
    (structuredPrice.primaryLine as UnknownRecord)?.text,
    (structuredPrice.secondaryLine as UnknownRecord)?.accessibilityLabel,
  );
  const rating = trimText(firstText(item.avgRatingA11yLabel), 48);
  const id = resolveListingId(demandStayListing.id);
  const highlights = trimText((structuredContent.mapCategoryInfo as UnknownRecord)?.body, 220);

  return {
    id,
    title: trimText(title, 120),
    location: trimText(location, 160),
    bedrooms: parseCountFromLayout(layoutSummary, "bedrooms"),
    beds: parseCountFromLayout(layoutSummary, "beds"),
    rating,
    ratingValue: parseRatingValue(rating),
    price: trimText(priceLine, 80),
    priceAmount: parsePrice(priceLine),
    highlights: highlights ? [highlights] : [],
    description: trimText(stripHtml(firstText(demandStayListing.description)), 180),
    coordinates: (demandStayListing.location as UnknownRecord)?.coordinate,
    url: id ? `${BASE_URL}/rooms/${id}` : undefined,
    source: "search",
  };
}

function normalizeListingSections(sections: UnknownRecord[]): { normalized: Partial<NormalizedListing>; compactSections: UnknownRecord[] } {
  const compactSections: UnknownRecord[] = [];
  const highlights = new Set<string>();
  const amenities = new Set<string>();
  const houseRules: string[] = [];
  let description = "";
  let location = "";
  let coordinates: NormalizedListing["coordinates"];

  for (const section of sections) {
    const sectionId = String(section?.sectionId || section?.id || "");
    if (!sectionId) {
      continue;
    }

    if (sectionId === "DESCRIPTION_DEFAULT") {
      description = trimText(stripHtml(section?.htmlDescription?.htmlText), 500);
      compactSections.push({ id: sectionId, title: firstText(section.title), summary: description });
      continue;
    }

    if (sectionId === "AMENITIES_DEFAULT") {
      const groups = section?.seeAllAmenitiesGroups || [];
      if (Array.isArray(groups)) {
        for (const group of groups) {
          if (Array.isArray(group?.amenities)) {
            for (const amenity of group.amenities) {
              const name = trimText(firstText(amenity?.title), 80);
              if (name) {
                amenities.add(name);
              }
            }
          }
        }
      }
      compactSections.push({ id: sectionId, title: firstText(section.title), amenities: Array.from(amenities) });
      continue;
    }

    if (sectionId === "HIGHLIGHTS_DEFAULT") {
      const rawHighlights = Array.isArray(section?.highlights) ? section.highlights : [];
      for (const highlight of rawHighlights) {
        const title = trimText(firstText(highlight?.title), 120);
        if (title) {
          highlights.add(title);
        }
      }
      compactSections.push({ id: sectionId, title: firstText(section.title), highlights: Array.from(highlights) });
      continue;
    }

    if (sectionId === "POLICIES_DEFAULT") {
      const groups = Array.isArray(section?.houseRulesSections) ? section.houseRulesSections : [];
      for (const group of groups) {
        const groupTitle = trimText(firstText(group?.title), 80);
        if (groupTitle) {
          houseRules.push(groupTitle);
        }
        if (Array.isArray(group?.items)) {
          for (const item of group.items) {
            const text = trimText(firstText(item?.title, item?.subtitle, item?.html?.htmlText), 160);
            if (text) {
              houseRules.push(text);
            }
          }
        }
      }
      compactSections.push({ id: sectionId, title: firstText(section.title), houseRules });
      continue;
    }

    if (sectionId === "LOCATION_DEFAULT") {
      location = trimText(firstText(section?.title, section?.subtitle), 140);
      coordinates = {
        latitude: section?.lat,
        longitude: section?.lng,
      };
      compactSections.push({ id: sectionId, title: firstText(section.title), subtitle: firstText(section.subtitle) });
      continue;
    }
  }

  return {
    normalized: {
      description: description || undefined,
      location: location || undefined,
      highlights: Array.from(highlights),
      amenities: Array.from(amenities),
      houseRules,
      coordinates,
      summary: description || Array.from(highlights).join(", ") || undefined,
      source: "listing_details",
    },
    compactSections,
  };
}

export async function searchListings(args: SearchArgs) {
  const searchUrl = buildSearchUrl(args);
  await ensureRobotsTxt(Boolean(args.ignoreRobotsText));
  if (!isPathAllowed(searchUrl.pathname + searchUrl.search, Boolean(args.ignoreRobotsText))) {
    throw new Error(robotsErrorMessage);
  }

  const responseText = await fetchWithUserAgent(searchUrl.toString());
  const payloadText = getScriptContent(responseText);
  if (!payloadText) {
    throw new Error("Could not find Airbnb data payload on search page");
  }
  const payload = JSON.parse(payloadText);
  const results = payload?.niobeClientData?.[0]?.[1]?.data?.presentation?.staysSearch?.results;
  if (!results) {
    throw new Error("Could not locate staysSearch results in Airbnb payload");
  }

  const rawResults = (results.searchResults || []) as UnknownRecord[];
  const cleaned = rawResults
    .filter((value): value is UnknownRecord => value !== null && typeof value === "object")
    .map((result) => flattenArraysInObject(pickBySchema(result, ALLOW_SEARCH_RESULT_SCHEMA)));
  const normalized = cleaned.map(normalizeSearchResult);

  return {
    searchUrl: searchUrl.toString(),
    paginationInfo: results.paginationInfo,
    rawResults: cleaned,
    normalizedResults: normalized,
  };
}

export async function fetchListingDetails(args: ListingDetailsArgs) {
  const listingUrl = buildListingUrl(args);
  await ensureRobotsTxt(Boolean(args.ignoreRobotsText));
  if (!isPathAllowed(listingUrl.pathname + listingUrl.search, Boolean(args.ignoreRobotsText))) {
    throw new Error(robotsErrorMessage);
  }

  const html = await fetchWithUserAgent(listingUrl.toString());
  const scriptContent = getScriptContent(html);
  if (!scriptContent) {
    throw new Error("Could not find Airbnb data payload on listing page");
  }

  const payload = JSON.parse(scriptContent);
  const sections = payload?.niobeClientData?.[0]?.[1]?.data?.presentation?.stayProductDetailPage?.sections?.sections;
  if (!Array.isArray(sections)) {
    throw new Error("Could not locate stay detail sections in Airbnb payload");
  }

  const includeSections = new Set(args.includeSections || []);
  const parsedSections = sections
    .filter((section: UnknownRecord) => {
      const sectionId = String(section?.sectionId || "");
      return !includeSections.size || includeSections.has(sectionId);
    })
    .map((sectionWrapper: UnknownRecord) => {
      const sectionId = String(sectionWrapper.sectionId || "");
      const sectionObj = ((sectionWrapper.section && typeof sectionWrapper.section === "object")
        ? sectionWrapper.section
        : sectionWrapper) as UnknownRecord;
      if (!ALLOW_SECTION_SCHEMA[sectionId]) {
        return undefined;
      }
      cleanObject(sectionObj);
      return {
        id: sectionId,
        ...flattenArraysInObject(pickBySchema(sectionObj, ALLOW_SECTION_SCHEMA[sectionId])),
      };
    })
    .filter((entry): entry is UnknownRecord => Boolean(entry));

  const normalizedSections = normalizeListingSections(parsedSections);
  return {
    listingUrl: listingUrl.toString(),
    sections: parsedSections,
    normalized: normalizedSections.normalized,
    compactSections: normalizedSections.compactSections,
  };
}
