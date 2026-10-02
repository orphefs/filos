// Usage: npx tsx scripts/validate-graph.ts <graph.json> [--repo <head-tree-dir>]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateGraph } from '../src/contract/validate';

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error('usage: validate-graph <graph.json> [--repo <dir>]');
  process.exit(2);
}
const repoIdx = rest.indexOf('--repo');
const repo = repoIdx >= 0 ? rest[repoIdx + 1] : undefined;

const result = validateGraph(JSON.parse(readFileSync(file, 'utf8')), {
  readFile: repo ? (p) => (existsSync(join(repo, p)) ? readFileSync(join(repo, p), 'utf8') : undefined) : undefined,
});
for (const w of result.warnings) console.warn(`warning: ${w}`);
if (!result.ok) {
  for (const e of result.errors) console.error(`error: ${e}`);
  process.exit(1);
}
console.log(`ok: ${result.graph.nodes.length} nodes, ${result.graph.edges.length} edges, ${result.graph.files.length} file outlines`);
