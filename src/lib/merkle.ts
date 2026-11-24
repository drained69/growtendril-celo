import { concat, keccak256, type Hex } from "viem";

const pair = (a: Hex, b: Hex) => keccak256(a.toLowerCase() < b.toLowerCase() ? concat([a, b]) : concat([b, a]));
/** Records are hashed once more, matching GrowthLedger, so a tree node can never pass as a record. */
const hashedLeaves = (leaves: readonly Hex[]) => [...new Set(leaves.map((leaf) => keccak256(leaf.toLowerCase() as Hex)))].sort();

function nextLayer(layer: Hex[]) {
  const next: Hex[] = [];
  for (let i = 0; i < layer.length; i += 2) next.push(i + 1 < layer.length ? pair(layer[i], layer[i + 1]) : layer[i]);
  return next;
}

/** Sorted-pair tree matching GrowthLedger.verifyRecord. Leaves are deduplicated and ordered first. */
export function merkleRoot(leaves: readonly Hex[]): Hex {
  let layer = hashedLeaves(leaves);
  if (!layer.length) throw new Error("A checkpoint needs at least one record");
  while (layer.length > 1) layer = nextLayer(layer);
  return layer[0];
}

export function merkleProof(leaves: readonly Hex[], leaf: Hex): Hex[] {
  let layer = hashedLeaves(leaves);
  let index = layer.indexOf(keccak256(leaf.toLowerCase() as Hex));
  if (index < 0) throw new Error("Record is not in this checkpoint");
  const proof: Hex[] = [];
  while (layer.length > 1) {
    const sibling = index % 2 ? index - 1 : index + 1;
    if (sibling < layer.length) proof.push(layer[sibling]);
    layer = nextLayer(layer);
    index = Math.floor(index / 2);
  }
  return proof;
}
