// Deterministic risk score from countable signals. Provisional weights: downstream impact
// (external consumers) dominates, the agent's judgement is a damped minority input.

import type { GraphNode, ReviewGraph, RiskSignals } from './graph';

export interface RiskContribution {
  signal: keyof RiskSignals | 'judgement';
  points: number;
  label: string;
}

export interface RiskScore {
  /** 0..1 — drives the red tint. */
  level: number;
  band: 'low' | 'medium' | 'high';
  contributions: RiskContribution[];
  /** Set when a parent's level was raised to match this descendant. */
  inheritedFrom?: string;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function scoreRisk(signals: RiskSignals, judgement?: number): RiskScore {
  const c: RiskContribution[] = [];
  const add = (signal: RiskContribution['signal'], points: number, label: string) => {
    if (points > 0) c.push({ signal, points, label });
  };

  if (signals.externalConsumers) {
    add('externalConsumers', 0.4 * clamp01(signals.externalConsumers / 3), `${signals.externalConsumers} external consumer${signals.externalConsumers === 1 ? '' : 's'}`);
  }
  if (signals.publicApi) add('publicApi', 0.1, 'public API');
  if (signals.internalFanOut) {
    add('internalFanOut', 0.15 * clamp01(signals.internalFanOut / 10), `${signals.internalFanOut} in-repo caller${signals.internalFanOut === 1 ? '' : 's'}`);
  }
  if (signals.behaviourChange) add('behaviourChange', 0.15, 'behaviour change');
  if (signals.hasTests === false) add('hasTests', 0.1, 'no tests');
  if (signals.linesChanged) add('linesChanged', 0.05 * clamp01(signals.linesChanged / 200), `${signals.linesChanged} lines changed`);
  if (judgement !== undefined) add('judgement', 0.15 * clamp01(judgement), 'agent judgement');

  const level = clamp01(c.reduce((s, x) => s + x.points, 0));
  return { level, band: level >= 0.55 ? 'high' : level >= 0.25 ? 'medium' : 'low', contributions: c };
}

/** Risk per node id. A parent is at least as risky as its riskiest descendant. */
export function scoreGraph(graph: ReviewGraph): Map<string, RiskScore> {
  const scores = new Map<string, RiskScore>();
  for (const n of graph.nodes) scores.set(n.id, scoreRisk(n.risk.signals, n.risk.judgement));

  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const depth = (n: GraphNode): number => (n.parent && byId.has(n.parent) ? 1 + depth(byId.get(n.parent)!) : 0);
  // Deepest first, so risk bubbles all the way up.
  for (const n of [...graph.nodes].sort((a, b) => depth(b) - depth(a))) {
    if (!n.parent) continue;
    const child = scores.get(n.id)!;
    const parent = scores.get(n.parent);
    if (parent && child.level > parent.level) {
      scores.set(n.parent, { level: child.level, band: child.band, contributions: parent.contributions, inheritedFrom: child.inheritedFrom ?? n.id });
    }
  }
  return scores;
}
