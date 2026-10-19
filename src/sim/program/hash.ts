/**
 * Content hashing for cache keys. Two independent 53-bit cyrb53 lanes give a
 * ~106-bit digest, so distinct RF operators colliding is not a practical
 * concern. Numbers are hashed by their exact IEEE-754 bit patterns.
 */

export class ContentHasher {
    private h1a = 0xdeadbeef ^ 0x2a;
    private h2a = 0x41c6ce57 ^ 0x2a;
    private h1b = 0xdeadbeef ^ 0x7f4a7c15;
    private h2b = 0x41c6ce57 ^ 0x7f4a7c15;
    private readonly scratch = new Float64Array(1);
    private readonly scratchWords = new Uint32Array(this.scratch.buffer);

    /** Mix one unsigned 32-bit word. */
    word(value: number): this {
        const w = value >>> 0;
        this.h1a = Math.imul(this.h1a ^ w, 2654435761);
        this.h2a = Math.imul(this.h2a ^ w, 1597334677);
        this.h1b = Math.imul(this.h1b ^ w, 2246822507);
        this.h2b = Math.imul(this.h2b ^ w, 3266489909);
        return this;
    }

    /** Mix one double by its bit pattern (−0 and +0 hash differently). */
    number(value: number): this {
        this.scratch[0] = value;
        return this.word(this.scratchWords[0]).word(this.scratchWords[1]);
    }

    numbers(values: ArrayLike<number>): this {
        this.word(values.length);
        for (let i = 0; i < values.length; i++) this.number(values[i]);
        return this;
    }

    text(value: string): this {
        this.word(value.length);
        for (let i = 0; i < value.length; i++) this.word(value.charCodeAt(i));
        return this;
    }

    /** Hex digest; the hasher can keep absorbing afterwards. */
    digest(): string {
        return lane(this.h1a, this.h2a) + lane(this.h1b, this.h2b);
    }
}

function lane(h1in: number, h2in: number): string {
    let h1 = Math.imul(h1in ^ (h1in >>> 16), 2246822507);
    h1 ^= Math.imul(h2in ^ (h2in >>> 13), 3266489909);
    let h2 = Math.imul(h2in ^ (h2in >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return value.toString(16).padStart(14, '0');
}
