// Didactic mode's fog of war, from the review snapshot. Territories (top-level modules) still
// unexplored are fogged: drawn with their name only and not openable. Externals stay visible but
// dimmed until a territory they're linked to is explored. Fast mode has no fog.

import { GraphIndex, isRevealed } from '../review/order';
import type { ReviewSnapshot } from '../review/types';

export interface Fog {
  /** Didactic mode is on (there may still be nothing fogged, once everything is explored). */
  on: boolean;
  /** Unexplored territories. */
  fogged: ReadonlySet<string>;
  /** Externals not revealed yet. */
  dimmed: ReadonlySet<string>;
  /** Changes whenever the picture must change. */
  key: string;
}

export const NO_FOG: Fog = Object.freeze({ on: false, fogged: new Set<string>(), dimmed: new Set<string>(), key: 'off' });

export function computeFog(index: GraphIndex | undefined, review: ReviewSnapshot | undefined): Fog {
  if (!index || review?.mode !== 'didactic') return NO_FOG;
  const explored = new Set(review.territories.filter((t) => t.explored).map((t) => t.nodeId));
  const fogged = new Set(index.territories.map((t) => t.id).filter((id) => !explored.has(id)));
  const dimmed = new Set(index.graph.nodes.filter((n) => n.kind === 'external' && !isRevealed(index, explored, n.id)).map((n) => n.id));
  return { on: true, fogged, dimmed, key: `on|${[...fogged].sort().join(',')}|${[...dimmed].sort().join(',')}` };
}

/** Inside a fogged territory (but not the territory itself): not drawn at all. */
export function hiddenByFog(index: GraphIndex | undefined, fog: Fog, id: string): boolean {
  if (!fog.fogged.size || !index) return false;
  const t = index.territoryOf(id);
  return !!t && t !== id && fog.fogged.has(t);
}

/** Can be selected (summary shown, code opened): not fogged, not hidden in fog, not dimmed. */
export function selectable(index: GraphIndex | undefined, fog: Fog, id: string): boolean {
  return !fog.fogged.has(id) && !fog.dimmed.has(id) && !hiddenByFog(index, fog, id);
}
