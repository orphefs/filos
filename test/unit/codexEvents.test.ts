// codex exec --json events (src/agent/codexEvents.ts): progress text, token usage, forbidden items,
// error classification (with the real texts codex-cli 0.160.0 printed), and JSON in the answer.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addUsage,
  classifyCodexFailure,
  commandProgress,
  eventError,
  forbiddenItem,
  humanError,
  jsonFromText,
  parseEvent,
  progressForEvent,
  shellWords,
  unwrapShell,
  type CodexEvent,
} from '../../src/agent/codexEvents';
import { MAX_PROGRESS_CHARS } from '../../src/agent/progress';

const ROOT = '/work/repo';
const W = { thinking: 'Thinking about how the pieces fit…', writing: 'Writing the review graph…' };
const cmd = (command: string, type: 'item.started' | 'item.completed' = 'item.started'): CodexEvent => ({
  type,
  item: { id: 'item_1', type: 'command_execution', command, aggregated_output: '', exit_code: null, status: 'in_progress' },
});

/** The unsupported-model error exactly as the live smoke run got it (2026-10-04). */
const REAL_MODEL_ERROR =
  '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.3-codex\' model is not supported when using Codex with a ChatGPT account."}}';

describe('codex events: progress', () => {
  it('commands as codex wraps them: reading, searching, listing, anything else', () => {
    const cases: [string, string][] = [
      ["/bin/bash -lc 'sed -n 1,5p a.txt'", 'Reading a.txt'],
      ["/bin/bash -lc 'nl -ba money/round.ts && rg -n \"roundToCents|formatCents\" .'", 'Reading money/round.ts'],
      ["/bin/bash -lc \"cat 'checkout/total.ts'\"", 'Reading checkout/total.ts'],
      ["/bin/bash -lc 'head -n 40 ./money/round.ts'", 'Reading money/round.ts'],
      ["/bin/bash -lc 'tail -20 money/round.ts | nl'", 'Reading money/round.ts'],
      ["/bin/bash -lc \"sed -n '1,80p' money/round.ts\"", 'Reading money/round.ts'],
      ["/bin/bash -lc 'cat /etc/passwd'", 'Reading a file outside the repo'],
      ["/bin/bash -lc 'cat ../../secret.txt'", 'Reading a file outside the repo'],
      ['/bin/bash -lc \'rg -n "roundToCents" .\'', 'Searching for “roundToCents”'],
      ["/bin/bash -lc 'rg -g \"*.ts\" -n orderTotal'", 'Searching for “orderTotal”'],
      ["/bin/bash -lc 'grep -rn -e roundToCents money'", 'Searching for “roundToCents”'],
      ["/bin/bash -lc 'git grep -n tie'", 'Searching for “tie”'],
      ["/bin/bash -lc 'rg --files'", 'Listing files'],
      ["/bin/bash -lc 'ls -la money'", 'Listing files'],
      ["/bin/bash -lc 'find . -name \"*.ts\"'", 'Listing files'],
      ["/bin/bash -lc 'git log --oneline -5'", 'Running a read-only command'],
      ["/bin/bash -lc 'sed s/a/b/ money/round.ts'", 'Running a read-only command'],
      ["/bin/bash -lc 'cat'", 'Running a read-only command'],
      ['', 'Running a read-only command'],
    ];
    for (const [command, want] of cases) assert.equal(commandProgress(command, ROOT), want, command);
  });

  it('unwraps the shell and splits words like a shell (quotes, escapes)', () => {
    assert.equal(unwrapShell("/bin/bash -lc 'sed -n 1,5p a.txt'"), 'sed -n 1,5p a.txt');
    assert.equal(unwrapShell("/bin/bash -lc 'echo '\\''hi'\\'''"), "echo 'hi'");
    assert.equal(unwrapShell('zsh -c "rg -n \\"x\\" ."'), 'rg -n "x" .');
    assert.equal(unwrapShell('rg -n x'), 'rg -n x');
    assert.deepEqual(shellWords(`a 'b c' "d \\"e\\"" f\\ g`), ['a', 'b c', 'd "e"', 'f g']);
  });

  it('maps every event kind, through safeProgressText', () => {
    assert.equal(progressForEvent(cmd("/bin/bash -lc 'nl -ba money/round.ts'"), ROOT, W), 'Reading money/round.ts');
    assert.equal(progressForEvent(cmd("/bin/bash -lc 'nl -ba money/round.ts'", 'item.completed'), ROOT, W), W.thinking, 'after a command, it is thinking again');
    assert.equal(progressForEvent({ type: 'item.completed', item: { type: 'reasoning', text: '**Plan** [click](command:x)' } }, ROOT, W), W.thinking, 'reasoning text itself is never shown');
    assert.equal(progressForEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'I’ll read the touched file first.' } }, ROOT, W), W.thinking, 'commentary is not the answer');
    assert.equal(progressForEvent({ type: 'item.completed', item: { type: 'agent_message', text: '{"verdict":"correct"}' } }, ROOT, W), W.writing);
    assert.equal(progressForEvent({ type: 'item.completed', item: { type: 'agent_message', text: '```json\n{}\n```' } }, ROOT, W), W.writing);
    assert.equal(progressForEvent({ type: 'item.completed', item: { type: 'todo_list', items: [] } }, ROOT, W), 'Planning…');
    assert.equal(progressForEvent({ type: 'error', message: 'Reconnecting... 2/5 (stream disconnected)' }, ROOT, W), 'Reconnecting to Codex 2/5…');
    assert.equal(progressForEvent({ type: 'error', message: 'unexpected status 401' }, ROOT, W), undefined);
    for (const t of ['thread.started', 'turn.started', 'turn.completed']) assert.equal(progressForEvent({ type: t }, ROOT, W), undefined, t);
    assert.equal(progressForEvent({ type: 'item.completed', item: { type: 'error', message: 'Model metadata not found' } }, ROOT, W), undefined);
  });

  it('agent-controlled text cannot become a link, and is capped', () => {
    const m = progressForEvent(cmd(`/bin/bash -lc 'rg -n "[run](command:workbench.action.terminal.new)${'x'.repeat(200)}"'`), ROOT, W)!;
    assert.doesNotMatch(m, /[[\]()`]/);
    assert.ok(m.length <= MAX_PROGRESS_CHARS);
  });
});

describe('codex events: usage, items, answers', () => {
  it('tokens come from turn.completed (no cost), summed', () => {
    const e: CodexEvent = { type: 'turn.completed', usage: { input_tokens: 34672, cached_input_tokens: 22016, cache_write_input_tokens: 0, output_tokens: 1805, reasoning_output_tokens: 378 } };
    const one = addUsage(undefined, e);
    assert.deepEqual(one, { inputTokens: 34672, cachedInputTokens: 22016, outputTokens: 1805, reasoningOutputTokens: 378 });
    assert.deepEqual(addUsage(one, e)?.inputTokens, 69344);
    assert.equal(addUsage(undefined, { type: 'turn.started' }), undefined);
    assert.deepEqual(addUsage(undefined, { type: 'turn.completed', usage: { input_tokens: 'x' } }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });
  });

  it('forbidden items: edits, MCP, web, sub-agents always; commands only when the run has no tools', () => {
    for (const type of ['file_change', 'mcp_tool_call', 'web_search', 'collab_tool_call', 'image_generation', 'browser_navigate']) {
      assert.equal(forbiddenItem({ type }, 'read'), type);
    }
    assert.equal(forbiddenItem({ type: 'command_execution' }, 'read'), undefined);
    assert.equal(forbiddenItem({ type: 'command_execution' }, 'none'), 'command_execution');
    for (const type of ['agent_message', 'reasoning', 'todo_list', 'error']) assert.equal(forbiddenItem({ type }, 'none'), undefined);
  });

  it('error events: retries are not errors; turn.failed is final', () => {
    assert.equal(eventError({ type: 'error', message: 'Reconnecting... 1/5 (x)' }), undefined);
    assert.deepEqual(eventError({ type: 'error', message: 'boom' }), { message: 'boom', final: false });
    assert.deepEqual(eventError({ type: 'turn.failed', error: { message: 'boom' } }), { message: 'boom', final: true });
    assert.deepEqual(eventError({ type: 'turn.failed' }), { message: 'turn failed', final: true });
  });

  it('parses events and the answer (bare, fenced, or among text)', () => {
    assert.equal(parseEvent('not json'), undefined);
    assert.equal(parseEvent('[1]'), undefined);
    assert.deepEqual(parseEvent(' {"type":"turn.started"} '), { type: 'turn.started' });
    assert.deepEqual(jsonFromText('{"a":1}'), { a: 1 });
    assert.deepEqual(jsonFromText('Here:\n```json\n{"a":2}\n```\n'), { a: 2 });
    assert.deepEqual(jsonFromText('Answer: {"a":3} done'), { a: 3 });
    assert.equal(jsonFromText('no json here'), undefined);
    assert.equal(jsonFromText('"just a string"'), undefined);
  });
});

describe('codex events: classifyCodexFailure', () => {
  const base = { stderr: '', exitCode: 1, useUserConfig: false };

  it('the real unsupported-model error: failed, with the API message and how to fix it', () => {
    const e = classifyCodexFailure({ ...base, errors: [REAL_MODEL_ERROR, REAL_MODEL_ERROR], model: 'gpt-5.3-codex' });
    assert.equal(e.kind, 'failed');
    assert.equal(
      e.message,
      'Codex can\'t use the model "gpt-5.3-codex" with your account: The \'gpt-5.3-codex\' model is not supported when using Codex with a ChatGPT account. To fix it, set filos.codex.model to a model your account supports, or leave it empty for Codex’s default.',
    );
    assert.match(e.detail ?? '', /"status":400/);
  });

  it('the same error from ~/.codex/config.toml (no -m): names the model from the message and the useUserConfig fix', () => {
    const e = classifyCodexFailure({ ...base, errors: [REAL_MODEL_ERROR], useUserConfig: true });
    assert.equal(e.kind, 'failed');
    assert.match(e.message, /the model "gpt-5\.3-codex"/);
    assert.match(e.message, /set filos\.codex\.model to a model your account supports, or turn off filos\.codex\.useUserConfig so the model in ~\/\.codex\/config\.toml is ignored\.$/);
  });

  it('other model errors too', () => {
    for (const m of ['The model `o9-ultra` does not exist or you do not have access to it.', 'model_not_found', 'Unknown model: foo']) {
      const e = classifyCodexFailure({ ...base, errors: [m], model: 'foo' });
      assert.equal(e.kind, 'failed', m);
      assert.match(e.message, /To fix it, set filos\.codex\.model/, m);
    }
  });

  it('sign-in problems are authExpired', () => {
    const texts = [
      'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: a44f85d9fb3ef958-DUS, request id: req_f835b57dbb524caf8c2b5b756dca9dc9',
      'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
      'Not logged in. Run codex login.',
      'Provided authentication token is expired. Please try signing in again.',
    ];
    for (const t of texts) assert.equal(classifyCodexFailure({ ...base, errors: [t] }).kind, 'authExpired', t);
    // On stderr only, as the websocket attempts log it.
    assert.equal(classifyCodexFailure({ ...base, errors: [], stderr: 'ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized' }).kind, 'authExpired');
  });

  it('usage and rate limits are budget, with a Codex message (not a Filos cap)', () => {
    const texts = [
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:12 PM.",
      'exceeded retry limit, last status: 429 Too Many Requests',
      'Rate limit reached for gpt-5.5 in organization org-x on tokens per min.',
      '{"error":{"type":"insufficient_quota","message":"You exceeded your current quota."}}',
    ];
    for (const t of texts) {
      const e = classifyCodexFailure({ ...base, errors: [t] });
      assert.equal(e.kind, 'budget', t);
      assert.match(e.message, /^Codex hit a usage or rate limit of your account \(not a Filos cap\)/);
    }
  });

  it('a rejected output schema says so; anything else is failed with the readable first line', () => {
    const schema = classifyCodexFailure({ ...base, errors: ['{"type":"error","status":400,"error":{"code":"invalid_json_schema","message":"Invalid schema for response_format \'codex_output_schema\': bad"}}'] });
    assert.equal(schema.kind, 'failed');
    assert.match(schema.message, /^Codex rejected Filos's output schema: Invalid schema/);
    const crash = classifyCodexFailure({ ...base, exitCode: 101, errors: [], stderr: "thread 'main' panicked at core/src/x.rs:1:1:\nboom" });
    assert.equal(crash.kind, 'failed');
    assert.match(crash.message, /^Codex failed: thread 'main' panicked/);
    assert.match(crash.detail ?? '', /boom/);
    assert.equal(classifyCodexFailure({ ...base, errors: [] }).message, 'Codex failed: exit code 1');
  });

  it('humanError: the message inside an API error body', () => {
    assert.equal(humanError(REAL_MODEL_ERROR), "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.");
    assert.equal(humanError('{"error":{"message":"inner"}}'), 'inner');
    assert.equal(humanError('plain\nsecond'), 'plain');
    assert.equal(humanError('{not json'), '{not json');
  });
});
