/**
 * Deterministic reduction of per-block partial sums.
 *
 * Floating-point addition is not associative, so a sum that depends on how
 * spins were tiled, or on the order workers finished, changes in the last bits
 * from run to run — enough to break bit-reproducible agent loops and gradient
 * checks. Spins are therefore grouped into canonical blocks of fixed size in a
 * canonical order; every block's partial is computed the same way wherever it
 * runs, and partials combine in one fixed binary tree over block ids. Tiles are
 * unions of whole blocks, so the result is independent of tile size, worker
 * count and memory budget.
 */

/** Spins per canonical reduction block. */
export const CANONICAL_BLOCK_SPINS = 4096;

/** Number of canonical blocks covering `spinCount` spins. */
export function canonicalBlockCount(spinCount: number): number {
    return Math.ceil(spinCount / CANONICAL_BLOCK_SPINS);
}

/**
 * Combines equal-length vectors addressed by leaf index, in any arrival order,
 * as the fixed binary tree over leaves 0..n−1 (a missing right subtree passes
 * the left through). Siblings combine as soon as both exist, so memory stays
 * near O(log n) vectors when leaves arrive roughly in order.
 */
export class TreeReducer {
    private readonly nodes = new Map<string, Float64Array>();
    private readonly seen: Uint8Array;
    private received = 0;

    constructor(private readonly leafCount: number, private readonly width: number) {
        if (!(leafCount >= 1)) throw new Error('TreeReducer needs at least one leaf');
        this.seen = new Uint8Array(leafCount);
    }

    /** Add leaf `index`; the reducer takes ownership of `vector`. */
    add(index: number, vector: Float64Array): void {
        if (index < 0 || index >= this.leafCount || !Number.isInteger(index)) {
            throw new RangeError(`leaf ${index} out of range [0, ${this.leafCount})`);
        }
        if (vector.length !== this.width) throw new Error(`leaf width ${vector.length} != ${this.width}`);
        if (this.seen[index]) throw new Error(`leaf ${index} added twice`);
        this.seen[index] = 1;
        this.received++;
        let level = 0;
        let position = index;
        let value = vector;
        for (;;) {
            const siblingPosition = position ^ 1;
            const levelSize = Math.ceil(this.leafCount / 2 ** level);
            if (levelSize === 1) {
                this.nodes.set(`${level}:${position}`, value);
                return;
            }
            if (siblingPosition >= levelSize) {
                // No right sibling at this level: pass straight up.
                level++;
                position >>= 1;
                continue;
            }
            const siblingKey = `${level}:${siblingPosition}`;
            const sibling = this.nodes.get(siblingKey);
            if (!sibling) {
                this.nodes.set(`${level}:${position}`, value);
                return;
            }
            this.nodes.delete(siblingKey);
            const left = position < siblingPosition ? value : sibling;
            const right = position < siblingPosition ? sibling : value;
            for (let i = 0; i < this.width; i++) left[i] = left[i] + right[i];
            value = left;
            level++;
            position >>= 1;
        }
    }

    get complete(): boolean {
        return this.received === this.leafCount;
    }

    /** The total; every leaf must have been added. */
    result(): Float64Array {
        if (!this.complete) throw new Error(`only ${this.received} of ${this.leafCount} leaves added`);
        let level = 0;
        while (Math.ceil(this.leafCount / 2 ** level) > 1) level++;
        const root = this.nodes.get(`${level}:0`);
        if (!root) throw new Error('internal: reduction root missing');
        return root;
    }
}
