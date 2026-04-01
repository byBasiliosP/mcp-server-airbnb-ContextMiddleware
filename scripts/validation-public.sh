#!/usr/bin/env bash
set -euo pipefail

node <<'NODE'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListResourceTemplatesResultSchema, ListResourcesResultSchema } from '@modelcontextprotocol/sdk/types.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseToolTextPayload(result) {
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  return text ? JSON.parse(text) : undefined;
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

  const prompt = await client.getPrompt({ name: 'public_agent_instructions', arguments: { route: 'search' } });
  assert(prompt?.messages?.length > 0, 'public_agent_instructions should return messages');

  console.log('✅ public package validation passed');
} finally {
  await client.close();
}
NODE
