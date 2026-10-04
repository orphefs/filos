// Live smoke test of the Codex provider: one real comprehension pass over the tiny fixture repo,
// then one evaluateAnswer and one threadReply. Uses your Codex login (a ChatGPT plan reports no
// dollar cost; the calls count against its usage limits). Usage:
//   npx tsx scripts/smoke-codex.ts [--codex <path>] [--model <name>] [--use-user-config] [--out <dir>]
//                                  [--expect-model-error <model>]
// Default: --ignore-user-config and Codex's default model, as Filos runs it out of the box.
// --expect-model-error <model> adds one tiny evaluate call with that model and prints the error
// Codex gives (for a model the account can't use), to check how Filos reports it.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createProvider, ProviderError, type AgentProvider } from '../src/agent';
import { scoreGraph } from '../src/contract/risk';
import type { QuestionSet } from '../src/contract/questions';
import { evaluateAnswer, numberedExcerpt, threadReply } from '../src/agent/tasks';

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const fixture = resolve(__dirname, '../test/fixtures/fake-claude');
const repo = join(fixture, 'repo');
const codexPath = arg('--codex', 'codex')!;
const model = arg('--model');
const useUserConfig = process.argv.includes('--use-user-config');
const expectModelError = arg('--expect-model-error');
const out = resolve(arg('--out', join(tmpdir(), `filos-smoke-codex-${Date.now()}`))!);
mkdirSync(out, { recursive: true });

const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}`);

function provider(raw: string[], m = model): AgentProvider {
  return createProvider({ id: 'codex', codexPath, model: m, useUserConfig, timeoutSeconds: 600, onRawLine: (l) => raw.push(l) });
}

/** What the run's commands were (from the raw events), to check they were read-only and in the repo. */
function commands(raw: string[]): string[] {
  const seen: string[] = [];
  for (const l of raw) {
    try {
      const e = JSON.parse(l) as { type?: string; item?: { type?: string; command?: string; exit_code?: number | null } };
      if (e.type === 'item.completed' && e.item?.type === 'command_execution') seen.push(`${e.item.command} (exit ${e.item.exit_code})`);
    } catch {
      // not an event
    }
  }
  return seen;
}

function report(err: unknown, step: string, raw: string[]) {
  writeFileSync(join(out, `${step}-failed.jsonl`), raw.join('\n'));
  if (err instanceof ProviderError) {
    log(`${step} FAILED kind=${err.kind}: ${err.message}`);
    if (err.detail) console.log(err.detail);
  } else {
    console.error(err);
  }
}

async function main() {
  log(`codex=${codexPath} model=${model ?? '(Codex default)'} config=${useUserConfig ? 'user config' : '--ignore-user-config'}`);
  const raw: string[] = [];
  const p = provider(raw);
  await p.checkReady();
  log('checkReady: logged in');

  // 1. Comprehension pass.
  let ok = true;
  try {
    const res = await p.comprehend({
      repoRoot: repo,
      diff: readFileSync(join(fixture, 'change.diff'), 'utf8'),
      base: 'main',
      head: 'bankers-rounding',
      prTitle: "Use banker's rounding for cents",
      dependencyIndex: readFileSync(join(fixture, 'deps.txt'), 'utf8'),
      onProgress: (m) => log(`progress: ${m}`),
    });
    writeFileSync(join(out, 'graph.json'), JSON.stringify(res.graph, null, 2));
    writeFileSync(join(out, 'comprehend.jsonl'), raw.join('\n'));
    const scores = scoreGraph(res.graph);
    log('VALID graph (passed validateGraph against the repo)');
    console.log(
      JSON.stringify(
        {
          durationMs: res.durationMs,
          tokens: res.tokens,
          generatedBy: res.graph.generatedBy,
          warnings: res.warnings,
          repairs: res.warnings.filter((w) => w.startsWith('repaired')).length,
          commands: commands(raw),
          nodes: res.graph.nodes.map((n) => `${n.id} [${n.kind}/${n.change}] risk=${scores.get(n.id)!.level.toFixed(2)} anchors=${n.anchors.map((a) => `${a.file}:${a.startLine}-${a.endLine}`).join(',')}`),
          edges: res.graph.edges.map((e) => `${e.from} -${e.kind}-> ${e.to}`),
          files: res.graph.files.map((f) => `${f.path}: ${f.regions.map((r) => `${r.startLine}-${r.endLine} ${r.gist}`).join(' | ')}`),
          orientation: res.graph.orientation,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    report(err, 'comprehend', raw);
    ok = false;
  }

  // 2. evaluateAnswer (no tools).
  const questions = JSON.parse(readFileSync(join(fixture, 'questions.json'), 'utf8')) as QuestionSet;
  const question = questions.questions.find((q) => q.id === 'q-money-roundToCents-ties')!;
  const code = numberedExcerpt('money/round.ts', readFileSync(join(repo, 'money/round.ts'), 'utf8'));
  raw.length = 0;
  try {
    const res = await evaluateAnswer(p, { repoRoot: repo, question, nodeSummary: 'roundToCents rounds an amount to whole cents; ties now go to the even cent.', codeExcerpt: code, answer: 'Exact ties now go half-even: line 11 picks the even neighbouring cent.', attempt: 1 });
    writeFileSync(join(out, 'evaluate.jsonl'), raw.join('\n'));
    log('evaluate: VALID');
    console.log(JSON.stringify({ durationMs: res.durationMs, tokens: res.tokens, warnings: res.warnings, commands: commands(raw), value: res.value }, null, 2));
  } catch (err) {
    report(err, 'evaluate', raw);
    ok = false;
  }

  // 3. threadReply (no tools).
  raw.length = 0;
  try {
    const res = await threadReply(p, {
      repoRoot: repo,
      comment: { file: 'money/round.ts', line: 10, body: 'Add a test.', severity: 'suggestion' },
      nodeSummary: 'roundToCents rounds an amount to whole cents; ties now go to the even cent.',
      codeExcerpt: code,
      thread: [],
      message: 'Can you make this comment more specific?',
    });
    writeFileSync(join(out, 'thread.jsonl'), raw.join('\n'));
    log('thread: VALID');
    console.log(JSON.stringify({ durationMs: res.durationMs, tokens: res.tokens, warnings: res.warnings, commands: commands(raw), value: res.value }, null, 2));
  } catch (err) {
    report(err, 'thread', raw);
    ok = false;
  }

  // 4. Optional: how Filos reports a model the account can't use.
  if (expectModelError) {
    const rawErr: string[] = [];
    try {
      await evaluateAnswer(provider(rawErr, expectModelError), { repoRoot: repo, question, nodeSummary: '', codeExcerpt: '', answer: 'half-even', attempt: 1 });
      log(`model ${expectModelError}: unexpectedly succeeded`);
    } catch (err) {
      writeFileSync(join(out, 'model-error.jsonl'), rawErr.join('\n'));
      if (err instanceof ProviderError) {
        log(`model ${expectModelError}: kind=${err.kind}`);
        console.log(JSON.stringify({ message: err.message, detail: err.detail, events: rawErr.filter((l) => /"type":"(error|turn\.failed)"/.test(l)) }, null, 2));
      } else {
        console.error(err);
      }
    }
  }

  log(`transcripts: ${out}`);
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
