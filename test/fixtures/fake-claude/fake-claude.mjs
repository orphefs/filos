#!/usr/bin/env node
// A fake `claude` CLI for tests: same flags and output shapes as the real one (print mode,
// json / stream-json), with behaviour chosen by FAKE_CLAUDE_MODE. It answers the comprehension
// pass (a review graph) and the small Filos tasks, told apart by the "Filos task: <task>" line at
// the top of --append-system-prompt. See README.md next to this file.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const MODES = ['ok', 'auth', 'contract', 'slow', 'budget', 'crash', 'fenced', 'badtools'];
const TASKS = ['questions', 'evaluate', 'draftComments', 'thread'];
const argv = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message, code = 1) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

/** FAKE_CLAUDE_MODE_<TASK> beats FAKE_CLAUDE_MODE_FILE (read on every run) beats FAKE_CLAUDE_MODE. */
function modeFor(task) {
  const perTask = task ? env[`FAKE_CLAUDE_MODE_${task.toUpperCase()}`] : undefined;
  if (perTask) return perTask.trim();
  if (env.FAKE_CLAUDE_MODE_FILE && existsSync(env.FAKE_CLAUDE_MODE_FILE)) {
    const fromFile = readFileSync(env.FAKE_CLAUDE_MODE_FILE, 'utf8').trim();
    if (fromFile) return fromFile;
  }
  return env.FAKE_CLAUDE_MODE || 'ok';
}

function checkMode(m) {
  if (!MODES.includes(m)) fail(`fake-claude: unknown mode "${m}" (expected ${MODES.join(' | ')})`, 64);
  return m;
}

// --- subcommands -------------------------------------------------------------------------------
if (argv[0] === '--version' || argv[0] === '-v') {
  console.log('0.0.0-fake (Claude Code)');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  const loggedIn = checkMode(modeFor()) !== 'auth';
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

// "--tools=" (empty) disables every built-in tool, as with the real CLI.
const tools = flags['--tools'] === undefined ? ['Bash', 'Edit', 'Read', 'Write', 'Grep', 'Glob'] : flags['--tools'].split(/[,\s]+/).filter(Boolean);

// Which job this is: a Filos task named on the first line of the appended system prompt, or the comprehension pass.
const marker = /^Filos task: (\S+)/.exec(flags['--append-system-prompt'] ?? '');
const task = marker ? marker[1] : 'comprehend';
if (marker && !TASKS.includes(task)) fail(`fake-claude: unknown Filos task "${task}" (expected ${TASKS.join(' | ')})`, 64);
const mode = checkMode(modeFor(marker ? task : undefined));

if (env.FAKE_CLAUDE_RECORD) {
  writeFileSync(
    env.FAKE_CLAUDE_RECORD,
    JSON.stringify(
      {
        argv,
        cwd: process.cwd(),
        flags,
        task,
        tools,
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

// --- answers per task --------------------------------------------------------------------------
const readJson = (file) => JSON.parse(readFileSync(resolve(file), 'utf8'));

function loadGraph() {
  return readJson(env.FAKE_CLAUDE_GRAPH || join(here, 'graph.json'));
}

/** The text of a <<<NAME id>>> … <<<END NAME id>>> block in the prompt, or ''. */
function block(name) {
  const m = new RegExp(`<<<${name} ([0-9a-f]+)>>>\\n([\\s\\S]*?)\\n<<<END ${name} \\1>>>`).exec(prompt);
  return m ? m[2] : '';
}

/** Graph nodes as listed in the prompt's GRAPH block: id, kind, change, and the first anchor. */
function promptNodes() {
  const nodes = [];
  for (const line of block('GRAPH').split('\n')) {
    const head = /^- (\S+) \| (\w+) \| (\w+)/.exec(line);
    if (head) nodes.push({ id: head[1], kind: head[2], change: head[3] });
    const code = /^ {2}code: ([^:,\s]+):(\d+)-(\d+)/.exec(line);
    if (code && nodes.length && !nodes[nodes.length - 1].anchor) nodes[nodes.length - 1].anchor = { file: code[1], line: Number(code[2]) };
  }
  return nodes;
}

/** The canned set if the prompt's graph is the fixture graph; otherwise one predict question per changed module. */
function questionSet() {
  if (env.FAKE_CLAUDE_QUESTIONS) return readJson(env.FAKE_CLAUDE_QUESTIONS);
  const canned = readJson(join(here, 'questions.json'));
  const nodes = promptNodes();
  const ids = new Set(nodes.map((n) => n.id));
  if (canned.questions.every((q) => ids.has(q.nodeId))) return canned;
  const modules = nodes.filter((n) => n.kind === 'module' && n.change !== 'context');
  return {
    contractVersion: '0.1',
    depth: { proposed: 'standard', why: `fake-claude: ${modules.length} changed module${modules.length === 1 ? '' : 's'}.` },
    questions: (modules.length ? modules : nodes.slice(0, 1)).map((n) => ({
      id: `q-${n.id.replace(/[^\w-]+/g, '-')}-predict`,
      nodeId: n.id,
      stage: 'predict',
      purpose: 'understand',
      depth: 'skim',
      prompt: `What do you expect the change in ${n.id} to affect?`,
      choices: [
        { id: 'a', text: 'Only its own module.', correct: false, explain: 'fake-claude: callers see the change too.' },
        { id: 'b', text: 'Its callers as well.', correct: true, explain: 'fake-claude: the behaviour change reaches every caller.' },
      ],
      hint: 'Who calls into it?',
    })),
  };
}

function evaluation() {
  if (env.FAKE_CLAUDE_EVALUATE) return readJson(env.FAKE_CLAUDE_EVALUATE);
  const answer = block('ANSWER');
  const attempt = Number(/This is attempt (\d+)/.exec(prompt)?.[1] ?? 1);
  if (/half-even/i.test(answer)) {
    return { verdict: 'correct', reply: 'Yes: exact ties now go to the even cent. Keep in mind that every caller that rounds a total inherits this.' };
  }
  const out =
    attempt <= 1
      ? { verdict: 'incorrect', reply: 'Not quite. Look at the branch that only runs on an exact tie: what does it return when the floor is odd?' }
      : { verdict: 'incorrect', reply: 'Ties now round half-even: line 11 returns the even neighbour, so 2.345 becomes 2.34 rather than 2.35.' };
  // An answer that spots a missing test proposes a comment, as the real task may.
  if (/untested|no test/i.test(answer)) {
    out.comment = { file: 'money/round.ts', line: 10, body: 'Exact half-cent ties have no test. Could you add one (2.345 -> 2.34)?', severity: 'suggestion' };
  }
  return out;
}

function draftedComments() {
  if (env.FAKE_CLAUDE_DRAFT_COMMENTS) return readJson(env.FAKE_CLAUDE_DRAFT_COMMENTS);
  const target = promptNodes().find((n) => n.anchor && n.change !== 'context') ?? promptNodes().find((n) => n.anchor);
  return {
    comments: [
      {
        ...(target ? { nodeId: target.id, file: target.anchor.file, line: target.anchor.line } : {}),
        body: 'This changes results for existing callers. Could you call it out in the PR description and add a test that pins the new behaviour?',
        severity: 'suggestion',
      },
    ],
  };
}

function threadAnswer() {
  if (env.FAKE_CLAUDE_THREAD) return readJson(env.FAKE_CLAUDE_THREAD);
  return {
    reply: 'Agreed. Naming a concrete input makes the request easy to act on; here is a tighter version.',
    proposal: 'Could you add a test for an exact half-cent tie, for example 2.345 -> 2.34? It is the one input whose result this PR changes.',
  };
}

/** A deliberately broken answer for the task: the provider must reject it as a contract failure. */
function brokenAnswer() {
  switch (task) {
    case 'questions':
      return { contractVersion: '0.1', depth: { proposed: 'standard', why: 'x' }, questions: [{ id: 'q1', nodeId: 'no/such-node', stage: 'predict', purpose: 'understand', depth: 'skim', prompt: 'Where?' }] };
    case 'evaluate':
      return { verdict: 'maybe', reply: '' };
    case 'draftComments':
      return { comments: 'none' };
    case 'thread':
      return { proposal: 'A proposal without a reply.' };
    default: {
      const g = loadGraph();
      g.edges.push({ from: g.nodes[0].id, to: 'money/ceilToCents', kind: 'calls' });
      const anchored = g.nodes.find((n) => n.anchors.length);
      if (anchored) anchored.anchors[0].endLine = 4000;
      return g;
    }
  }
}

function answer() {
  switch (task) {
    case 'questions':
      return questionSet();
    case 'evaluate':
      return evaluation();
    case 'draftComments':
      return draftedComments();
    case 'thread':
      return threadAnswer();
    default:
      return loadGraph();
  }
}

// --- output ------------------------------------------------------------------------------------
const model = flags['--model'] ? `claude-fake-${flags['--model']}` : 'claude-fake-default';
const sessionId = '00000000-0000-4000-8000-000000000000';
const started = Date.now();

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
    total_cost_usd: task === 'comprehend' ? 0.0123 : 0.0042,
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

/** Tool calls first (only those the run was given), then the structured answer. */
function success(payload) {
  const firstFile = task === 'comprehend' ? (payload.files?.[0]?.path ?? 'README.md') : (promptNodes().find((n) => n.anchor)?.anchor.file ?? 'README.md');
  const calls = [];
  if (tools.includes('Read')) {
    calls.push(
      toolUse('Read', { file_path: join(process.cwd(), firstFile) }),
      { type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_Read', content: '1\t// file contents elided by fake-claude' }] } },
    );
  }
  if (tools.includes('Grep')) calls.push(toolUse('Grep', { pattern: 'roundToCents', output_mode: 'count' }));
  return [
    init(tools),
    ...calls,
    // The real CLI emits these (empty) while the model thinks before answering.
    { type: 'system', subtype: 'thinking_tokens', session_id: sessionId },
    { type: 'system', subtype: 'thinking_tokens', session_id: sessionId },
    toolUse('StructuredOutput', payload),
    result(schema ? { structured_output: payload } : { result: JSON.stringify(payload) }),
  ];
}

switch (mode) {
  case 'ok':
    emit(success(answer()));
    break;

  case 'fenced': {
    // No structured_output: the answer only appears as fenced JSON in the text.
    const what = task === 'comprehend' ? 'the review graph' : 'my answer';
    emit([init(tools), result({ structured_output: null, result: `Here is ${what}:\n\n\`\`\`json\n` + JSON.stringify(answer(), null, 2) + '\n```\n' })]);
    break;
  }

  case 'contract':
    emit(success(brokenAnswer()));
    break;

  case 'slow': {
    // A helper process in our process group, like the tool processes a real agent starts.
    // It shares stdout, so the caller only sees "close" once the whole tree is gone.
    const delay = Number(env.FAKE_CLAUDE_DELAY_MS || 60000);
    const helper = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${delay})`], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (env.FAKE_CLAUDE_PIDFILE) writeFileSync(env.FAKE_CLAUDE_PIDFILE, JSON.stringify({ cli: process.pid, helper: helper.pid }));
    if (format === 'stream-json') process.stdout.write(JSON.stringify(init(tools)) + '\n');
    await sleep(delay);
    emit(success(answer()).slice(1));
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
    const work = tools.includes('Read') ? [toolUse('Read', { file_path: join(process.cwd(), 'money/round.ts') })] : [];
    emit([init(tools), ...work, result({ subtype: 'error_max_budget_usd', is_error: true, result: undefined, errors: [`Reached maximum budget ($${cap})`], terminal_reason: 'max_budget', total_cost_usd: Number(cap) || 0.5 })], 1);
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
    emit(success(answer()).slice(1));
    break;
  }
}
