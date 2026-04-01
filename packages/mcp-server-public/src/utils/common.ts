import type { UnknownRecord } from "../schemas/types.js";

export function cleanObject(obj: any) {
  Object.keys(obj).forEach((key) => {
    if (!obj[key] || key === "__typename") {
      delete obj[key];
    } else if (typeof obj[key] === "object") {
      cleanObject(obj[key]);
    }
  });
}

export function pickBySchema(obj: any, schema: any): any {
  if (typeof obj !== "object" || obj === null) {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => pickBySchema(item, schema));
  }

  const result: Record<string, any> = {};
  for (const key in schema) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const rule = schema[key];
      if (rule === true) {
        result[key] = obj[key];
      } else if (typeof rule === "object" && rule !== null) {
        result[key] = pickBySchema(obj[key], rule);
      }
    }
  }
  return result;
}

export function flattenArraysInObject(input: any, inArray = false): any {
  if (Array.isArray(input)) {
    const flatItems = input.map((item) => flattenArraysInObject(item, true));
    return flatItems.join(", ");
  }
  if (typeof input === "object" && input !== null) {
    if (inArray) {
      const values = Object.values(input).map((value) => flattenArraysInObject(value, true));
      return values.join(": ");
    }
    const result: Record<string, any> = {};
    for (const key in input) {
      if (Object.prototype.hasOwnProperty.call(input, key)) {
        result[key] = flattenArraysInObject(input[key], false);
      }
    }
    return result;
  }
  return input;
}

export function parseString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseOptionalString(value: unknown): string | undefined {
  const parsed = parseString(value);
  return parsed.length > 0 ? parsed : undefined;
}

export function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return fallback;
}

export function parseNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

export function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(
    value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean),
  ));
}

export function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "";
}

export function trimText(value: unknown, maxLength = 250): string {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength).trim()}…`;
}

export function stripHtml(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export function parsePrice(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const found = value.match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!found) {
    return undefined;
  }
  const parsed = Number(found[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseCountFromLayout(layout: string, label: "bedrooms" | "beds"): number | undefined {
  const match = layout.match(new RegExp(`(\\d+)\\s+${label.slice(0, -1)}s?\\b`, "i"));
  if (!match?.[1]) {
    return undefined;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseRatingValue(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = value.match(/([0-5](?:\.[0-9]+)?)/);
  if (!match?.[1]) {
    return undefined;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function pickFields(payload: UnknownRecord, fields?: string[]): UnknownRecord {
  if (!fields || fields.length === 0) {
    return payload;
  }
  const allow = new Set(fields);
  const output: UnknownRecord = {};
  for (const [key, value] of Object.entries(payload)) {
    if (allow.has(key) || allow.has("*")) {
      output[key] = value;
    }
  }
  return output;
}

export function jsonTextResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    isError: false,
  };
}

export function jsonTextError(message: string, details: UnknownRecord = {}) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        error: message,
        ...details,
        timestamp: new Date().toISOString(),
      }, null, 2),
    }],
    isError: true,
  };
}

export function toJsonResource(uri: string, payload: unknown) {
  return {
    uri,
    mimeType: "application/json",
    text: JSON.stringify(payload, null, 2),
  };
}
