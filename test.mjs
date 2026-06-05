#!/usr/bin/env node
// Exhaustive test suite for the languages container.
//
//   node test.mjs
//
// Env: MCP_URL            (default http://localhost:3000/sse)
//      LANG_BOOTSTRAP_URL (default http://127.0.0.1:8090/bootstrap.js — the
//                          URL the SERVER's runtime fetches the bootstrap from)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient, bootstrapPrelude } from './client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PRELUDE = bootstrapPrelude();

const client = new McpClient();
let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  FAIL ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); }
}

async function run(code, opts) {
  return client.runJs(PRELUDE + code, opts);
}

// Helper: run code that console.logs a single JSON document tagged RESULT:
async function runJson(code, opts) {
  const r = await run(code, opts);
  const m = r.output.match(/RESULT:(.*)$/m);
  return { ...r, json: m ? JSON.parse(m[1]) : null };
}

const suites = {

  // ── MCP protocol ──────────────────────────────────────────────────────
  async protocol() {
    const tools = await client.listTools();
    check('tools/list returns run_js', tools.some((t) => t.name === 'run_js'));
    const r = await client.runJs('console.log("plain", 21 * 2)');
    check('plain run_js works', r.status === 'completed' && r.output.includes('plain 42'), r.output || r.error);
    const ts = await client.runJs('const n: number = 7; console.log("ts", n * 6)');
    check('typescript stripping works', ts.status === 'completed' && ts.output.includes('ts 42'), ts.output || ts.error);
    const err = await client.runJs('throw new Error("expected-boom")');
    check('JS errors reported', err.status === 'failed' && /expected-boom/.test(err.error || err.output), err.error);
  },

  // ── fetch anywhere ────────────────────────────────────────────────────
  async fetch_anywhere() {
    const r = await client.runJs(`
      const a = await fetch('https://example.com/');
      const b = await fetch('https://api.github.com/zen', { headers: { 'user-agent': 'mcp-languages-test' } });
      console.log('a:', a.status, (await a.text()).includes('Example Domain'));
      console.log('b:', b.status);
    `);
    check('fetch example.com allowed', r.output.includes('a: 200 true'), r.output || r.error);
    check('fetch api.github.com allowed (with UA header)', /b: 200/.test(r.output), r.output || r.error);
  },

  // ── bootstrap ─────────────────────────────────────────────────────────
  async bootstrap() {
    const r = await runJson(`console.log('RESULT:' + JSON.stringify(languages()));`);
    check('bootstrap loads', r.status === 'completed', r.error);
    check('all 7 languages in manifest', r.json && Object.keys(r.json.helpers).length === 7, r.output);
    const w = r.json?.wasmModulesPresent || {};
    check('all 4 wasm modules preloaded', w.picat && w.tla && w.minizinc && w.autolisp, JSON.stringify(w));
    check('mermaid loaded without error', !r.json?.loadErrors, JSON.stringify(r.json));
  },

  // ── Picat ─────────────────────────────────────────────────────────────
  async picat() {
    const hello = await runJson(`const r = await picat('main => println("hello picat").'); console.log('RESULT:' + JSON.stringify(r));`);
    check('picat hello world', hello.json?.stdout === 'hello picat\n' && hello.json?.exitCode === 0, hello.output || hello.error);

    const queens = await runJson(`
      const r = await picat(\`
        import cp.
        main =>
          Qs = new_list(8), Qs :: 1..8,
          all_different(Qs),
          all_different([$Qs[I]-I : I in 1..8]),
          all_different([$Qs[I]+I : I in 1..8]),
          solve(Qs), println(Qs).
      \`);
      console.log('RESULT:' + JSON.stringify(r));`);
    check('picat CP 8-queens solves', /\[\d(,\d){7}\]/.test(queens.json?.stdout || ''), queens.json?.stderr || queens.error);

    const sat = await runJson(`
      const r = await picat('import sat. main => X :: 1..100, X*X #= 49, solve([X]), println(x=X).');
      console.log('RESULT:' + JSON.stringify(r));`);
    check('picat SAT (kissat) solves', (sat.json?.stdout || '').includes('x = 7'), sat.json?.stderr || sat.error);

    const quarry = readFileSync(join(here, 'examples', 'turtle_quarry.pi'), 'utf8');
    const plan = await runJson(`
      const r = await picat(${JSON.stringify(quarry)});
      console.log('RESULT:' + JSON.stringify({ ok: r.exitCode === 0, found: r.stdout.includes('Found a safe plan'), mined: r.stdout.includes('31488 blocks mined') }));`,
      { timeoutMs: 300000 });
    check('picat planner: full turtle-quarry plan', plan.json?.ok && plan.json?.found && plan.json?.mined, plan.output || plan.error);

    const bad = await runJson(`const r = await picat('main => this is not valid picat ((('); console.log('RESULT:' + JSON.stringify({ code: r.exitCode, hasErr: r.stderr.length > 0 || r.exitCode !== 0 }));`);
    check('picat syntax error surfaces', bad.json?.hasErr, bad.output || bad.error);
  },

  // ── TLA+ ──────────────────────────────────────────────────────────────
  async tlaplus() {
    const ok = await runJson(`
      const r = await tlaplus(\`---- MODULE Counter ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Next == x' = (x + 1) % 5
TypeOK == x \\\\in 0..4
====

---- CONFIG ----
INIT Init
NEXT Next
INVARIANTS
  TypeOK
====\`);
      console.log('RESULT:' + JSON.stringify({ success: r.success, states: r.states_explored }));`);
    check('tla+ invariant passes', ok.json?.success === true && ok.json?.states === 5, ok.output || ok.error);

    const solve = await runJson(`
      const r = await tlaplus(\`---- MODULE Solve ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Next == x' = x + 1
NotSeven == x # 7
====

---- CONFIG ----
INIT Init
NEXT Next
INVARIANTS
  NotSeven
====\`, { max_depth: 20 });
      console.log('RESULT:' + JSON.stringify({ success: r.success, type: r.error_type, traceLen: (r.trace || []).length }));`);
    check('tla+ finds invariant violation with trace', solve.json?.success === false && solve.json?.traceLen > 0, solve.output || solve.error);
  },

  // ── MiniZinc ──────────────────────────────────────────────────────────
  async minizinc() {
    const sat = await runJson(`
      const r = await minizinc('var 1..10: x; var 1..10: y; constraint x + y == 12; constraint x - y == 2; solve satisfy;');
      console.log('RESULT:' + JSON.stringify(r));`, { timeoutMs: 300000 });
    check('minizinc satisfy solves', sat.json?.status === 'SATISFIED' && sat.json?.solutions?.[0]?.x === 7 && sat.json?.solutions?.[0]?.y === 5, sat.output || sat.error);

    const opt = await runJson(`
      const r = await minizinc('var 0..50: x; constraint x mod 7 == 3; solve maximize x;');
      const last = r.solutions[r.solutions.length - 1];
      console.log('RESULT:' + JSON.stringify({ status: r.status, x: last && last.x }));`, { timeoutMs: 300000 });
    check('minizinc optimization finds max', opt.json?.x === 45, opt.output || opt.error);

    const unsat = await runJson(`
      const r = await minizinc('var 1..3: x; constraint x > 5; solve satisfy;');
      console.log('RESULT:' + JSON.stringify({ status: r.status, n: r.solutions.length }));`, { timeoutMs: 300000 });
    check('minizinc unsat detected', unsat.json?.status === 'UNSATISFIABLE' && unsat.json?.n === 0, unsat.output || unsat.error);

    const bad = await runJson(`
      const r = await minizinc('var 1..3: x; this is not minizinc;;; solve satisfy;');
      console.log('RESULT:' + JSON.stringify({ code: r.exitCode, hasErr: r.stderr.length > 0 || r.exitCode !== 0 }));`, { timeoutMs: 300000 });
    check('minizinc syntax error surfaces', bad.json?.hasErr, bad.output || bad.error);
  },

  // ── AutoLISP ──────────────────────────────────────────────────────────
  async autolisp() {
    const r = await runJson(`
      const a = await autolisp('(progn (command "CIRCLE" (list 0 0) 10) (command "LINE" (list -5 -5) (list 5 5)) (princ "two entities"))');
      console.log('RESULT:' + JSON.stringify({ output: a.output, svg: a.svg.includes('<svg'), circle: a.svg.includes('circle') || a.svg.includes('ellipse'), line: a.svg.includes('line') || a.svg.includes('path') }));`);
    check('autolisp draws SVG entities', r.json?.svg && r.json?.circle && r.json?.line, r.output || r.error);
    check('autolisp princ output captured', r.json?.output === 'two entities', r.output || r.error);

    const arith = await runJson(`
      const a = await autolisp('(+ 1 2 3)');
      console.log('RESULT:' + JSON.stringify(a.result));`);
    check('autolisp evaluates arithmetic', String(arith.json).includes('6'), arith.output || arith.error);
  },

  // ── JSX ───────────────────────────────────────────────────────────────
  async jsx() {
    const r = await runJson(`
      const out = jsx('const App = () => <ul>{[1,2,3].map(n => <li key={n}>{n * 2}</li>)}</ul>; App');
      console.log('RESULT:' + JSON.stringify(out));`);
    check('jsx renders component to HTML', r.json?.html === '<ul><li>2</li><li>4</li><li>6</li></ul>', r.output || r.error);

    const props = await runJson(`
      const out = jsx('export default function Greet({name}) { return <h1>Hi {name}!</h1>; }', { name: 'MCP' });
      console.log('RESULT:' + JSON.stringify(out));`);
    check('jsx export default + props', props.json?.html === '<h1>Hi MCP!</h1>', props.output || props.error);
  },

  // ── Markdown ──────────────────────────────────────────────────────────
  async markdown() {
    const r = await runJson(`
      const out = markdown('# Title\\n\\n| a | b |\\n|---|---|\\n| 1 | 2 |\\n\\n- [x] done');
      console.log('RESULT:' + JSON.stringify(out));`);
    check('markdown heading', (r.json?.html || '').includes('<h1>Title</h1>'), r.output || r.error);
    check('markdown gfm table', (r.json?.html || '').includes('<table>'), r.output || r.error);
  },

  // ── Mermaid ───────────────────────────────────────────────────────────
  async mermaid() {
    const r = await runJson(`
      const flow = await mermaid_parse('graph TD; A-->B; B-->C;');
      const seq = await mermaid_parse('sequenceDiagram\\n  Alice->>Bob: hello\\n  Bob-->>Alice: hi');
      const bad = await mermaid_parse('graph TD; A--->>>nonsense<<');
      console.log('RESULT:' + JSON.stringify({ flow, seq, bad }));`);
    check('mermaid flowchart parses', r.json?.flow?.valid === true, r.output || r.error);
    check('mermaid sequence diagram parses', r.json?.seq?.valid === true, r.output || r.error);
    check('mermaid invalid diagram rejected with parse error', r.json?.bad?.valid === false && /Parse error/.test(r.json?.bad?.error || ''), r.output || r.error);
  },

  // ── concurrency ───────────────────────────────────────────────────────
  async concurrency() {
    const jobs = [1, 2, 3].map((n) =>
      run(`const r = await picat('main => println(${n} * 111).'); console.log('OUT:' + r.stdout.trim());`));
    const rs = await Promise.all(jobs);
    const got = rs.map((r) => (r.output.match(/OUT:(\d+)/) || [])[1]).sort();
    check('3 concurrent picat runs', JSON.stringify(got) === JSON.stringify(['111', '222', '333']),
      JSON.stringify(rs.map((r) => ({ s: r.status, e: r.error }))));
  },
};

const only = process.argv[2];
console.log(`MCP: ${client.url}`);
await client.initialize();
console.log(`server: ${JSON.stringify(client.serverInfo)}\n`);
for (const [name, fn] of Object.entries(suites)) {
  if (only && name !== only) continue;
  console.log(`${name}:`);
  try { await fn(); } catch (e) { fail++; failures.push({ name, detail: String(e) }); console.log(`  FAIL ${name} (suite threw) — ${e}`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('failures:');
  for (const f of failures) console.log(` - ${f.name}: ${String(f.detail).slice(0, 500)}`);
}
client.close();
process.exit(fail ? 1 : 0);
