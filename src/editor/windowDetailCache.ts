/** A small LRU whose admission and eviction policy is based on retained bytes. */
export class ByteBoundedLru<T> {
    private readonly entries = new Map<string, { value: T; bytes: number }>();
    private retainedBytes = 0;

    constructor(private readonly maxBytes: number) { }

    get sizeBytes(): number {
        return this.retainedBytes;
    }

    get size(): number {
        return this.entries.size;
    }

    get(key: string): T | undefined {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    set(key: string, value: T, bytes: number): boolean {
        const safeBytes = Math.max(0, Math.floor(bytes));
        if (safeBytes > this.maxBytes) return false;
        const previous = this.entries.get(key);
        if (previous) {
            this.retainedBytes -= previous.bytes;
            this.entries.delete(key);
        }
        this.entries.set(key, { value, bytes: safeBytes });
        this.retainedBytes += safeBytes;
        while (this.retainedBytes > this.maxBytes) {
            const oldest = this.entries.entries().next().value as [string, { value: T; bytes: number }] | undefined;
            if (!oldest) break;
            this.entries.delete(oldest[0]);
            this.retainedBytes -= oldest[1].bytes;
        }
        return true;
    }

    clear(): void {
        this.entries.clear();
        this.retainedBytes = 0;
    }
}
