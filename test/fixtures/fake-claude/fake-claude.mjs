#!/usr/bin/env node
// A fake `claude` CLI for tests: same flags and output shapes as the real one (print mode,
// json / stream-json), with behaviour chosen by FAKE_CLAUDE_MODE. See README.md next to this file.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const mode = env.FAKE_CLAUDE_MODE || 'ok';
const MODES = ['ok', 'auth', 'contract', 'slow', 'budget', 'crash', 'fenced', 'badtools'];
const argv = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message, code = 1) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

if (!MODES.includes(mode)) fail(`fake-claude: unknown FAKE_CLAUDE_MODE "${mode}" (expected ${MODES.join(' | ')})`, 64);

// --- subcommands -------------------------------------------------------------------------------
if (argv[0] === '--version' || argv[0] === '-v') {
  console.log('0.0.0-fake (Claude Code)');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  const loggedIn = mode !== 'auth';
  console.log(JSON.stringify(loggedIn ? { loggedIn, authMethod: 'claude.ai', apiProvider: 'firstParty' } : { loggedIn, authMethod: 'none', apiProvider: 'firstParty' }, null, 2));
  process.exit(loggedIn ? 0 : 1);
}
if (argv[0] === 'auth' && argv[1] === 'login') {
  console.log('fake-claude: pretend login succeeded');
  process.exit(0);
}

// --- print mode argument parsing (strict, so typos in our args fail loudly) ----------------------
const VALUE_FLAGS = new Set([
  '--output-format', '--json-schema', '--append-system-prompt', '--system-prompt', '--tools', '--permission-mode',
  '--setting-sources', '--max-budget-usd', '--model', '--add-dir', '--input-format', '--effort', '--fallback-model',
  '--settings', '--mcp-config', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools',
]);
const BOOL_FLAGS = new Set([
  '-p', '--print', '--verbose', '--strict-mcp-config', '--no-session-persistence', '--restricted', '--bare',
  '--include-partial-messages', '--dangerously-skip-permissions', '--disable-slash-commands',
]);

const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') {
    positional.push(...argv.slice(i + 1));
    break;
  }
  const eq = a.startsWith('--') ? a.indexOf('=') : -1;
  const name = eq > 0 ? a.slice(0, eq) : a;
  if (VALUE_FLAGS.has(name)) {
    const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (value === undefined) fail(`error: option '${name} <value>' argument missing`);
    flags[name] = value;
  } else if (BOOL_FLAGS.has(name)) {
    flags[name] = true;
  } else if (a.startsWith('-')) {
    fail(`error: unknown option '${a}'`);
  } else {
    positional.push(a);
  }
}

if (!flags['-p'] && !flags['--print']) fail('fake-claude: only print mode (-p) is supported');
const format = flags['--output-format'] || 'text';
if (!['text', 'json', 'stream-json'].includes(format)) fail(`error: option '--output-format <format>' argument '${format}' is invalid.`);
if (format === 'stream-json' && !flags['--verbose']) fail('Error: When using --print, --output-format=stream-json requires --verbose');
let schema;
if (flags['--json-schema'] !== undefined) {
  try {
    schema = JSON.parse(flags['--json-schema']);
  } catch {
    fail('Error: --json-schema must be valid JSON');
  }
}

let stdin = '';
if (!positional.length && !process.stdin.isTTY) {
  for await (const chunk of process.stdin) stdin += chunk;
}
const prompt = positional.length ? positional.join(' ') : stdin;
if (!prompt.trim()) fail('Error: Input must be provided either through stdin or as a prompt argument when using --print');

const tools = flags['--tools'] === undefined ? ['Bash', 'Edit', 'Read', 'Write', 'Grep', 'Glob'] : flags['--tools'].split(/[,\s]+/).filter(Boolean);

if (env.FAKE_CLAUDE_RECORD) {
  writeFileSync(
    env.FAKE_CLAUDE_RECORD,
    JSON.stringify(
      {
        argv,
        cwd: process.cwd(),
        flags,
        promptVia: positional.length ? 'argv' : 'stdin',
        prompt,
        schema,
        // Which parent-session variables reached us (the provider should strip them).
        claudeEnv: Object.keys(env).filter((k) => /^CLAUDE/.test(k)),
      },
      null,
      2,
    ),
  );
}

// --- behaviour ---------------------------------------------------------------------------------
const model = flags['--model'] ? `claude-fake-${flags['--model']}` : 'claude-fake-default';
const sessionId = '00000000-0000-4000-8000-000000000000';
const started = Date.now();

function loadGraph() {
  const file = env.FAKE_CLAUDE_GRAPH ? resolve(env.FAKE_CLAUDE_GRAPH) : join(here, 'graph.json');
  return JSON.parse(readFileSync(file, 'utf8'));
}

function brokenGraph() {
  const g = loadGraph();
  g.edges.push({ from: g.nodes[0].id, to: 'money/ceilToCents', kind: 'calls' });
  const anchored = g.nodes.find((n) => n.anchors.length);
  if (anchored) anchored.anchors[0].endLine = 4000;
  return g;
}

const init = (toolList) => ({
  type: 'system',
  subtype: 'init',
  cwd: process.cwd(),
  session_id: sessionId,
  tools: schema ? [...toolList, 'StructuredOutput'] : toolList,
  mcp_servers: [],
  model,
  permissionMode: flags['--permission-mode'] || 'default',
  apiKeySource: 'none',
});

function toolUse(name, input) {
  return { type: 'assistant', session_id: sessionId, message: { role: 'assistant', model, content: [{ type: 'tool_use', id: `toolu_${name}`, name, input }] } };
}

function result(fields) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: Date.now() - started,
    duration_api_ms: Date.now() - started,
    num_turns: 3,
    result: '',
    session_id: sessionId,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 1000, output_tokens: 500 },
    modelUsage: { [model]: { inputTokens: 1000, outputTokens: 500, costUSD: 0.0123 } },
    terminal_reason: 'completed',
    ...fields,
  };
}

function emit(messages, exitCode = 0) {
  const final = messages[messages.length - 1];
  if (format === 'stream-json') for (const m of messages) process.stdout.write(JSON.stringify(m) + '\n');
  else if (format === 'json') process.stdout.write(JSON.stringify(final) + '\n');
  else process.stdout.write((final.result ?? '') + '\n');
  process.exitCode = exitCode;
}

function success(graph) {
  const firstFile = graph.files?.[0]?.path ?? 'README.md';
  return [
    init(tools),
    toolUse('Read', { file_path: join(process.cwd(), firstFile) }),
    { type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_Read', content: '1\t// file contents elided by fake-claude' }] } },
    toolUse('Grep', { pattern: 'roundToCents', output_mode: 'count' }),
    // The real CLI emits these (empty) while the model thinks before answering.
    { type: 'system', subtype: 'thinking_tokens', session_id: sessionId },
    { type: 'system', subtype: 'thinking_tokens', session_id: sessionId },
    toolUse('StructuredOutput', graph),
    result(schema ? { structured_output: graph } : { result: JSON.stringify(graph) }),
  ];
}

switch (mode) {
  case 'ok':
    emit(success(loadGraph()));
    break;

  case 'fenced': {
    // No structured_output: the graph only appears as fenced JSON in the text answer.
    const graph = loadGraph();
    emit([init(tools), result({ structured_output: null, result: 'Here is the review graph:\n\n```json\n' + JSON.stringify(graph, null, 2) + '\n```\n' })]);
    break;
  }

  case 'contract':
    emit(success(brokenGraph()));
    break;

  case 'slow': {
    // A helper process in our process group, like the tool processes a real agent starts.
    // It shares stdout, so the caller only sees "close" once the whole tree is gone.
    const delay = Number(env.FAKE_CLAUDE_DELAY_MS || 60000);
    const helper = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${delay})`], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (env.FAKE_CLAUDE_PIDFILE) writeFileSync(env.FAKE_CLAUDE_PIDFILE, JSON.stringify({ cli: process.pid, helper: helper.pid }));
    if (format === 'stream-json') process.stdout.write(JSON.stringify(init(tools)) + '\n');
    await sleep(delay);
    emit(success(loadGraph()).slice(1));
    break;
  }

  case 'auth': {
    const message =
      env.FAKE_CLAUDE_MESSAGE ||
      'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again';
    emit([init(tools), result({ is_error: true, terminal_reason: 'api_error', result: message, structured_output: null, total_cost_usd: 0 })], 1);
    break;
  }

  case 'budget': {
    const cap = flags['--max-budget-usd'] ?? '?';
    emit([init(tools), toolUse('Read', { file_path: join(process.cwd(), 'money/round.ts') }), result({ subtype: 'error_max_budget_usd', is_error: true, result: undefined, errors: [`Reached maximum budget ($${cap})`], terminal_reason: 'max_budget', total_cost_usd: Number(cap) || 0.5 })], 1);
    break;
  }

  case 'crash':
    process.stderr.write(`${env.FAKE_CLAUDE_MESSAGE || 'TypeError: Cannot read properties of undefined (reading \'content\')'}\n    at fakeClaude (fake-claude.mjs:1:1)\n`);
    process.exitCode = 3;
    break;

  case 'badtools': {
    // A CLI that ignored --tools: offers Bash and file writes. Waits, so a careful caller can stop it first.
    if (format === 'stream-json') process.stdout.write(JSON.stringify(init([...tools, 'Bash', 'Edit', 'Write'])) + '\n');
    await sleep(Number(env.FAKE_CLAUDE_DELAY_MS || 5000));
    emit(success(loadGraph()).slice(1));
    break;
  }
}
