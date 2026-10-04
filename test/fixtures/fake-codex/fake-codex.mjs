#!/usr/bin/env node
// A fake `codex` CLI for tests: the same `exec` flags (parsed strictly, as clap does) and the same
// `--json` event stream as codex-cli 0.160.0, with behaviour chosen by FAKE_CODEX_MODE. It answers
// the comprehension pass (a review graph) and the small Filos tasks, told apart by the
// "Filos task: <task>" line at the top of the prompt on stdin. See README.md next to this file.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const claudeFixtures = join(here, '..', 'fake-claude');
const env = process.env;
const MODES = ['ok', 'fenced', 'contract', 'auth', 'model', 'quota', 'slow', 'crash', 'badtools', 'empty'];
const TASKS = ['questions', 'evaluate', 'draftComments', 'thread'];
const argv = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The real error codex-cli 0.160.0 printed for a model a ChatGPT account can't use (live smoke, 2026-10-04). */
export const MODEL_ERROR =
  '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.3-codex\' model is not supported when using Codex with a ChatGPT account."}}';
const QUOTA_ERROR =
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:12 PM.";
/** What codex-cli 0.160.0 printed for a malformed config.toml: `login status`, then `features list`. */
const CONFIG_ERROR = 'Error loading configuration: /home/u/.codex/config.toml:2:8: unclosed table, expected `]`';
const FEATURES_CONFIG_ERROR =
  'Error: failed to load bootstrap configuration\n\nCaused by:\n    0: /home/u/.codex/config.toml:2:8: unclosed table, expected `]`\n    1: TOML parse error at line 2, column 8';
const AUTH_ERROR = 'unexpected status 401 Unauthorized: Provided authentication token is expired. Please try signing in again., url: https://chatgpt.com/backend-api/codex/responses, request id: req_fake';

/** Features as `codex features list` prints them: name, stage, enabled. FAKE_CODEX_FEATURES (comma-separated) replaces the list. */
const DEFAULT_FEATURES = [
  ['apps', 'stable', true], ['browser_use', 'stable', true], ['browser_use_external', 'stable', true], ['browser_use_full_cdp_access', 'stable', true],
  ['code_mode', 'under development', false], ['computer_use', 'stable', true], ['enable_mcp_apps', 'under development', false], ['goals', 'stable', true],
  ['hooks', 'stable', true], ['image_generation', 'stable', true], ['in_app_browser', 'stable', true], ['in_app_chat', 'stable', true],
  ['in_app_dictation', 'stable', true], ['in_app_local_automation', 'stable', true], ['in_app_updates', 'stable', true], ['memories', 'stable', false],
  ['multi_agent', 'stable', true], ['multi_agent_v2', 'stable', false], ['plugin_sharing', 'stable', true], ['plugins', 'stable', true],
  ['realtime_conversation', 'stable', true], ['recommended_plugins', 'stable', false], ['remote_plugin', 'stable', true], ['request_permissions_tool', 'under development', false],
  ['search_tool', 'removed', false], ['shell_tool', 'stable', true], ['skill_mcp_dependency_install', 'stable', true], ['skill_search', 'stable', true],
  ['standalone_web_search', 'under development', false], ['tool_suggest', 'stable', true], ['unified_exec', 'stable', true], ['view_image', 'stable', true],
  ['web_search_request', 'deprecated', false], ['workspace_dependencies', 'stable', true], ['worktrees', 'stable', true],
];
const features = env.FAKE_CODEX_FEATURES !== undefined
  ? env.FAKE_CODEX_FEATURES.split(',').map((s) => s.trim()).filter(Boolean).map((n) => [n, 'stable', true])
  : DEFAULT_FEATURES;
const knownFeature = (name) => features.some(([n]) => n === name);

function fail(message, code = 1) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

/** FAKE_CODEX_MODE_<TASK> beats FAKE_CODEX_MODE_FILE (read on every run) beats FAKE_CODEX_MODE. */
function modeFor(task) {
  const perTask = task ? env[`FAKE_CODEX_MODE_${task.toUpperCase()}`] : undefined;
  if (perTask) return checkMode(perTask.trim());
  if (env.FAKE_CODEX_MODE_FILE && existsSync(env.FAKE_CODEX_MODE_FILE)) {
    const fromFile = readFileSync(env.FAKE_CODEX_MODE_FILE, 'utf8').trim();
    if (fromFile) return checkMode(fromFile);
  }
  return checkMode(env.FAKE_CODEX_MODE || 'ok');
}

function checkMode(m) {
  if (!MODES.includes(m)) fail(`fake-codex: unknown mode "${m}" (expected ${MODES.join(' | ')})`, 64);
  return m;
}

// --- subcommands other than exec ----------------------------------------------------------------
if (argv[0] === '--version' || argv[0] === '-V') {
  console.log('codex-cli 0.0.0-fake');
  process.exit(0);
}
if (argv[0] === 'login' && argv[1] === 'status') {
  // The real CLI prints the status on stderr. FAKE_CODEX_LOGIN picks another answer.
  const login = env.FAKE_CODEX_LOGIN || (modeFor() === 'auth' ? 'none' : 'ok');
  if (login === 'none') fail('Not logged in', 1);
  if (login === 'config') fail(CONFIG_ERROR, 1);
  if (login === 'weird') {
    process.stderr.write('Signed in somehow\n');
    process.exit(0);
  }
  process.stderr.write('Logged in using ChatGPT\n');
  process.exit(0);
}
if (argv[0] === 'login' && argv.length === 1) {
  console.log('fake-codex: pretend login succeeded');
  process.exit(0);
}
if (argv[0] === 'features' && argv[1] === 'list') {
  if (env.FAKE_CODEX_FEATURES_DELAY_MS) await sleep(Number(env.FAKE_CODEX_FEATURES_DELAY_MS));
  if (env.FAKE_CODEX_FEATURES_FAIL === 'config') fail(FEATURES_CONFIG_ERROR, 1);
  if (env.FAKE_CODEX_FEATURES_FAIL) fail("error: unrecognized subcommand 'features'", 2);
  for (const [name, stage, on] of features) console.log(`${name.padEnd(40)} ${stage.padEnd(18)} ${on}`);
  process.exit(0);
}
if (argv[0] === 'mcp' && argv[1] === 'list') {
  if (!argv.includes('--json')) fail('fake-codex: only `mcp list --json` is supported', 64);
  const names = env.FAKE_CODEX_MCP_SERVERS ? JSON.parse(env.FAKE_CODEX_MCP_SERVERS) : [];
  if (env.FAKE_CODEX_MCP_RECORD) writeFileSync(env.FAKE_CODEX_MCP_RECORD, JSON.stringify({ argv, cwd: process.cwd() }));
  console.log(JSON.stringify(names.map((name) => ({ name, enabled: true, disabled_reason: null, transport: { type: 'stdio', command: 'fake-mcp', args: [] } })), null, 2));
  process.exit(0);
}
if (argv[0] !== 'exec' && argv[0] !== 'e') fail(`fake-codex: only exec, login, features list and mcp list are supported (got ${JSON.stringify(argv[0])})`, 64);

// --- exec argument parsing (strict, so typos in our args fail loudly) ----------------------------
const VALUE_FLAGS = new Map([
  ['-c', '--config'], ['--config', '--config'], ['--enable', '--enable'], ['--disable', '--disable'], ['-i', '--image'], ['--image', '--image'],
  ['-m', '--model'], ['--model', '--model'], ['--local-provider', '--local-provider'], ['-p', '--profile'], ['--profile', '--profile'],
  ['-s', '--sandbox'], ['--sandbox', '--sandbox'], ['-C', '--cd'], ['--cd', '--cd'], ['--add-dir', '--add-dir'], ['--thread-source', '--thread-source'],
  ['--output-schema', '--output-schema'], ['--color', '--color'], ['-o', '--output-last-message'], ['--output-last-message', '--output-last-message'],
]);
const REPEATABLE = new Set(['--config', '--enable', '--disable', '--image', '--add-dir']);
const BOOL_FLAGS = new Set([
  '--strict-config', '--oss', '--approve-for-me', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--worktree',
  '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--json',
]);

const flags = {};
const positional = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-') {
    positional.push(a);
    continue;
  }
  const eq = a.startsWith('--') ? a.indexOf('=') : -1;
  const name = eq > 0 ? a.slice(0, eq) : a;
  if (VALUE_FLAGS.has(name)) {
    const key = VALUE_FLAGS.get(name);
    const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (value === undefined || (eq < 0 && value.startsWith('-') && value !== '-')) fail(`error: a value is required for '${key} <VALUE>' but none was supplied`, 2);
    if (REPEATABLE.has(key)) (flags[key] ??= []).push(value);
    else flags[key] = value;
  } else if (BOOL_FLAGS.has(name)) {
    flags[name] = true;
  } else if (a.startsWith('-')) {
    fail(`error: unexpected argument '${a}' found\n\nUsage: codex exec [OPTIONS] [PROMPT]`, 2);
  } else {
    positional.push(a);
  }
}

for (const f of flags['--disable'] ?? []) if (!knownFeature(f)) fail(`Error: Unknown feature flag: ${f}`, 1);
for (const f of flags['--enable'] ?? []) if (!knownFeature(f)) fail(`Error: Unknown feature flag: ${f}`, 1);
if (flags['--sandbox'] && !['read-only', 'workspace-write', 'danger-full-access'].includes(flags['--sandbox'])) {
  fail(`error: invalid value '${flags['--sandbox']}' for '--sandbox <SANDBOX_MODE>'`, 2);
}
const disabled = new Set(flags['--disable'] ?? []);
const configs = flags['--config'] ?? [];

// --- -c overrides, parsed as TOML values (the subset Filos sends: strings, inline tables, arrays, booleans, integers)
function parseToml(text) {
  let i = 0;
  const ws = () => {
    while (i < text.length && /[ \t]/.test(text[i])) i++;
  };
  const str = () => {
    i++; // opening quote
    let out = '';
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') {
        const c = text[++i];
        if (c === 'u') {
          out += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16));
          i += 5;
          continue;
        }
        out += { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' }[c] ?? c;
        i++;
        continue;
      }
      out += text[i++];
    }
    if (text[i] !== '"') throw new Error('unterminated string');
    i++;
    return out;
  };
  const key = () => {
    ws();
    if (text[i] === '"') return str();
    const m = /^[A-Za-z0-9_:-]+/.exec(text.slice(i));
    if (!m) throw new Error(`bad key at ${i}`);
    i += m[0].length;
    return m[0];
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '"') return str();
    if (c === '{') {
      i++;
      const out = {};
      ws();
      if (text[i] === '}') return i++, out;
      for (;;) {
        const k = key();
        ws();
        if (text[i++] !== '=') throw new Error(`expected = at ${i - 1}`);
        out[k] = value();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i++] !== '}') throw new Error(`expected } at ${i - 1}`);
        return out;
      }
    }
    if (c === '[') {
      i++;
      const out = [];
      ws();
      if (text[i] === ']') return i++, out;
      for (;;) {
        out.push(value());
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i++] !== ']') throw new Error(`expected ] at ${i - 1}`);
        return out;
      }
    }
    const m = /^(true|false|-?\d+)/.exec(text.slice(i));
    if (!m) throw new Error(`bad value at ${i}`);
    i += m[0].length;
    return m[0] === 'true' ? true : m[0] === 'false' ? false : Number(m[0]);
  };
  const v = value();
  ws();
  if (i !== text.length) throw new Error(`trailing text at ${i}`);
  return v;
}
/** -c key=value as {path: [...dotted key], value}; codex falls back to the raw string when the value isn't TOML. */
const overrides = configs.map((c) => {
  const eq = c.indexOf('=');
  const path = c.slice(0, eq).split('.');
  try {
    return { path, value: parseToml(c.slice(eq + 1)) };
  } catch {
    return { path, value: c.slice(eq + 1) };
  }
});
const override = (dotted) => overrides.filter((o) => o.path.join('.') === dotted).pop()?.value;

// The permission profile, as codex-cli 0.160 resolves it: --sandbox wins over default_permissions.
const profileName = override('default_permissions');
let permissions;
if (profileName !== undefined) {
  const table = (part) => override(`permissions.${profileName}.${part}`);
  const filesystem = table('filesystem');
  if (!filesystem || typeof filesystem !== 'object') fail('Error: default_permissions requires a `[permissions]` table', 1);
  for (const [path, access] of Object.entries(filesystem)) {
    if (/[*?[\]]/.test(path) && access !== 'deny') fail(`Error: filesystem glob path \`${path}\` only supports \`deny\` access; use an exact path or trailing \`/**\` for \`read\` subtree access`, 1);
  }
  permissions = { profile: profileName, filesystem, network: table('network') ?? {} };
}
const effectiveSandbox = flags['--sandbox'] ?? (permissions ? `profile:${permissions.profile}` : 'read-only');
const developerInstructions = override('developer_instructions');
const skillsConfig = override('skills.config');
const skillsDisabled = Array.isArray(skillsConfig) ? skillsConfig.filter((e) => e && e.enabled === false && typeof e.path === 'string').map((e) => e.path) : [];

let schema;
if (flags['--output-schema'] !== undefined) {
  try {
    schema = JSON.parse(readFileSync(resolve(flags['--output-schema']), 'utf8'));
  } catch (err) {
    fail(`Error: failed to load output schema ${flags['--output-schema']}: ${err.message}`, 1);
  }
}

let stdin = '';
const wantsStdin = positional.includes('-') || !positional.length;
if (wantsStdin && !process.stdin.isTTY) {
  for await (const chunk of process.stdin) stdin += chunk;
}
const prompt = positional.filter((p) => p !== '-').length ? positional.filter((p) => p !== '-').join(' ') + (stdin ? `\n<stdin>\n${stdin}\n</stdin>` : '') : stdin;
if (!prompt.trim()) fail('No prompt provided. Either specify one as an argument or pipe the prompt into stdin.', 1);

// Which job this is: a Filos task named on the first line of the prompt, or the comprehension pass.
const marker = /^Filos task: (\S+)/.exec(prompt);
const task = marker ? marker[1] : 'comprehend';
if (marker && !TASKS.includes(task)) fail(`fake-codex: unknown Filos task "${task}" (expected ${TASKS.join(' | ')})`, 64);
const mode = modeFor(marker ? task : undefined);
/** A shell tool exists unless both shell features are off (as for the real CLI). */
const hasShell = !(disabled.has('shell_tool') && disabled.has('unified_exec'));
const cwd = flags['--cd'] ? resolve(flags['--cd']) : process.cwd();

/**
 * Skills a "$name" (or "[$x](skill://path)") in the prompt would pull in, as codex-cli 0.160 does
 * even with skills.include_instructions=false: SKILL.md files under the working root's
 * .agents/skills and .codex/skills (6 levels deep, symlinks followed) not switched off by path in
 * skills.config. Names come from the SKILL.md front matter.
 */
function injectedSkills() {
  const off = new Set(skillsDisabled.flatMap((p) => [p, ...(existsSync(p) ? [realpathSync(p)] : [])]));
  const skills = [];
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(dir, name);
      if (name === 'SKILL.md') {
        const skillName = /^name:\s*(\S+)/m.exec(readFileSync(path, 'utf8'))?.[1];
        if (skillName && !off.has(path) && !off.has(realpathSync(path))) skills.push({ name: skillName, path });
      } else if (depth < 6) {
        try {
          if (statSync(path).isDirectory()) walk(path, depth + 1);
        } catch {
          // dangling link
        }
      }
    }
  };
  for (const root of [join(cwd, '.agents', 'skills'), join(cwd, '.codex', 'skills')]) walk(root, 1);
  const mentioned = new Set([...prompt.matchAll(/\$([A-Za-z0-9_:-]+)/g)].map((m) => m[1]));
  const linked = new Set([...prompt.matchAll(/\[\$[^\]]*\]\(skill:\/\/([^)\s]+)\)/g)].map((m) => m[1]));
  return skills.filter((k) => mentioned.has(k.name) || linked.has(k.path)).map((k) => k.name);
}

if (env.FAKE_CODEX_RECORD) {
  writeFileSync(
    env.FAKE_CODEX_RECORD,
    JSON.stringify(
      {
        argv,
        cwd: process.cwd(),
        flags,
        configs,
        disabled: [...disabled],
        task,
        hasShell,
        promptVia: positional.includes('-') ? 'stdin' : positional.length ? 'argv' : 'stdin',
        prompt,
        developerInstructions,
        permissions,
        effectiveSandbox,
        skillsDisabled,
        bundledSkills: override('skills.bundled.enabled') !== false,
        injectedSkills: injectedSkills(),
        schema,
        // Which agent-session variables reached us (the provider should strip most of them).
        agentEnv: Object.keys(env).filter((k) => /^(CODEX|CLAUDE|EXEC_WRAPPER|OPENAI)/.test(k)),
      },
      null,
      2,
    ),
  );
}

// --- answers per task (same canned data as fake-claude) -----------------------------------------
const readJson = (file) => JSON.parse(readFileSync(resolve(file), 'utf8'));
const loadGraph = () => readJson(env.FAKE_CODEX_GRAPH || join(claudeFixtures, 'graph.json'));

/** The text of a <<<NAME id>>> … <<<END NAME id>>> block in the prompt, or ''. */
function block(name) {
  const m = new RegExp(`<<<${name} ([0-9a-f]+)>>>\\n([\\s\\S]*?)\\n<<<END ${name} \\1>>>`).exec(prompt);
  return m ? m[2] : '';
}

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

function questionSet() {
  if (env.FAKE_CODEX_QUESTIONS) return readJson(env.FAKE_CODEX_QUESTIONS);
  const canned = readJson(join(claudeFixtures, 'questions.json'));
  const nodes = promptNodes();
  const ids = new Set(nodes.map((n) => n.id));
  if (canned.questions.every((q) => ids.has(q.nodeId))) return canned;
  const modules = nodes.filter((n) => n.kind === 'module' && n.change !== 'context');
  return {
    contractVersion: '0.1',
    depth: { proposed: 'standard', why: `fake-codex: ${modules.length} changed module${modules.length === 1 ? '' : 's'}.` },
    questions: (modules.length ? modules : nodes.slice(0, 1)).map((n) => ({
      id: `q-${n.id.replace(/[^\w-]+/g, '-')}-predict`,
      nodeId: n.id,
      stage: 'predict',
      purpose: 'understand',
      depth: 'skim',
      prompt: `What do you expect the change in ${n.id} to affect?`,
      choices: [
        { id: 'a', text: 'Only its own module.', correct: false, explain: 'fake-codex: callers see the change too.' },
        { id: 'b', text: 'Its callers as well.', correct: true, explain: 'fake-codex: the behaviour change reaches every caller.' },
      ],
      hint: 'Who calls into it?',
    })),
  };
}

function evaluation() {
  if (env.FAKE_CODEX_EVALUATE) return readJson(env.FAKE_CODEX_EVALUATE);
  const answer = block('ANSWER');
  const attempt = Number(/This is attempt (\d+)/.exec(prompt)?.[1] ?? 1);
  if (/half-even/i.test(answer)) {
    return { verdict: 'correct', reply: 'Yes: exact ties now go to the even cent. Keep in mind that every caller that rounds a total inherits this.' };
  }
  const out =
    attempt <= 1
      ? { verdict: 'incorrect', reply: 'Not quite. Look at the branch that only runs on an exact tie: what does it return when the floor is odd?' }
      : { verdict: 'incorrect', reply: 'Ties now round half-even: line 11 returns the even neighbour, so 2.345 becomes 2.34 rather than 2.35.' };
  if (/untested|no test/i.test(answer)) {
    out.comment = { file: 'money/round.ts', line: 10, body: 'Exact half-cent ties have no test. Could you add one (2.345 -> 2.34)?', severity: 'suggestion' };
  }
  return out;
}

function draftedComments() {
  if (env.FAKE_CODEX_DRAFT_COMMENTS) return readJson(env.FAKE_CODEX_DRAFT_COMMENTS);
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
  if (env.FAKE_CODEX_THREAD) return readJson(env.FAKE_CODEX_THREAD);
  return {
    reply: 'Agreed. Naming a concrete input makes the request easy to act on; here is a tighter version.',
    proposal: 'Could you add a test for an exact half-cent tie, for example 2.345 -> 2.34? It is the one input whose result this PR changes.',
  };
}

function brokenAnswer() {
  switch (task) {
    case 'questions':
      return { contractVersion: '0.1', depth: { proposed: 'standard', why: 'x' }, questions: [{ id: 'q1', nodeId: 'no/such-node', stage: 'predict', purpose: 'understand', depth: 'skim', prompt: 'Where?' }] };
    case 'evaluate':
      return { verdict: 'maybe', reply: '' };
    case 'draftComments':
      return { comments: 'none' };
    case 'thread':
      return { reply: null, proposal: 'A proposal without a reply.' };
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

// --- the output schema, as the API treats it in strict mode -------------------------------------

/** Problems the API would reject a strict schema for (only the rules Filos's converter must get right). */
function strictProblems(s, at = 'root', out = []) {
  if (!s || typeof s !== 'object') return out;
  if ('$ref' in s || 'const' in s || 'minLength' in s || 'maxLength' in s || 'oneOf' in s || 'allOf' in s) out.push(`${at}: unsupported keyword`);
  if (s.type === 'object' || (Array.isArray(s.type) && s.type.includes('object'))) {
    const keys = Object.keys(s.properties ?? {});
    if (s.additionalProperties !== false) out.push(`${at}: 'additionalProperties' is required to be supplied and to be false`);
    const req = new Set(s.required ?? []);
    const missing = keys.filter((k) => !req.has(k));
    if (missing.length) out.push(`${at}: 'required' is required to be supplied and to be an array including every key in properties. Missing '${missing[0]}'`);
    for (const k of keys) strictProblems(s.properties[k], `${at}.${k}`, out);
  }
  if (s.items) strictProblems(s.items, `${at}[]`, out);
  for (const b of s.anyOf ?? []) strictProblems(b, at, out);
  return out;
}

/** What a strict-mode model writes: every property present, null where the answer has none. */
function fillNulls(value, s) {
  if (!s || typeof s !== 'object' || value === null || value === undefined) return value;
  if (Array.isArray(s.anyOf)) {
    const branch = s.anyOf.find((b) => b.type !== 'null' && (Array.isArray(value) ? b.type === 'array' : typeof value === 'object' ? b.type === 'object' : true));
    return branch ? fillNulls(value, branch) : value;
  }
  if (Array.isArray(value)) return s.items ? value.map((v) => fillNulls(v, s.items)) : value;
  if (typeof value === 'object' && s.properties) {
    const out = {};
    for (const [k, sub] of Object.entries(s.properties)) out[k] = k in value ? fillNulls(value[k], sub) : null;
    for (const k of Object.keys(value)) if (!(k in out)) out[k] = value[k];
    return out;
  }
  return value;
}

// --- output ------------------------------------------------------------------------------------
const threadId = '01a10000-0000-7000-8000-000000000000';
let itemNo = 0;
const emit = (e) => {
  if (flags['--json']) process.stdout.write(JSON.stringify(e) + '\n');
};
const item = (fields) => ({ id: `item_${itemNo++}`, ...fields });

function writeLastMessage(text) {
  // FAKE_CODEX_NO_LAST_MESSAGE: behave like a CLI that ignores -o (the answer is only in the stream).
  if (flags['--output-last-message'] !== undefined && !env.FAKE_CODEX_NO_LAST_MESSAGE) writeFileSync(resolve(flags['--output-last-message']), text);
}

function command(cmd, output) {
  const it = item({ type: 'command_execution', command: `/bin/bash -lc '${cmd.replace(/'/g, `'\\''`)}'`, aggregated_output: '', exit_code: null, status: 'in_progress' });
  emit({ type: 'item.started', item: it });
  emit({ type: 'item.completed', item: { ...it, aggregated_output: output, exit_code: 0, status: 'completed' } });
}

function usage() {
  return task === 'comprehend'
    ? { input_tokens: 24000, cached_input_tokens: 12000, cache_write_input_tokens: 0, output_tokens: 3000, reasoning_output_tokens: 1200 }
    : { input_tokens: 4000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 100 };
}

/** The tool calls a real run makes before answering (only when the run has a shell). */
function work() {
  if (!hasShell) return;
  // Real runs start with a line of commentary, then the commands, with reasoning summaries between.
  emit({ type: 'item.completed', item: item({ type: 'agent_message', text: 'I’ll read the touched file and locate its in-repo callers, then return the JSON.' }) });
  emit({ type: 'item.completed', item: item({ type: 'reasoning', text: '**Reading the change**\n\nfake-codex looks at the touched files first.' }) });
  const file = task === 'comprehend' ? 'money/round.ts' : (promptNodes().find((n) => n.anchor)?.anchor.file ?? 'money/round.ts');
  command(`nl -ba ${file}`, '     1\t// file contents elided by fake-codex\n');
  command("rg -n 'roundToCents' .", './money/round.ts:9:export function roundToCents(amount: number): number {\n');
  emit({ type: 'item.completed', item: item({ type: 'reasoning', text: '**Putting it together**' }) });
}

function finish(text) {
  emit({ type: 'item.completed', item: item({ type: 'agent_message', text }) });
  writeLastMessage(text);
  emit({ type: 'turn.completed', usage: usage() });
  if (!flags['--json']) process.stdout.write(text + '\n');
}

function failTurn(message, { retries = 0, stderr = '' } = {}) {
  for (let i = 1; i <= retries; i++) emit({ type: 'error', message: `Reconnecting... ${i}/${retries} (${message})` });
  emit({ type: 'error', message });
  emit({ type: 'turn.failed', error: { message } });
  if (stderr) process.stderr.write(stderr + '\n');
  process.exitCode = 1;
}

function start() {
  emit({ type: 'thread.started', thread_id: threadId });
  emit({ type: 'turn.started' });
}

/** The answer as a strict-mode model writes it, or a schema error if the schema isn't strict. */
function answerText(payload) {
  return JSON.stringify(schema ? fillNulls(payload, schema) : payload);
}

const problems = schema ? strictProblems(schema) : [];
start();
if (problems.length && ['ok', 'fenced', 'contract', 'slow', 'badtools'].includes(mode)) {
  failTurn(
    JSON.stringify({
      type: 'error',
      status: 400,
      error: { type: 'invalid_request_error', code: 'invalid_json_schema', message: `Invalid schema for response_format 'codex_output_schema': In context=(${problems[0].split(':')[0]}), ${problems[0].split(': ').slice(1).join(': ')}.`, param: 'text.format.schema' },
    }),
  );
} else {
  switch (mode) {
    case 'ok':
      work();
      finish(answerText(answer()));
      break;

    case 'fenced':
      // No bare JSON: the answer only appears as fenced JSON in the text.
      work();
      finish(`Here is ${task === 'comprehend' ? 'the review graph' : 'my answer'}:\n\n\`\`\`json\n${JSON.stringify(answer(), null, 2)}\n\`\`\`\n`);
      break;

    case 'contract':
      work();
      finish(JSON.stringify(brokenAnswer()));
      break;

    case 'empty':
      // The turn completes without a final message: -o is written empty.
      work();
      writeLastMessage('');
      emit({ type: 'turn.completed', usage: usage() });
      break;

    case 'slow': {
      // A helper process in our process group, like the commands a real agent starts. It shares
      // stdout, so the caller only sees "close" once the whole tree is gone.
      const delay = Number(env.FAKE_CODEX_DELAY_MS || 60000);
      const helper = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${delay})`], { stdio: ['ignore', 'inherit', 'inherit'] });
      if (env.FAKE_CODEX_PIDFILE) writeFileSync(env.FAKE_CODEX_PIDFILE, JSON.stringify({ cli: process.pid, helper: helper.pid }));
      await sleep(delay);
      work();
      finish(answerText(answer()));
      break;
    }

    case 'auth': {
      const message = env.FAKE_CODEX_MESSAGE || AUTH_ERROR;
      failTurn(message, { retries: 2, stderr: '2026-10-04T00:00:00.000000Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized' });
      break;
    }

    case 'model':
      // As the real CLI does, an informational error item first, then the API's refusal.
      emit({ type: 'item.completed', item: item({ type: 'error', message: 'Model metadata for `gpt-5.3-codex` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' }) });
      failTurn(env.FAKE_CODEX_MESSAGE || MODEL_ERROR);
      break;

    case 'quota':
      failTurn(env.FAKE_CODEX_MESSAGE || QUOTA_ERROR);
      break;

    case 'crash':
      process.stderr.write(`thread 'main' panicked at core/src/fake.rs:1:1:\n${env.FAKE_CODEX_MESSAGE || 'called `Option::unwrap()` on a `None` value'}\nnote: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace\n`);
      process.exitCode = 101;
      break;

    case 'badtools': {
      // A CLI that ignored the lockdown: a file edit (or, with the shell off, a command). Waits, so a
      // careful caller can stop it first.
      const it = hasShell
        ? item({ type: 'file_change', changes: [{ path: join(cwd, 'money/round.ts'), kind: 'update' }], status: 'in_progress' })
        : item({ type: 'command_execution', command: "/bin/bash -lc 'cat money/round.ts'", aggregated_output: '', exit_code: null, status: 'in_progress' });
      emit({ type: 'item.started', item: it });
      await sleep(Number(env.FAKE_CODEX_DELAY_MS || 5000));
      finish(answerText(answer()));
      break;
    }
  }
}
