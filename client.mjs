#!/usr/bin/env node
// Light MCP client for mcp-v8's Streamable HTTP transport.
// No dependencies — node >= 18.
//
// Transport notes (rmcp 0.1.5, as bundled in mcp-v8 v0.11.0):
//   - POST initialize           -> response inline on the POST body (SSE-framed)
//   - POST other requests       -> 200/202 with empty body
//   - responses + notifications -> delivered on a standing GET SSE stream
//     opened with the mcp-session-id header
//
// Library:
//   import { McpClient } from './client.mjs';
//   const c = new McpClient('http://localhost:3000/mcp');
//   await c.initialize();
//   const tools = await c.listTools();
//   const { output } = await c.runJs('console.log(1 + 1)');
//   c.close();
//
// CLI:
//   node client.mjs tools                      # list tool names
//   node client.mjs run 'console.log(42)'      # run code, print output
//   node client.mjs run-file ./script.js       # run a file
//   echo 'console.log(1)' | node client.mjs run -
// Env: MCP_URL (default http://localhost:3000/mcp)
//      LANG_BOOTSTRAP_URL — when set, `run` prepends a loader that fetches
//      and evals the languages bootstrap (use http://127.0.0.1:8090/bootstrap.js
//      for the docker image; the URL is fetched BY THE SERVER's runtime).

import { readFileSync } from 'node:fs';

function parseSseFrames(buf, onData) {
  // returns unconsumed remainder
  let idx;
  while ((idx = buf.indexOf('\n\n')) !== -1) {
    const frame = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    for (const line of frame.split('\n')) {
      if (line.startsWith('data:')) onData(line.slice(5).trim());
    }
  }
  return buf;
}

export class McpClient {
  constructor(url = process.env.MCP_URL || 'http://localhost:3000/mcp') {
    this.url = url;
    this.sessionId = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.streamAbort = null;
    this.notifications = [];
  }

  #headers(extra = {}) {
    const h = {
      accept: 'application/json, text/event-stream',
      ...extra,
    };
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    return h;
  }

  #dispatch(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
      else resolve(msg.result);
    } else if (msg.method) {
      this.notifications.push(msg);
    }
  }

  /** Standing GET stream: server delivers responses + notifications here. */
  async #openStream() {
    this.streamAbort = new AbortController();
    const resp = await fetch(this.url, {
      method: 'GET',
      headers: this.#headers({ accept: 'text/event-stream' }),
      signal: this.streamAbort.signal,
    });
    if (!resp.ok) throw new Error(`GET stream -> HTTP ${resp.status}: ${await resp.text()}`);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          buf = parseSseFrames(buf, (d) => this.#dispatch(d));
        }
      } catch (e) {
        if (e.name !== 'AbortError') {
          for (const { reject } of this.pending.values()) reject(e);
          this.pending.clear();
        }
      }
    })();
  }

  /** POST a JSON-RPC message; resolve from inline body or the GET stream. */
  async rpc(method, params, { notification = false, timeoutMs = 600000 } = {}) {
    const body = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
    if (!notification) body.id = this.nextId++;

    let settle;
    if (!notification) {
      settle = new Promise((resolve, reject) => {
        this.pending.set(body.id, { resolve, reject });
        setTimeout(() => {
          if (this.pending.has(body.id)) {
            this.pending.delete(body.id);
            reject(new Error(`timeout waiting for response to ${method} (id ${body.id})`));
          }
        }, timeoutMs).unref?.();
      });
    }

    const resp = await fetch(this.url, {
      method: 'POST',
      headers: this.#headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    });
    const sid = resp.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (!resp.ok && resp.status !== 202) {
      if (!notification) this.pending.delete(body.id);
      throw new Error(`${method} -> HTTP ${resp.status}: ${await resp.text()}`);
    }

    // Inline body (initialize does this): SSE-framed or plain JSON.
    const ctype = resp.headers.get('content-type') || '';
    if (ctype.includes('text/event-stream')) {
      const text = await resp.text();
      parseSseFrames(text.endsWith('\n\n') ? text : text + '\n\n', (d) => this.#dispatch(d));
    } else if (ctype.includes('application/json')) {
      const text = await resp.text();
      if (text.trim()) this.#dispatch(text);
    }

    return notification ? null : settle;
  }

  async initialize() {
    const result = await this.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'languages-light-client', version: '1.0.0' },
    });
    await this.rpc('notifications/initialized', undefined, { notification: true });
    await this.#openStream();
    this.serverInfo = result.serverInfo;
    return result;
  }

  close() {
    if (this.streamAbort) this.streamAbort.abort();
  }

  async listTools() {
    const result = await this.rpc('tools/list', {});
    return result.tools;
  }

  /** Call a tool; returns parsed JSON from the joined text content when possible. */
  async callTool(name, args = {}, opts = {}) {
    const result = await this.rpc('tools/call', { name, arguments: args }, opts);
    const texts = (result.content || [])
      .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
      .filter(Boolean);
    const joined = texts.join('\n');
    try { return { parsed: JSON.parse(joined), raw: joined, isError: !!result.isError }; }
    catch { return { parsed: null, raw: joined, isError: !!result.isError }; }
  }

  /**
   * Run JS. Handles both server shapes:
   *  - stateless MCP service: run_js is synchronous, returns {output}
   *  - stateful/async service: run_js returns {execution_id}; poll get_execution
   */
  async runJs(code, { pollMs = 250, timeoutMs = 300000 } = {}) {
    const submit = await this.callTool('run_js', { code }, { timeoutMs });
    if (submit.parsed && submit.parsed.output !== undefined && submit.parsed.execution_id === undefined) {
      // synchronous shape
      const failed = submit.isError || Boolean(submit.parsed.error);
      return {
        executionId: null,
        status: failed ? 'failed' : 'completed',
        error: submit.parsed.error ?? null,
        result: null,
        output: submit.parsed.output ?? '',
      };
    }
    if (submit.isError && !submit.parsed?.execution_id) {
      return { executionId: null, status: 'failed', error: submit.raw, result: null, output: '' };
    }
    const executionId = submit.parsed?.execution_id;
    if (!executionId || executionId.startsWith('error:')) {
      throw new Error('run_js submit failed: ' + submit.raw);
    }
    const t0 = Date.now();
    let info;
    for (;;) {
      const res = await this.callTool('get_execution', { execution_id: executionId });
      info = res.parsed;
      if (info && info.status && info.status !== 'running' && info.status !== 'pending') break;
      if (Date.now() - t0 > timeoutMs) throw new Error('timeout polling execution ' + executionId);
      await new Promise((r) => setTimeout(r, pollMs));
    }
    let output = '';
    try {
      const out = await this.callTool('get_execution_output', { execution_id: executionId });
      output = out.parsed?.data ?? out.raw ?? '';
    } catch { /* output may be empty */ }
    return { executionId, status: info.status, error: info.error ?? null, result: info.result ?? null, output };
  }
}

/**
 * Loader prelude: makes the seven language helpers available in a run.
 * The location may be an http(s) URL (fetched by the SERVER's runtime) or a
 * file path read through the policy-gated fs module. Default: the path baked
 * into the docker image.
 */
export function bootstrapPrelude(loc = process.env.LANG_BOOTSTRAP_URL || '/opt/languages/bootstrap.js') {
  if (/^https?:/.test(loc)) {
    return `const __boot = await fetch(${JSON.stringify(loc)});
if (!__boot.ok) throw new Error('bootstrap fetch failed: HTTP ' + __boot.status);
(0, eval)(await __boot.text());
`;
  }
  return `(0, eval)(await fs.readFile(${JSON.stringify(loc)}));
`;
}

// ── CLI ────────────────────────────────────────────────────────────────────
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  const [cmd, ...rest] = process.argv.slice(2);
  const client = new McpClient();
  const main = async () => {
    await client.initialize();
    if (cmd === 'tools') {
      const tools = await client.listTools();
      for (const t of tools) console.log(t.name);
    } else if (cmd === 'run' || cmd === 'run-file') {
      let code = cmd === 'run-file' ? readFileSync(rest[0], 'utf8')
        : rest[0] === '-' ? readFileSync(0, 'utf8') : rest[0];
      if (process.env.LANG_BOOTSTRAP_URL) code = bootstrapPrelude() + code;
      const r = await client.runJs(code);
      if (r.output) process.stdout.write(r.output.endsWith('\n') ? r.output : r.output + '\n');
      if (r.status !== 'completed') {
        console.error(`status: ${r.status}${r.error ? '\nerror: ' + r.error : ''}`);
        process.exitCode = 1;
      }
    } else {
      console.error('usage: client.mjs tools | run <code|-> | run-file <path>');
      process.exitCode = 2;
    }
    client.close();
  };
  main().catch((e) => { console.error(String(e)); process.exit(1); });
}
