#!/usr/bin/env bash
set -euo pipefail

node --input-type=module <<'NODE'
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

const timeoutMs = Number(process.env.VALIDATION_TIMEOUT_MS || '60000');
const command = process.env.MCP_SERVER_CMD || 'node dist/index.js --ignore-robots-txt';
const cwd = process.env.MCP_SERVER_CWD || process.cwd();
const expectedTools = ['airbnb_prepare_context', 'airbnb_search', 'airbnb_listing_details', 'airbnb_search_contextual', 'airbnb_reconcile_results'];

function parseCommand(cmd) {
  const trimmed = cmd.trim();
  if (!trimmed) {
    return { cmd: 'node', args: ['dist/index.js', '--ignore-robots-txt'] };
  }
  const parts = trimmed.match(/(?:[^\s\"]+|\"[^\"]*\"|'[^']*')+/g) || [];
  const expanded = parts.map((part) => {
    if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
      return part.slice(1, -1);
    }
    return part;
  });
  return { cmd: expanded[0], args: expanded.slice(1) };
}

function createJsonRpcClient(proc) {
  const rl = readline.createInterface({ input: proc.stdout });
  let nextId = 1;
  const pending = new Map();
  let closed = false;

  rl.on('line', (line) => {
    const text = String(line).trim();
    if (!text) {
      return;
    }

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    const id = message && typeof message.id !== 'undefined' ? message.id : undefined;
    if (!id || !pending.has(id)) {
      return;
    }

    const entry = pending.get(id);
    clearTimeout(entry.timeout);
    pending.delete(id);
    entry.resolve(message);
  });

  proc.stderr.on('data', (chunk) => {
    process.stderr.write(`[server] ${chunk.toString()}`);
  });

  proc.on('exit', (code, signal) => {
    closed = true;
    for (const pendingEntry of pending.values()) {
      clearTimeout(pendingEntry.timeout);
      pendingEntry.reject(new Error(`Server exited before request completed (code=${code}, signal=${signal || 'none'})`));
    }
    pending.clear();
  });

  const sendRequest = (method, params = {}) => {
    const id = nextId++;
    const message = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for response to ${method} (id=${id})`));
      }, timeoutMs);

      pending.set(id, { resolve, reject, timeout });
      proc.stdin.write(`${JSON.stringify(message)}\n`);
    });
  };

  const sendNotification = (method, params = {}) => {
    const message = {
      jsonrpc: '2.0',
      method,
      params,
    };
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  };

  return { sendRequest, sendNotification, close: async () => {
    if (closed) {
      return;
    }
    proc.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 3000);

      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }};
}

function parseToolTextPayload(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    return undefined;
  }
  return JSON.parse(text);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function eqSets(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

async function runGroundedSearch(client, location, expectedPathFragment, bounds) {
  const response = await client.sendRequest('tools/call', {
    name: 'airbnb_search',
    arguments: {
      location,
      checkin: '2026-04-25',
      checkout: '2026-04-27',
      adults: 2,
      compact: true,
      maxResults: 1,
      ignoreRobotsText: true,
    },
  });

  assert(!response.error, `${location} search should not return JSON-RPC error`);
  const payload = parseToolTextPayload(response.result);
  assert(payload && !payload.error, `${location} search should not return tool-level error`);
  assert(typeof payload.searchUrl === 'string' && payload.searchUrl.includes(expectedPathFragment), `${location} searchUrl should include ${expectedPathFragment}`);
  assert(Array.isArray(payload.results) && payload.results.length > 0, `${location} search should return at least one result`);

  const first = payload.results[0];
  const lat = Number(first?.coordinates?.latitude);
  const lng = Number(first?.coordinates?.longitude);
  assert(Number.isFinite(lat) && Number.isFinite(lng), `${location} first result should include coordinates`);
  assert(lat >= bounds.minLat && lat <= bounds.maxLat, `${location} latitude ${lat} should fall within expected bounds`);
  assert(lng >= bounds.minLng && lng <= bounds.maxLng, `${location} longitude ${lng} should fall within expected bounds`);
  console.log(`✅ ${location} grounded search returned coordinates ${lat}, ${lng}`);
}

async function runAgentPromptStyle(client, prompt, assertions) {
  const prepared = await client.sendRequest('tools/call', {
    name: 'airbnb_prepare_context',
    arguments: {
      context: prompt,
      agentCompact: true,
      ignoreRobotsText: true,
    },
  });

  assert(!prepared.error, 'style prepare_context should not return JSON-RPC error');
  const payload = parseToolTextPayload(prepared.result);
  assert(payload?.cache?.key, 'style prepare_context should return cache key');

  if (typeof assertions.location === 'string') {
    assert(String(payload?.parsed?.location || '').toLowerCase().includes(assertions.location.toLowerCase()), `style prompt should infer location containing ${assertions.location}`);
  }
  if (typeof assertions.adults === 'number') {
    assert(payload?.parsed?.adults === assertions.adults, `style prompt should infer adults=${assertions.adults}`);
  }
  if (typeof assertions.requiredBedrooms === 'number') {
    assert(payload?.parsed?.requiredBedrooms === assertions.requiredBedrooms, `style prompt should infer requiredBedrooms=${assertions.requiredBedrooms}`);
  }
  if (Array.isArray(assertions.tripStyles)) {
    for (const style of assertions.tripStyles) {
      assert(Array.isArray(payload?.parsed?.tripStyles) && payload.parsed.tripStyles.includes(style), `style prompt should infer trip style ${style}`);
    }
  }

  console.log(`✅ style prompt parsed as expected: ${prompt.slice(0, 60)}...`);
}

(async () => {
  const { cmd, args } = parseCommand(command);

  const server = spawn(cmd, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      IGNORE_ROBOTS_TXT: 'true',
    },
  });

  const client = createJsonRpcClient(server);
  let failures = 0;

  const fail = (message, error) => {
    failures += 1;
    console.error(`\n❌ ${message}`);
    if (error && error.message) {
      console.error(`   ${error.message}`);
    }
  };

  try {
    await sleep(1200);

    await client.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'validation-script', version: '1.0.0' },
    });
    client.sendNotification('initialized', {});

    const listed = await client.sendRequest('tools/list');
    assert(!listed.error, 'tools/list should not return an error');
    const listedTools = Array.isArray(listed.result?.tools) ? listed.result.tools.map((t) => t.name) : [];
    assert(eqSets(listedTools, expectedTools), `tools/list must contain exactly ${expectedTools.length} expected tools: ${expectedTools.join(', ')}`);
    console.log(`✅ tools/list contains expected tools: ${listedTools.join(', ')}`);

    const prepared = await client.sendRequest('tools/call', {
      name: 'airbnb_prepare_context',
      arguments: {
        context: 'Family trip to Austin next Friday through Sunday, 2 adults and 2 kids, under $300/night, must have pool and Wi-Fi, modern quiet place',
      },
    });
    assert(!prepared.error, 'airbnb_prepare_context should not return JSON-RPC error');
    const preparedPayload = parseToolTextPayload(prepared.result);
    assert(preparedPayload?.cache?.key, 'airbnb_prepare_context should return a cache key');
    assert(Array.isArray(preparedPayload?.signals), 'airbnb_prepare_context should return signals array');
    assert(Array.isArray(preparedPayload?.context?.parsed?.tripStyles), 'airbnb_prepare_context should return parsed tripStyles array');
    assert(preparedPayload?.agentGuidance?.readyForNetworkSearch === true, 'prepare_context should return agent guidance readiness');
    console.log(`✅ airbnb_prepare_context returned cache key ${preparedPayload.cache.key}`);

    const compactPrepared = await client.sendRequest('tools/call', {
      name: 'airbnb_prepare_context',
      arguments: {
        context: 'Find a place for me and 2 other people to stay in Chicago 4/25-4/27. 3br modern place with nightlife nearby.',
        agentCompact: true,
        ignoreRobotsText: true,
      },
    });
    assert(!compactPrepared.error, 'compact airbnb_prepare_context should not return JSON-RPC error');
    const compactPreparedPayload = parseToolTextPayload(compactPrepared.result);
    assert(compactPreparedPayload?.cache?.key, 'compact prepare should return cache key');
    assert(compactPreparedPayload?.parsed?.adults === 3, 'compact prepare should infer adults from "me and 2 other people"');
    assert(!('store' in compactPreparedPayload), 'compact prepare should omit full store payload');
    console.log('✅ compact airbnb_prepare_context returns reduced agent payload');

    const search = await client.sendRequest('tools/call', {
      name: 'airbnb_search',
      arguments: {
        contextCacheKey: preparedPayload.cache.key,
        ignoreRobotsText: true,
        maxResults: 1,
      },
    });
    assert(!search.error, 'airbnb_search request should not return JSON-RPC error');
    const searchPayload = parseToolTextPayload(search.result);
    assert(searchPayload && !searchPayload.error, 'airbnb_search should not return tool-level error');
    assert(Array.isArray(searchPayload.results), 'airbnb_search should return results array');
    console.log(`✅ airbnb_search returned ${searchPayload.results.length} result(s)`);

    const reconcile = await client.sendRequest('tools/call', {
      name: 'airbnb_reconcile_results',
      arguments: {
        contextCacheKey: preparedPayload.cache.key,
        results: searchPayload.results,
        maxResults: 1,
        agentCompact: true,
      },
    });
    assert(!reconcile.error, 'airbnb_reconcile_results should not return JSON-RPC error');
    const reconcilePayload = parseToolTextPayload(reconcile.result);
    assert(Array.isArray(reconcilePayload.recommendations), 'reconcile results should return recommendations array');
    assert(reconcilePayload?.contextCache?.key === preparedPayload.cache.key, 'reconcile results should preserve context cache key');
    console.log(`✅ airbnb_reconcile_results returned ${reconcilePayload.recommendations.length} recommendation(s)`);

    await runGroundedSearch(client, 'Chicago, IL', '/s/Chicago--IL/homes', {
      minLat: 41.3,
      maxLat: 42.2,
      minLng: -88.2,
      maxLng: -87.3,
    });
    await runGroundedSearch(client, 'New York, NY', '/s/New-York--NY/homes', {
      minLat: 40.4,
      maxLat: 41.1,
      minLng: -74.4,
      maxLng: -73.3,
    });
    await runGroundedSearch(client, 'Salt Lake City, UT', '/s/Salt-Lake-City--UT/homes', {
      minLat: 40.4,
      maxLat: 40.9,
      minLng: -112.2,
      maxLng: -111.6,
    });

    await runAgentPromptStyle(
      client,
      'find a place for me and 2 other people to stay in chicago 4/25-4/27. 3br modern place for 3 single males hanging out by day and nightlife at night.',
      { location: 'chicago', adults: 3, requiredBedrooms: 3, tripStyles: ['nightlife', 'modern'] },
    );
    await runAgentPromptStyle(
      client,
      'Weekend bachelor-style stay in New York, NY for 3 guys. Need 3 bedrooms, walkable nightlife, April 25 to April 27.',
      { location: 'new york', requiredBedrooms: 3, tripStyles: ['nightlife', 'walkable'] },
    );
    await runAgentPromptStyle(
      client,
      'Looking for a quiet modern remote-work setup in Salt Lake City for me and 1 other person next Friday through Sunday. Dedicated workspace matters.',
      { location: 'salt lake city', adults: 2, tripStyles: ['quiet', 'modern', 'remote-work'] },
    );
    await runAgentPromptStyle(
      client,
      'Need somewhere in Austin for 2 adults and 2 kids, family-friendly with parking and kitchen, under 300/night.',
      { location: 'austin', adults: 2, tripStyles: ['family-friendly'] },
    );

    const invalidTool = await client.sendRequest('tools/call', {
      name: 'airbnb_unknown_tool',
      arguments: {},
    });
    assert(invalidTool.error && invalidTool.error.code === -32601, 'invalid tool call should return -32601');
    console.log('✅ invalid tool returns -32601');

    const contextual = await client.sendRequest('tools/call', {
      name: 'airbnb_search_contextual',
      arguments: {
        location: 'New York, NY',
        context: 'Looking for a romantic weekend in New York next Friday, stay for 2 adults and 1 child under $250 per night with pool and Wi-Fi, avoid elevators, walkable nightlife and modern style',
        requiredBedrooms: 1,
        ignoreRobotsText: true,
        maxResults: 1,
      },
    });
    assert(!contextual.error, 'airbnb_search_contextual should not return JSON-RPC error');
    const contextPayload = parseToolTextPayload(contextual.result);
    assert(contextPayload && Array.isArray(contextPayload.recommendations), 'context tool should return recommendations array');
    assert(Array.isArray(contextPayload.requestedLocationTargets), 'context tool should return requestedLocationTargets array');
    assert(Array.isArray(contextPayload.autoExpandedLocations), 'context tool should return autoExpandedLocations array');
    assert(Array.isArray(contextPayload.searchedLocations), 'context tool should return searchedLocations array');
    assert(Array.isArray(contextPayload?.context?.resolved?.tripStyles), 'context tool should return resolved tripStyles array');
    assert(contextPayload?.agentGuidance?.workflow?.length >= 1, 'context tool should return agent guidance workflow');
    console.log(`✅ airbnb_search_contextual returned ${contextPayload.recommendations.length} recommendation(s)`);

    const compactContextual = await client.sendRequest('tools/call', {
      name: 'airbnb_search_contextual',
      arguments: {
        location: 'Chicago, IL',
        context: 'Need a 3 bedroom modern place for me and 2 other people with nightlife nearby',
        ignoreRobotsText: true,
        agentCompact: true,
        maxResults: 3,
      },
    });
    assert(!compactContextual.error, 'compact contextual search should not return JSON-RPC error');
    const compactContextPayload = parseToolTextPayload(compactContextual.result);
    assert(Array.isArray(compactContextPayload.recommendations), 'compact contextual search should return recommendations');
    assert(Array.isArray(compactContextPayload.topListingIds), 'compact contextual search should return top listing ids');
    assert(compactContextPayload?.resolved?.adults === 3, 'compact contextual search should preserve inferred adults');
    assert(!('searchUrls' in compactContextPayload), 'compact contextual search should omit verbose searchUrls payload');
    console.log('✅ compact airbnb_search_contextual returns reduced agent payload');

    const detailCheck = await client.sendRequest('tools/call', {
      name: 'airbnb_listing_details',
      arguments: {
        id: compactContextPayload.topListingIds[0],
        compact: true,
        ignoreRobotsText: true,
      },
    });
    assert(!detailCheck.error, 'listing details check should not return JSON-RPC error');
    const detailPayload = parseToolTextPayload(detailCheck.result);
    assert(Array.isArray(detailPayload.details), 'listing details should return details array');
    assert(detailPayload.details.some((section) => section && section.id && section.id !== 'UNKNOWN'), 'listing details should preserve real section ids');
    console.log('✅ compact airbnb_listing_details preserves real section ids');
  } catch (error) {
    fail('Protocol smoke sequence failed', error);
  } finally {
    await client.close();
  }

  if (failures > 0) {
    process.exit(1);
  }
})();
NODE
