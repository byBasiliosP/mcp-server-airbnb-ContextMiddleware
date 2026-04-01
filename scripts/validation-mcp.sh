#!/usr/bin/env bash
set -euo pipefail

node --input-type=module <<'NODE'
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

const timeoutMs = Number(process.env.VALIDATION_TIMEOUT_MS || '60000');
const command = process.env.MCP_SERVER_CMD || 'node dist/index.js --ignore-robots-txt';
const cwd = process.env.MCP_SERVER_CWD || process.cwd();
const expectedTools = ['airbnb_search', 'airbnb_listing_details', 'airbnb_search_contextual'];

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

    const search = await client.sendRequest('tools/call', {
      name: 'airbnb_search',
      arguments: {
        location: 'San Francisco, CA',
        ignoreRobotsText: true,
        maxResults: 1,
      },
    });
    assert(!search.error, 'airbnb_search request should not return JSON-RPC error');
    const searchPayload = parseToolTextPayload(search.result);
    assert(searchPayload && !searchPayload.error, 'airbnb_search should not return tool-level error');
    assert(Array.isArray(searchPayload.results), 'airbnb_search should return results array');
    console.log(`✅ airbnb_search returned ${searchPayload.results.length} result(s)`);

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
        context: 'Looking for a romantic weekend in New York next Friday, stay for 2 adults and 1 child under $250 per night with pool and Wi-Fi, avoid elevators',
        ignoreRobotsText: true,
        maxResults: 1,
      },
    });
    assert(!contextual.error, 'airbnb_search_contextual should not return JSON-RPC error');
    const contextPayload = parseToolTextPayload(contextual.result);
    assert(contextPayload && Array.isArray(contextPayload.recommendations), 'context tool should return recommendations array');
    console.log(`✅ airbnb_search_contextual returned ${contextPayload.recommendations.length} recommendation(s)`);
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
