// Live smoke test of the Claude provider: one real comprehension pass over the tiny fixture repo.
// Costs real money (cents). Usage:
//   npx tsx scripts/smoke-claude.ts [--model sonnet] [--budget 0.5] [--claude <path>] [--out <dir>] [--argv]
// Retries up to 3 times, a minute apart, on the transient OAuth refresh error.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createProvider, ProviderError } from '../src/agent';
import { scoreGraph } from '../src/contract/risk';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const fixture = resolve(__dirname, '../test/fixtures/fake-claude');
const model = arg('--model', 'sonnet');
const budget = Number(arg('--budget', '0.5'));
const out = resolve(arg('--out', join(tmpdir(), `filos-smoke-${Date.now()}`)));
mkdirSync(out, { recursive: true });

const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}`);

async function main() {
  const raw: string[] = [];
  const provider = createProvider({
    id: 'claude',
    claudePath: arg('--claude', 'claude'),
    model,
    maxBudgetUsd: budget,
    timeoutSeconds: 300,
    promptVia: process.argv.includes('--argv') ? 'argv' : 'stdin',
    onRawLine: (l) => raw.push(l),
  });

  await provider.checkReady();
  log('checkReady: logged in');

  for (let attempt = 1; ; attempt++) {
    raw.length = 0;
    try {
      log(`attempt ${attempt}: model=${model} budget=$${budget}`);
      const res = await provider.comprehend({
        repoRoot: join(fixture, 'repo'),
        diff: readFileSync(join(fixture, 'change.diff'), 'utf8'),
        base: 'main',
        head: 'bankers-rounding',
        prTitle: "Use banker's rounding for cents",
        dependencyIndex: readFileSync(join(fixture, 'deps.txt'), 'utf8'),
        onProgress: (m) => log(`progress: ${m}`),
      });
      writeFileSync(join(out, 'graph.json'), JSON.stringify(res.graph, null, 2));
      writeFileSync(join(out, 'transcript.jsonl'), raw.join('\n'));
      const init = raw.map(tryJson).find((m) => m?.type === 'system' && m?.subtype === 'init');
      const scores = scoreGraph(res.graph);
      log('VALID graph (passed validateGraph against the repo)');
      console.log(
        JSON.stringify(
          {
            costUsd: res.costUsd,
            durationMs: res.durationMs,
            generatedBy: res.graph.generatedBy,
            toolsOffered: init?.tools,
            permissionMode: init?.permissionMode,
            nodes: res.graph.nodes.map((n) => `${n.id} [${n.kind}/${n.change}] risk=${scores.get(n.id)!.level.toFixed(2)} anchors=${n.anchors.map((a) => `${a.file}:${a.startLine}-${a.endLine}`).join(',')}`),
            edges: res.graph.edges.map((e) => `${e.from} -${e.kind}-> ${e.to}`),
            files: res.graph.files.map((f) => `${f.path}: ${f.regions.map((r) => `${r.startLine}-${r.endLine} ${r.gist}`).join(' | ')}`),
            orientation: res.graph.orientation,
            warnings: res.warnings,
            output: out,
          },
          null,
          2,
        ),
      );
      return;
    } catch (err) {
      writeFileSync(join(out, `transcript-attempt${attempt}.jsonl`), raw.join('\n'));
      if (err instanceof ProviderError) {
        log(`FAILED kind=${err.kind}: ${err.message}`);
        if (err.detail) console.log(err.detail);
        if (err.kind === 'authExpired' && /refresh/i.test(err.detail ?? '') && attempt < 4) {
          log('transient OAuth refresh error; waiting 60s before retrying');
          await new Promise((r) => setTimeout(r, 60_000));
          continue;
        }
      } else {
        console.error(err);
      }
      log(`transcript: ${out}`);
      process.exitCode = 1;
      return;
    }
  }
}

function tryJson(l: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(l) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

void main();
