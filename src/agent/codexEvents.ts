// What `codex exec --json` prints, and what Filos makes of it: progress messages for the loading
// view, token usage, and errors classified into ProviderError kinds. Shapes checked against
// codex-cli 0.160.0 (2026-10-04):
//   {"type":"thread.started","thread_id":"…"}
//   {"type":"turn.started"}
//   {"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc 'sed -n 1,5p a.txt'","aggregated_output":"","exit_code":null,"status":"in_progress"}}
//   {"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"**Reading the change**…"}}
//   {"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"{…json…}"}}
//   {"type":"turn.completed","usage":{"input_tokens":400,"cached_input_tokens":160,"output_tokens":80,"reasoning_output_tokens":28}}
// and on failure {"type":"error","message":"…"} (also "Reconnecting... 2/5 (…)" while it retries)
// then {"type":"turn.failed","error":{"message":"…"}}, exit code 1.

import { isAbsolute, relative, resolve, sep } from 'node:path';
import { safeProgressText } from './progress';
import { ProviderError, type TokenUsage } from './provider';

export type CodexEvent = Record<string, unknown> & { type?: unknown };
export type CodexItem = Record<string, unknown> & { type?: unknown };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseEvent(line: string): CodexEvent | undefined {
  const t = line.trim();
  if (!t.startsWith('{')) return undefined;
  try {
    const v: unknown = JSON.parse(t);
    return isRecord(v) ? (v as CodexEvent) : undefined;
  } catch {
    return undefined;
  }
}

/** The item of an item.started / item.updated / item.completed event. */
export function eventItem(e: CodexEvent): CodexItem | undefined {
  return typeof e.type === 'string' && e.type.startsWith('item.') && isRecord(e.item) ? (e.item as CodexItem) : undefined;
}

/**
 * Item types Filos never lets Codex use: file edits, MCP and web tools, sub-agents. The lockdown
 * flags should make them impossible; seeing one means the CLI ignored them, and the run is stopped.
 * A command_execution is forbidden too when the run asked for no tools.
 */
const FORBIDDEN_ITEM = /^(file_change|mcp_tool_call|web_search|collab_tool_call|image_generation|computer_use|browser\w*)$/;

export function forbiddenItem(item: CodexItem, tools: 'none' | 'read'): string | undefined {
  const type = typeof item.type === 'string' ? item.type : '';
  if (FORBIDDEN_ITEM.test(type)) return type;
  if (tools === 'none' && type === 'command_execution') return type;
  return undefined;
}

// --- progress ----------------------------------------------------------------------------------

export interface ProgressWording {
  /** Shown while Codex reasons. */
  thinking: string;
  /** Shown once the answer is being written. */
  writing: string;
}

/**
 * Progress text for one event, or undefined. Everything in an event is agent-controlled, so each
 * message goes through safeProgressText, and a path is shown only when it is inside the repo.
 */
export function progressForEvent(e: CodexEvent, repoRoot: string, w: ProgressWording): string | undefined {
  if (e.type === 'error' && typeof e.message === 'string') {
    const m = /^Reconnecting\.\.\.\s*(\d+)\/(\d+)/.exec(e.message);
    return m ? safeProgressText(`Reconnecting to Codex ${m[1]}/${m[2]}…`) : undefined;
  }
  const item = eventItem(e);
  if (!item) return undefined;
  const type = item.type;
  if (type === 'command_execution') {
    // Once a command is done, Codex is thinking again: the long quiet stretch before the answer
    // would otherwise sit on the last file read.
    if (e.type === 'item.completed') return safeProgressText(w.thinking);
    return safeProgressText(commandProgress(typeof item.command === 'string' ? item.command : '', repoRoot));
  }
  if (type === 'reasoning') return safeProgressText(w.thinking);
  if (type === 'agent_message') {
    // Codex also sends short commentary ("I'll read the touched file…") before its commands; only
    // the answer itself (JSON) means it is writing.
    const text = typeof item.text === 'string' ? item.text.trimStart() : '';
    return safeProgressText(text.startsWith('{') || text.startsWith('```') ? w.writing : w.thinking);
  }
  if (type === 'todo_list') return safeProgressText('Planning…');
  return undefined;
}

const READERS = new Set(['cat', 'head', 'tail', 'nl', 'less', 'more', 'bat', 'batcat', 'wc']);
const SEARCHERS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'git-grep']);
const LISTERS = new Set(['ls', 'find', 'fd', 'fdfind', 'tree']);

/**
 * "Reading money/round.ts" when the command clearly reads a file (cat, sed -n, head, tail, nl…),
 * "Searching for “pattern”" for rg/grep, "Listing files" for ls/find/rg --files, and otherwise
 * "Running a read-only command". Codex wraps every command as `/bin/bash -lc '<script>'`.
 */
export function commandProgress(command: string, repoRoot: string): string {
  const script = unwrapShell(command);
  const first = script.split(/\s*(?:\|\||&&|[|;\n])\s*/)[0] ?? '';
  const words = shellWords(first);
  if (!words.length) return 'Running a read-only command';
  let [prog, ...args] = words;
  prog = prog.split('/').pop() ?? prog;
  if (prog === 'git' && args[0] === 'grep') {
    prog = 'git-grep';
    args = args.slice(1);
  }
  const operands = args.filter((a) => !a.startsWith('-'));

  if (READERS.has(prog) && operands.length) return `Reading ${shortPath(operands[operands.length - 1], repoRoot)}`;
  if (prog === 'sed' && args.includes('-n')) {
    // sed -n '1,80p' file: the last operand that isn't the script is the file.
    const file = operands.filter((a) => !/^\d*,?\$?\d*p$/.test(a)).pop();
    if (file) return `Reading ${shortPath(file, repoRoot)}`;
  }
  if (prog === 'rg' && args.includes('--files')) return 'Listing files';
  if (SEARCHERS.has(prog)) {
    const pattern = patternArg(args);
    return pattern ? `Searching for “${pattern.slice(0, 60)}”` : 'Searching the repository';
  }
  if (LISTERS.has(prog)) return 'Listing files';
  return 'Running a read-only command';
}

/** The search pattern of an rg/grep command: the -e value, or the first operand. */
function patternArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-e' || a === '--regexp') return args[i + 1];
    if (a.startsWith('--regexp=')) return a.slice('--regexp='.length);
  }
  // Options that take a value, so their value isn't mistaken for the pattern.
  const valued = new Set(['-g', '--glob', '-t', '--type', '-T', '--type-not', '-m', '--max-count', '-A', '-B', '-C', '--context', '--include', '--exclude']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valued.has(a)) {
      i++;
      continue;
    }
    if (!a.startsWith('-')) return a;
  }
  return undefined;
}

/** `/bin/bash -lc 'script'` → `script`; anything else is returned as is. */
export function unwrapShell(command: string): string {
  const m = /^\s*(?:\S*\/)?(?:bash|zsh|sh|dash)\s+-l?c\s+([\s\S]*)$/.exec(command);
  if (!m) return command.trim();
  const words = shellWords(m[1]);
  return words.length === 1 ? words[0] : m[1].trim();
}

/** Splits a command line into words, honouring single and double quotes and backslashes (no expansion). */
export function shellWords(s: string): string[] {
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      cur += end < 0 ? s.slice(i + 1) : s.slice(i + 1, end);
      i = end < 0 ? s.length : end;
      inWord = true;
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) i++;
        cur += s[i++];
      }
      inWord = true;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(cur);
      cur = '';
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

/** Repo-relative path for display; never a path outside the repo, which could be anything. */
export function shortPath(p: string, root: string): string {
  if (!p) return 'a file';
  const rel = relative(root, resolve(root, p));
  const inside = rel !== '' && rel.split(sep)[0] !== '..' && !isAbsolute(rel);
  return inside ? rel.split(sep).join('/') : 'a file outside the repo';
}

// --- usage -------------------------------------------------------------------------------------

/** Adds a turn.completed event's usage to `total` (Codex reports tokens, never a cost). */
export function addUsage(total: TokenUsage | undefined, e: CodexEvent): TokenUsage | undefined {
  if (e.type !== 'turn.completed' || !isRecord(e.usage)) return total;
  const u = e.usage;
  const n = (k: string) => (typeof u[k] === 'number' && Number.isFinite(u[k]) ? (u[k] as number) : 0);
  const t = total ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  return {
    inputTokens: t.inputTokens + n('input_tokens'),
    cachedInputTokens: t.cachedInputTokens + n('cached_input_tokens'),
    outputTokens: t.outputTokens + n('output_tokens'),
    reasoningOutputTokens: t.reasoningOutputTokens + n('reasoning_output_tokens'),
  };
}

// --- errors ------------------------------------------------------------------------------------

/** Error text from an `error` or `turn.failed` event; "Reconnecting..." retries are not errors yet. */
export function eventError(e: CodexEvent): { message: string; final: boolean } | undefined {
  if (e.type === 'turn.failed') {
    const msg = isRecord(e.error) && typeof e.error.message === 'string' ? e.error.message : 'turn failed';
    return { message: msg, final: true };
  }
  if (e.type === 'error' && typeof e.message === 'string' && !/^Reconnecting\.\.\./.test(e.message)) return { message: e.message, final: false };
  return undefined;
}

const AUTH_PATTERN =
  /not logged in|codex login|\b401\b|unauthori[sz]ed|missing bearer|invalid api key|incorrect api key|(?:access|refresh|id) token|token (?:has |is )?(?:expired|invalid|revoked)|failed to refresh|could not be refreshed|re-?authenticate|sign in again|log ?in again|login (?:has )?expired/i;
const MODEL_PATTERN =
  /model (?:is )?not supported|not supported when using codex|unsupported model|unknown model|model_not_found|model (?:`[^`]*`|'[^']*'|"[^"]*"|\S+) (?:does not exist|not found|is not available)|do(?:es)? not have access to (?:the )?model/i;
const LIMIT_PATTERN = /\b429\b|usage limit|rate[ _-]?limit|too many requests|insufficient_quota|quota|limit reached|purchase more credits/i;
const SCHEMA_PATTERN = /invalid_json_schema|invalid schema|text\.format/i;

export interface FailureInput {
  /** Messages of error / turn.failed events, oldest first. */
  errors: string[];
  stderr: string;
  exitCode: number | null;
  /** The model Filos asked for (-m), if any. */
  model?: string;
  useUserConfig: boolean;
}

/** The ProviderError for a run that failed (non-zero exit or a failed turn). */
export function classifyCodexFailure(f: FailureInput): ProviderError {
  const main = f.errors.length ? f.errors[f.errors.length - 1] : '';
  const text = [...f.errors, f.stderr].filter(Boolean).join('\n');
  const detail = text.trim() || `exit code ${f.exitCode}`;
  const readable = humanError(main) || firstLine(f.stderr) || `exit code ${f.exitCode}`;

  if (MODEL_PATTERN.test(text)) {
    const named = f.model ?? /['"`]([^'"`\s]{1,80})['"`] model|model ['"`]([^'"`\s]{1,80})['"`]/i.exec(text)?.slice(1).find(Boolean);
    const which = named ? `the model "${named}"` : 'the configured model';
    const fixes = [
      f.model ? 'set filos.codex.model to a model your account supports, or leave it empty for Codex’s default' : 'set filos.codex.model to a model your account supports',
      ...(f.useUserConfig ? ['or turn off filos.codex.useUserConfig so the model in ~/.codex/config.toml is ignored'] : []),
    ];
    return new ProviderError('failed', `Codex can't use ${which} with your account: ${readable.slice(0, 200)} To fix it, ${fixes.join(', ')}.`, detail);
  }
  if (AUTH_PATTERN.test(text)) {
    return new ProviderError('authExpired', 'Codex needs you to sign in again.', detail);
  }
  if (LIMIT_PATTERN.test(text)) {
    return new ProviderError('budget', `Codex hit a usage or rate limit of your account (not a Filos cap): ${readable.slice(0, 200)} Wait and retry, or check your Codex usage.`, detail);
  }
  if (SCHEMA_PATTERN.test(text)) {
    return new ProviderError('failed', `Codex rejected Filos's output schema: ${readable.slice(0, 200)}`, detail);
  }
  return new ProviderError('failed', `Codex failed: ${readable.slice(0, 200)}`, detail);
}

/**
 * The readable part of an error message. Codex often passes the API's JSON body through as the
 * message ({"error":{"message":"…"}} or {"type":"error","status":400,"error":{…}}): take its message.
 */
export function humanError(message: string): string {
  const t = message.trim();
  if (t.startsWith('{')) {
    try {
      const v: unknown = JSON.parse(t);
      const found = findMessage(v, 0);
      if (found) return found;
    } catch {
      // not JSON after all
    }
  }
  return firstLine(t);
}

function findMessage(v: unknown, depth: number): string | undefined {
  if (!isRecord(v) || depth > 4) return undefined;
  for (const k of ['error', 'detail']) {
    const inner = findMessage(v[k], depth + 1);
    if (inner) return inner;
  }
  return typeof v.message === 'string' && v.message.trim() ? firstLine(v.message) : undefined;
}

const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.trim() ?? '';

// --- the answer --------------------------------------------------------------------------------

/** The JSON object in Codex's final message: the whole text, a fenced block, or the outermost braces. */
export function jsonFromText(text: string): unknown {
  const t = text.trim();
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(t);
  for (const candidate of [t, fenced?.[1], t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)]) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}
