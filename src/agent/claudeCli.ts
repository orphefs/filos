// AgentProvider backed by the `claude` CLI in print mode. We invoke the CLI (not an SDK) so the
// user's own login is inherited, and we never see credentials. See docs/agent-provider.md.

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ReviewGraph } from '../contract/graph';
import { validateGraph } from '../contract/validate';
import { offPathHint, runProcess, type RunResult } from './exec';
import { safeProgressText } from './progress';
import { buildPrompt } from './prompt';
import { ProviderError, type AgentProvider, type AgentTask, type AskRequest, type AskResult, type ComprehensionRequest, type ComprehensionResult } from './provider';
import { repoReader } from './repoFiles';
import { toCliSchema } from './schema';

export { repoReader } from './repoFiles';

export interface ClaudeCliOptions {
  /** Executable path or name on PATH. */
  claudePath: string;
  /** Model alias for --model; omitted means the CLI default. */
  model?: string;
  maxBudgetUsd: number;
  timeoutSeconds: number;
  /**
   * How the prompt reaches the CLI. stdin (default) has no size limit and keeps the diff out of
   * the process list; argv exists for CLIs or wrappers that can't read stdin.
   */
  promptVia?: 'stdin' | 'argv';
  /** Extra environment for the CLI, on top of the extension's own (tests choose fake modes here). */
  env?: Record<string, string>;
  /** Every raw stdout line of a run, for a debug log. Lines can be large (file contents). */
  onRawLine?: (line: string) => void;
}

/** The agent may read the repo for context, never run or change anything. */
export const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'] as const;
/** If the CLI reports any of these as available, it ignored --tools and we refuse to continue. */
const FORBIDDEN_TOOL = /^(Bash|PowerShell|REPL|Edit|Write|MultiEdit|NotebookEdit)$/;

export const AGENT_TASKS: readonly AgentTask[] = ['questions', 'evaluate', 'draftComments', 'thread'];

/**
 * First line of every ask() system prompt. It tells the run apart in logs and lets the fake CLI
 * answer per task; the comprehension pass has no marker.
 */
export const taskMarker = (task: AgentTask) => `Filos task: ${task}`;

/** Wording per task, for progress and error messages. */
const TASK_TEXT: Record<AgentTask, { working: string; writing: string; contract: string; output: string }> = {
  questions: { working: 'Claude Code is reading the change to write questions', writing: 'Writing the questions…', contract: 'question-set contract', output: 'question set' },
  evaluate: { working: 'Claude Code is reading your answer', writing: 'Writing feedback…', contract: 'grading contract', output: 'grade' },
  draftComments: { working: 'Claude Code is drafting comments from your answers', writing: 'Writing the comments…', contract: 'comment contract', output: 'comments' },
  thread: { working: 'Claude Code is reading the thread', writing: 'Writing a reply…', contract: 'thread-reply contract', output: 'reply' },
};

export interface ArgsInput {
  model?: string;
  maxBudgetUsd: number;
  systemPrompt: string;
  /** JSON schema text for --json-schema. */
  schema: string;
  /** read (default): Read, Grep and Glob. none: no tools at all, only the structured answer. */
  tools?: 'none' | 'read';
  /** Present only when the prompt goes in argv. */
  prompt?: string;
}

export function buildClaudeArgs(a: ArgsInput): string[] {
  const args = [
    '-p',
    // stream-json gives us progress lines while the agent works; the last line is the result.
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    a.schema,
    '--append-system-prompt',
    a.systemPrompt,
    // "=" form: --tools is variadic, and a following positional would otherwise be swallowed.
    // An empty list ("--tools=") disables every built-in tool; the CLI still offers StructuredOutput.
    `--tools=${a.tools === 'none' ? '' : ALLOWED_TOOLS.join(',')}`,
    // Never block on a permission prompt; anything not pre-approved (e.g. reads outside the repo) is denied.
    '--permission-mode',
    'dontAsk',
    '--strict-mcp-config',
    // Only the user's own settings: project settings come from the PR under review and could add hooks.
    '--setting-sources',
    'user',
    '--no-session-persistence',
    '--max-budget-usd',
    String(a.maxBudgetUsd),
  ];
  if (a.model) args.push('--model', a.model);
  if (a.prompt !== undefined) args.push('--', a.prompt);
  return args;
}

/**
 * Variables a parent Claude Code session sets for its own children. If VS Code was started from
 * inside such a session they leak into ours and make the CLI act as a nested child (for example,
 * deferring OAuth refresh to a host that isn't there), so we drop them.
 */
const PARENT_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_TERMINAL_MCP_TOOLS',
  'CLAUDE_CODE_REPORT_FINDINGS',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
];

export function childEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const k of PARENT_SESSION_VARS) delete env[k];
  return { ...env, ...extra };
}

/** What the CLI's final "result" message looks like (only the fields we use). */
export interface CliResult {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  terminal_reason?: string;
  result?: string;
  structured_output?: unknown;
  errors?: unknown[];
  total_cost_usd?: number;
  duration_ms?: number;
  modelUsage?: Record<string, unknown>;
}

const AUTH_PATTERN =
  /not logged in|please run \/login|\/login\b|invalid api key|invalid (?:x-api-key|bearer token)|oauth (?:token|session)|failed to authenticate|could not be refreshed|authentication[_ ]error|\b401\b|unauthori[sz]ed|(?:token|session) (?:has )?expired|sign in again|log ?in again/i;

/** Classifies a failed run. Returns undefined when the result is a success worth parsing. */
export function classifyFailure(input: { result?: CliResult; exitCode: number | null; stderr: string; maxBudgetUsd?: number; contract?: string }): ProviderError | undefined {
  const { result, exitCode, stderr } = input;
  if (result && !result.is_error && (result.subtype === undefined || result.subtype === 'success')) return undefined;

  const text = [result?.result, ...(result?.errors ?? []).map(String), result?.subtype, result?.terminal_reason, stderr].filter(Boolean).join('\n');
  const detail = text.trim() || `exit code ${exitCode}`;
  if (AUTH_PATTERN.test(text)) {
    return new ProviderError('authExpired', 'Claude Code needs you to sign in again.', detail);
  }
  if (/budget/i.test(result?.subtype ?? '') || (result && /budget/i.test(text))) {
    const cap = input.maxBudgetUsd !== undefined ? ` ($${input.maxBudgetUsd})` : '';
    return new ProviderError('budget', `Claude Code hit the spending cap${cap} before finishing.`, detail);
  }
  if (result?.subtype === 'error_max_structured_output_retries') {
    return new ProviderError('contract', `Claude Code couldn't produce output matching the ${input.contract ?? 'review-graph contract'}.`, detail);
  }
  const first = detail.split('\n').find((l) => l.trim()) ?? 'unknown error';
  return new ProviderError('failed', `Claude Code failed: ${first.slice(0, 200)}`, detail);
}

/** The answer object from a successful result: structured_output, or JSON in the text as a fallback. */
export function extractJson(result: CliResult, what: string): unknown {
  if (result.structured_output && typeof result.structured_output === 'object') return result.structured_output;
  const text = (result.result ?? '').trim();
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  for (const candidate of [fenced?.[1], text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // try the next candidate
    }
  }
  throw new ProviderError('contract', `Claude Code returned no ${what}.`, text ? `Answer was:\n${text.slice(0, 4000)}` : 'Empty answer.');
}

/** The graph object from a successful comprehension result. */
export const extractGraphJson = (result: CliResult): unknown => extractJson(result, 'review graph');

/** One CLI run, from spawn to a successful result message. */
interface RunSpec {
  repoRoot: string;
  args: string[];
  /** The prompt, when it goes on stdin. */
  stdin?: string;
  signal?: AbortSignal;
  progress: (text: string) => void;
  /** First progress message, before the CLI starts. */
  starting: string;
  /** Once the CLI is up, given the resolved model name if it reported one. */
  working: (model?: string) => string;
  thinking: string;
  writing: string;
  /** Names the contract in "couldn't produce output matching the …" errors. */
  contract: string;
}

interface RunOutcome {
  result: CliResult;
  /** The resolved model from the CLI's init message, e.g. "claude-sonnet-5". */
  initModel?: string;
}

/** Progress callback that sanitises every message (they're partly agent-controlled) and drops repeats. */
function progressSink(onProgress?: (message: string) => void): (text: string) => void {
  let last = '';
  return (text) => {
    const m = safeProgressText(text);
    if (m === last) return;
    last = m;
    onProgress?.(m);
  };
}

export class ClaudeCliProvider implements AgentProvider {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';
  readonly loginCommand: string;
  readonly login: { command: string; args: readonly string[] };

  private readonly opts: ClaudeCliOptions;

  constructor(opts: ClaudeCliOptions) {
    // A relative path with a directory part would otherwise resolve against each run's cwd (the repo).
    const claudePath = /[\\/]/.test(opts.claudePath) && !isAbsolute(opts.claudePath) ? resolve(opts.claudePath) : opts.claudePath;
    this.opts = { ...opts, claudePath };
    const exe = /\s/.test(claudePath) ? `"${claudePath}"` : claudePath;
    this.loginCommand = `${exe} auth login`;
    this.login = { command: claudePath, args: ['auth', 'login'] };
  }

  async checkReady(signal?: AbortSignal): Promise<void> {
    const run = await runProcess({
      command: this.opts.claudePath,
      args: ['auth', 'status'],
      cwd: process.cwd(),
      env: childEnv(process.env, this.opts.env),
      timeoutMs: 20_000,
      signal,
      collectStdout: true,
      maxCollectBytes: 256 * 1024,
    });
    this.throwIfNotRun(run, 20);
    let status: { loggedIn?: unknown } | undefined;
    try {
      status = JSON.parse(run.stdout) as { loggedIn?: unknown };
    } catch {
      status = undefined;
    }
    if (status && status.loggedIn === false) {
      throw new ProviderError('authExpired', 'Claude Code is not signed in.', run.stdout.trim());
    }
    if (!status && run.exitCode !== 0) {
      throw classifyFailure({ exitCode: run.exitCode, stderr: run.stderrTail || run.stdout }) ?? new ProviderError('failed', 'claude auth status failed');
    }
    // Unparseable output with exit 0: an older CLI. Let the real call classify any problem.
  }

  async ask<T>(req: AskRequest<T>): Promise<AskResult<T>> {
    // The task name goes into argv and the error text, so only known names get that far.
    if (!AGENT_TASKS.includes(req.task)) throw new ProviderError('failed', `Unknown agent task "${String(req.task).slice(0, 40)}".`);
    const { model, maxBudgetUsd } = this.opts;
    const text = TASK_TEXT[req.task];
    const viaArgv = this.opts.promptVia === 'argv';
    const args = buildClaudeArgs({
      model,
      maxBudgetUsd,
      systemPrompt: `${taskMarker(req.task)}\n\n${req.system}`,
      schema: JSON.stringify(req.schema),
      tools: req.tools === 'none' ? 'none' : 'read',
      prompt: viaArgv ? req.prompt : undefined,
    });
    const progress = progressSink(req.onProgress);
    const { result } = await this.execute({
      repoRoot: req.repoRoot,
      args,
      stdin: viaArgv ? undefined : req.prompt,
      signal: req.signal,
      progress,
      starting: `Starting Claude Code${model ? ` with ${model}` : ''}…`,
      working: () => `${text.working}…`,
      thinking: 'Thinking…',
      writing: text.writing,
      contract: text.contract,
    });

    const raw = extractJson(result, text.output);
    let v: ReturnType<AskRequest<T>['validate']>;
    try {
      v = req.validate(raw);
    } catch (err) {
      // A validator that trips over a strange shape is still a contract failure, not a crash.
      v = { ok: false, errors: [`validator failed: ${err instanceof Error ? err.message : String(err)}`] };
    }
    if (!v.ok) {
      const n = v.errors.length;
      throw new ProviderError('contract', `Claude Code's ${text.output} broke the ${text.contract} (${n} problem${n === 1 ? '' : 's'}).`, v.errors.join('\n'));
    }
    return { value: v.value, warnings: v.warnings, ...usage(result) };
  }

  async comprehend(req: ComprehensionRequest): Promise<ComprehensionResult> {
    const { model, maxBudgetUsd } = this.opts;
    const prompt = buildPrompt(req);
    const viaArgv = this.opts.promptVia === 'argv';
    const args = buildClaudeArgs({ model, maxBudgetUsd, systemPrompt: prompt.system, schema: JSON.stringify(toCliSchema()), tools: 'read', prompt: viaArgv ? prompt.user : undefined });
    const progress = progressSink(req.onProgress);
    const { result, initModel } = await this.execute({
      repoRoot: req.repoRoot,
      args,
      stdin: viaArgv ? undefined : prompt.user,
      signal: req.signal,
      progress,
      starting: `Starting Claude Code${model ? ` with ${model}` : ''}…`,
      working: (m) => `Claude Code is reading the change${m ? ` with ${m}` : ''}…`,
      // The long quiet stretch before the answer: say something rather than freeze on the last file read.
      thinking: 'Thinking about how the pieces fit…',
      writing: 'Writing the review graph…',
      contract: 'review-graph contract',
    });

    progress('Checking the graph against the contract…');
    const raw = extractGraphJson(result);
    const usedModel = initModel ?? model ?? firstKey(result.modelUsage);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      // Facts the host owns are set here rather than trusted from the model.
      const g = raw as Partial<ReviewGraph>;
      g.pr = { title: req.prTitle, base: req.base, head: req.head };
      g.generatedBy = { provider: this.id, ...(usedModel ? { model: usedModel } : {}), at: new Date().toISOString() };
    }
    // The CLI runs with cwd = the repo, so the agent's absolute paths come out symlink-resolved:
    // rebase them against the real root, not the path we were given.
    const v = validateGraph(raw, { readFile: repoReader(req.repoRoot), repair: true, repoRoot: realpathSync(req.repoRoot) });
    if (!v.ok) {
      throw new ProviderError('contract', `Claude Code's graph broke the contract (${v.errors.length} problem${v.errors.length === 1 ? '' : 's'}).`, v.errors.join('\n'));
    }
    return { graph: v.graph, warnings: [...prompt.warnings, ...v.warnings], ...usage(result) };
  }

  /**
   * Spawns the CLI, streams progress, refuses a CLI that offers forbidden tools, and returns the
   * successful result message. Every other outcome is a ProviderError of the matching kind.
   */
  private async execute(s: RunSpec): Promise<RunOutcome> {
    const { claudePath, maxBudgetUsd, timeoutSeconds } = this.opts;
    // Our own controller, so we can also stop the run when the CLI misbehaves (e.g. offers Bash).
    const stop = new AbortController();
    const forward = () => stop.abort();
    if (s.signal?.aborted) throw new ProviderError('cancelled', 'Cancelled.');
    // spawn reports a missing cwd as ENOENT too, which would read as "CLI not installed".
    if (!existsSync(s.repoRoot)) throw new ProviderError('failed', `Repository folder not found: ${s.repoRoot}`);
    s.signal?.addEventListener('abort', forward, { once: true });

    let result: CliResult | undefined;
    let initModel: string | undefined;
    let refused: string[] | undefined;
    const unparsed: string[] = [];
    s.progress(s.starting);

    let run: RunResult;
    try {
      run = await runProcess({
        command: claudePath,
        args: s.args,
        cwd: s.repoRoot,
        env: childEnv(process.env, this.opts.env),
        stdin: s.stdin,
        timeoutMs: timeoutSeconds * 1000,
        signal: stop.signal,
        onLine: (line) => {
          this.opts.onRawLine?.(line);
          const msg = parseLine(line);
          if (!msg) {
            if (line.trim() && unparsed.length < 2000) unparsed.push(line);
            return;
          }
          if (msg.type === 'result') {
            result = msg as unknown as CliResult;
          } else if (msg.type === 'system' && msg.subtype === 'init') {
            if (typeof msg.model === 'string') initModel = msg.model;
            const tools = Array.isArray(msg.tools) ? msg.tools.map(String) : [];
            const bad = tools.filter((t) => FORBIDDEN_TOOL.test(t));
            if (bad.length) {
              refused = bad;
              stop.abort();
              return;
            }
            s.progress(s.working(initModel));
          } else if (msg.type === 'system' && msg.subtype === 'thinking_tokens') {
            s.progress(s.thinking);
          } else {
            for (const p of progressFor(msg, s.repoRoot, s.writing)) s.progress(p);
          }
        },
      });
    } finally {
      s.signal?.removeEventListener('abort', forward);
    }

    if (refused) {
      throw new ProviderError('failed', `Refusing to run: Claude Code offered tools Filos never allows (${refused.join(', ')}).`, 'The CLI did not honour --tools. Update Claude Code, or check managed settings.');
    }
    if (s.signal?.aborted) throw new ProviderError('cancelled', 'Cancelled.');
    this.throwIfNotRun(run, timeoutSeconds);

    // A CLI or wrapper that printed one pretty-printed JSON object instead of JSON lines.
    if (!result && unparsed.length) {
      const whole = parseLine(unparsed.join('\n'));
      if (whole?.type === 'result') result = whole as unknown as CliResult;
    }
    if (!result && run.exitCode === 0) {
      throw new ProviderError('failed', 'Claude Code exited without a result.', tail(unparsed.join('\n') + '\n' + run.stderrTail));
    }
    const failure = classifyFailure({ result, exitCode: run.exitCode, stderr: run.stderrTail || unparsed.join('\n'), maxBudgetUsd, contract: s.contract });
    if (failure) throw failure;
    return { result: result!, initModel };
  }

  /** Errors that mean the CLI never ran to completion: missing binary, timeout, cancel, overflow. */
  private throwIfNotRun(run: RunResult, timeoutSeconds: number) {
    if (run.spawnError) {
      const code = run.spawnError.code;
      if (code === 'ENOENT' || code === 'EACCES') {
        const hint = offPathHint(this.opts.claudePath, 'filos.claude.path', { env: childEnv(process.env, this.opts.env) });
        throw new ProviderError('notInstalled', `Claude Code CLI not found at "${this.opts.claudePath}". Install it, or set filos.claude.path.${hint}`, run.spawnError.message);
      }
      throw new ProviderError('failed', `Could not start Claude Code: ${run.spawnError.message}`);
    }
    if (run.aborted) throw new ProviderError('cancelled', 'Cancelled.');
    if (run.timedOut) throw new ProviderError('timeout', `Claude Code did not finish within ${timeoutSeconds}s.`, tail(run.stderrTail));
    if (run.overflow) throw new ProviderError('failed', 'Claude Code produced more output than Filos accepts; stopped it.', tail(run.stderrTail));
  }
}

/** Cost and duration as the CLI reported them, when it did. */
function usage(result: CliResult): { costUsd?: number; durationMs?: number } {
  return {
    costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined,
    durationMs: typeof result.duration_ms === 'number' ? result.duration_ms : undefined,
  };
}

type Msg = Record<string, unknown> & { type?: unknown; subtype?: unknown };

function parseLine(line: string): Msg | undefined {
  const t = line.trim();
  if (!t.startsWith('{')) return undefined;
  try {
    const v: unknown = JSON.parse(t);
    return isRecord(v) ? (v as Msg) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Human-readable progress for the loading view, from the agent's tool calls. Every part is
 * agent-controlled, so each message goes through safeProgressText before anyone sees it.
 */
export function progressFor(msg: Msg, repoRoot: string, writing = 'Writing the review graph…'): string[] {
  if (msg.type !== 'assistant' || !isRecord(msg.message) || !Array.isArray(msg.message.content)) return [];
  const out: string[] = [];
  for (const block of msg.message.content) {
    if (!isRecord(block) || block.type !== 'tool_use') continue;
    const input = isRecord(block.input) ? block.input : {};
    const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
    switch (block.name) {
      case 'Read':
        out.push(`Reading ${shortPath(str('file_path'), repoRoot)}`);
        break;
      case 'Grep':
        out.push(`Searching for “${str('pattern').slice(0, 60)}”`);
        break;
      case 'Glob':
        out.push(`Listing ${str('pattern').slice(0, 60)}`);
        break;
      case 'StructuredOutput':
        out.push(writing);
        break;
      default:
        if (typeof block.name === 'string') out.push(`Using ${block.name}`);
    }
  }
  return out.map((m) => safeProgressText(m));
}

/** Repo-relative path for display; never a path outside the repo, which could be anything. */
function shortPath(p: string, root: string): string {
  if (!p) return 'a file';
  const rel = relative(root, resolve(root, p));
  const inside = rel !== '' && rel.split(sep)[0] !== '..' && !isAbsolute(rel);
  return inside ? rel.split(sep).join('/') : 'a file outside the repo';
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const firstKey = (o: Record<string, unknown> | undefined) => (o ? Object.keys(o)[0] : undefined);
const tail = (s: string, n = 4000) => (s.length > n ? '…' + s.slice(-n) : s).trim();
