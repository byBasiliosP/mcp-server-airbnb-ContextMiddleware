#!/usr/bin/env bash
set -euo pipefail

node <<'NODE'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ListResourceTemplatesResultSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/sdk/types.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseToolTextPayload(result) {
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  return text ? JSON.parse(text) : undefined;
}

async function readJsonResource(client, uri) {
  const response = await client.request({
    method: 'resources/read',
    params: { uri },
  }, ReadResourceResultSchema);
  const text = response?.contents?.[0]?.text;
  return text ? JSON.parse(text) : undefined;
}

async function runGroundedPublicSearch(client, location, expectedPathFragment, bounds) {
  const response = await client.callTool({
    name: 'airbnb_search',
    arguments: {
      location,
      checkin: '2026-04-25',
      checkout: '2026-04-27',
      adults: 2,
      ignoreRobotsText: true,
      maxResults: 1,
    },
  });
  const payload = parseToolTextPayload(response);
  assert(typeof payload?.searchUrl === 'string' && payload.searchUrl.includes(expectedPathFragment), `${location} searchUrl should include ${expectedPathFragment}`);
  assert(Array.isArray(payload?.results) && payload.results.length === 1, `${location} search should return one result`);
  const coordinates = payload.results[0]?.coordinates || {};
  const lat = Number(coordinates.latitude);
  const lng = Number(coordinates.longitude);
  assert(Number.isFinite(lat) && Number.isFinite(lng), `${location} result should include coordinates`);
  assert(lat >= bounds.minLat && lat <= bounds.maxLat, `${location} latitude ${lat} should be in bounds`);
  assert(lng >= bounds.minLng && lng <= bounds.maxLng, `${location} longitude ${lng} should be in bounds`);
}

const transport = new StdioClientTransport({
  command: 'node',
  args: ['packages/mcp-server-public/dist/server/index.js'],
});
const client = new Client({ name: 'public-validator', version: '0.1.0' }, { capabilities: {} });

try {
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name).sort();
  const expectedTools = [
    'airbnb_listing_details',
    'airbnb_search',
    'append_trip_decision',
    'build_candidate_set',
    'clear_trip_session',
    'compare_listings',
    'save_shortlist',
    'save_trip_constraints',
  ].sort();
  assert(JSON.stringify(toolNames) === JSON.stringify(expectedTools), `unexpected public tools: ${toolNames.join(', ')}`);

  const prompts = await client.listPrompts();
  const promptNames = prompts.prompts.map((prompt) => prompt.name);
  assert(promptNames.includes('public_agent_instructions'), 'public_agent_instructions prompt should exist');

  const resourceTemplates = await client.request({ method: 'resources/templates/list' }, ListResourceTemplatesResultSchema);
  const templateUris = resourceTemplates.resourceTemplates.map((entry) => entry.uriTemplate);
  assert(templateUris.includes('trip://{tripId}/constraints'), 'trip constraint resource template should exist');

  const savedConstraints = await client.callTool({
    name: 'save_trip_constraints',
    arguments: {
      constraints: {
        location: 'Chicago, IL',
        checkin: '2026-04-25',
        checkout: '2026-04-27',
        adults: 3,
        requiredBedrooms: 3,
        maxPricePerNight: 400,
      },
    },
  });
  const constraintsPayload = parseToolTextPayload(savedConstraints);
  assert(constraintsPayload?.tripId, 'save_trip_constraints should return tripId');

  const search = await client.callTool({
    name: 'airbnb_search',
    arguments: {
      location: 'Chicago, IL',
      checkin: '2026-04-25',
      checkout: '2026-04-27',
      adults: 3,
      ignoreRobotsText: true,
      maxResults: 3,
    },
  });
  const searchPayload = parseToolTextPayload(search);
  assert(Array.isArray(searchPayload?.results) && searchPayload.results.length > 0, 'airbnb_search should return results');

  await runGroundedPublicSearch(client, 'New York, NY', '/s/New-York--NY/homes', {
    minLat: 40.4,
    maxLat: 41.1,
    minLng: -74.4,
    maxLng: -73.3,
  });
  await runGroundedPublicSearch(client, 'Salt Lake City, UT', '/s/Salt-Lake-City--UT/homes', {
    minLat: 40.4,
    maxLat: 40.9,
    minLng: -112.2,
    maxLng: -111.6,
  });

  const listingDetails = await client.callTool({
    name: 'airbnb_listing_details',
    arguments: {
      id: searchPayload.results[0].id,
      compact: true,
      ignoreRobotsText: true,
    },
  });
  const listingPayload = parseToolTextPayload(listingDetails);
  assert(listingPayload?.listingId === searchPayload.results[0].id, 'airbnb_listing_details should preserve listing id');
  assert(typeof listingPayload?.normalized?.title === 'string' && listingPayload.normalized.title.length > 0, 'airbnb_listing_details should return normalized title');
  assert(Array.isArray(listingPayload?.sections) && listingPayload.sections.length > 0, 'airbnb_listing_details should return sections');

  const candidateSet = await client.callTool({
    name: 'build_candidate_set',
    arguments: {
      tripId: constraintsPayload.tripId,
      searchId: searchPayload.searchId,
      limit: 2,
    },
  });
  const candidatePayload = parseToolTextPayload(candidateSet);
  assert(candidatePayload?.tripId === constraintsPayload.tripId, 'build_candidate_set should attach to trip');

  const comparison = await client.callTool({
    name: 'compare_listings',
    arguments: {
      tripId: constraintsPayload.tripId,
      listings: searchPayload.results.slice(0, 2),
    },
  });
  const comparisonPayload = parseToolTextPayload(comparison);
  assert(Array.isArray(comparisonPayload?.compared), 'compare_listings should return compared listings');

  const shortlist = await client.callTool({
    name: 'save_shortlist',
    arguments: {
      tripId: constraintsPayload.tripId,
      listings: searchPayload.results.slice(0, 1),
      summary: 'Selected the best value option for follow-up.',
    },
  });
  const shortlistPayload = parseToolTextPayload(shortlist);
  assert(shortlistPayload?.shortlistCount === 1, 'save_shortlist should persist shortlist');

  const decision = await client.callTool({
    name: 'append_trip_decision',
    arguments: {
      tripId: constraintsPayload.tripId,
      note: 'Need to verify cancellation policy before booking.',
    },
  });
  const decisionPayload = parseToolTextPayload(decision);
  assert(decisionPayload?.decisionLogCount === 1, 'append_trip_decision should append decision log');

  const resources = await client.request({ method: 'resources/list' }, ListResourcesResultSchema);
  const uris = resources.resources.map((resource) => resource.uri);
  assert(uris.includes(`trip://${constraintsPayload.tripId}/constraints`), 'trip constraint resource should be listed');
  assert(uris.includes(`trip://${constraintsPayload.tripId}/shortlist`), 'trip shortlist resource should be listed');
  assert(uris.includes(`airbnb://search/${searchPayload.searchId}/results`), 'search results resource should be listed');
  assert(uris.includes(`airbnb://listing/${searchPayload.results[0].id}/normalized`), 'listing normalized resource should be listed');

  const constraintResource = await readJsonResource(client, `trip://${constraintsPayload.tripId}/constraints`);
  assert(constraintResource?.requiredBedrooms === 3, 'trip constraint resource should expose saved requiredBedrooms');

  const shortlistResource = await readJsonResource(client, `trip://${constraintsPayload.tripId}/shortlist`);
  assert(Array.isArray(shortlistResource) && shortlistResource.length === 1, 'trip shortlist resource should return one listing');

  const searchResultsResource = await readJsonResource(client, `airbnb://search/${searchPayload.searchId}/results`);
  assert(Array.isArray(searchResultsResource) && searchResultsResource.length > 0, 'search results resource should return stored results');

  const normalizedListingResource = await readJsonResource(client, `airbnb://listing/${searchPayload.results[0].id}/normalized`);
  assert(normalizedListingResource?.id === searchPayload.results[0].id, 'listing normalized resource should return requested listing');

  const prompt = await client.getPrompt({ name: 'public_agent_instructions', arguments: { route: 'search' } });
  assert(prompt?.messages?.length > 0, 'public_agent_instructions should return messages');

  console.log('✅ public package validation passed');
} finally {
  await client.close();
}
NODE
