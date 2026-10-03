// Checks a question set against the question-set contract and the graph it is about.
//
//   npx tsx scripts/validate-questions.ts <questions.json> --graph <graph.json> [--repo <head-tree-dir>] [--repair]
//
// With --repo, comment seeds are checked against the head files (file exists, line in range).
// --repair applies the repairs used on agent output instead of failing on them.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateGraph } from '../src/contract/validate';
import { validateQuestionSet } from '../src/contract/validateQuestions';

const [file, ...rest] = process.argv.slice(2);
const flag = (name: string) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
const graphFile = flag('--graph');
if (!file || !graphFile) {
  console.error('usage: validate-questions <questions.json> --graph <graph.json> [--repo <dir>] [--repair]');
  process.exit(2);
}
const repo = flag('--repo');
const readFile = repo ? (p: string) => (existsSync(join(repo, p)) ? readFileSync(join(repo, p), 'utf8') : undefined) : undefined;

const graph = validateGraph(JSON.parse(readFileSync(graphFile, 'utf8')), { readFile });
if (!graph.ok) {
  for (const e of graph.errors) console.error(`graph error: ${e}`);
  process.exit(1);
}
const result = validateQuestionSet(JSON.parse(readFileSync(file, 'utf8')), graph.graph, { readFile, repair: rest.includes('--repair') });
for (const w of result.warnings) console.warn(`warning: ${w}`);
if (!result.ok) {
  for (const e of result.errors) console.error(`error: ${e}`);
  process.exit(1);
}
const count = (d: string) => result.value.questions.filter((q) => q.depth === d).length;
console.log(`ok: ${result.value.questions.length} questions (skim ${count('skim')}, standard +${count('standard')}, deep +${count('deep')}), proposed depth ${result.value.depth.proposed}`);
