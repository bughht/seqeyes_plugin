/**
 * Unit tests for the webview preferences gateway.
 *
 * The shipped `prefs.js` is run in a bare VM context against a stub storage,
 * so these exercise the file the bundle actually carries rather than a
 * re-implementation of it.  The behaviour worth pinning is the consent gate:
 * a user who turns persistence off must get nothing written, everything
 * already written thrown away, and controls that still work for the session.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { loadWebviewAssets } from '../pulseq/blockTransportFixtures';

interface PrefsApi {
    KEYS: Record<string, string>;
    ASC_MAX_CHARS: number;
    enabled(): boolean;
    setEnabled(on: boolean): boolean;
    get(key: string): string | null;
    set(key: string, value: unknown): boolean;
    remove(key: string): void;
    getNum(key: string, fallback: number): number;
    getBool(key: string, fallback: boolean): boolean;
    setBool(key: string, value: boolean): boolean;
    getEnum(key: string, allowed: string[], fallback: string): string;
    storedKeys(): string[];
    forget(): void;
    setAsc(name: string, text: string): boolean;
    getAsc(): { name: string; text: string } | null;
    clearAsc(): void;
}

/** Enough of the Storage interface for prefs.js, plus an optional byte cap. */
class StubStorage {
    readonly map = new Map<string, string>();
    quota = Infinity;

    get length(): number { return this.map.size; }
    key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
    getItem(key: string): string | null { return this.map.has(key) ? this.map.get(key)! : null; }
    removeItem(key: string): void { this.map.delete(key); }
    setItem(key: string, value: string): void {
        let used = 0;
        for (const [k, v] of this.map) if (k !== key) used += k.length + v.length;
        if (used + key.length + value.length > this.quota) {
            const err = new Error('QuotaExceededError');
            err.name = 'QuotaExceededError';
            throw err;
        }
        this.map.set(key, String(value));
    }
}

function loadPrefs(storage: StubStorage | null): PrefsApi {
    return loadWebviewAssets<{ SeqEyesPrefs: PrefsApi }>(
        ['prefs.js'],
        storage ? { localStorage: storage } : {},
    ).SeqEyesPrefs;
}

describe('SeqEyesPrefs', () => {
    let storage: StubStorage;
    let prefs: PrefsApi;

    beforeEach(() => {
        storage = new StubStorage();
        prefs = loadPrefs(storage);
    });

    describe('reading and writing', () => {
        it('persists by default, so existing users keep the persistence they have', () => {
            expect(prefs.enabled()).toBe(true);
            prefs.set(prefs.KEYS.timeUnit, 'us');
            expect(storage.getItem(prefs.KEYS.timeUnit)).toBe('us');
            expect(prefs.get(prefs.KEYS.timeUnit)).toBe('us');
        });

        it('reports a missing key as null rather than as an empty string', () => {
            expect(prefs.get('seqeyes.nothing')).toBeNull();
        });

        it('falls back when a number or boolean key is absent or unparseable', () => {
            expect(prefs.getNum('seqeyes.absent', 7)).toBe(7);
            storage.setItem('seqeyes.bad', 'not a number');
            expect(prefs.getNum('seqeyes.bad', 7)).toBe(7);
            expect(prefs.getBool('seqeyes.absent', true)).toBe(true);
            prefs.setBool('seqeyes.flag', false);
            expect(prefs.getBool('seqeyes.flag', true)).toBe(false);
        });

        it('rejects a stored value the control could not display', () => {
            storage.setItem(prefs.KEYS.gradUnit, 'furlongs/fortnight');
            expect(prefs.getEnum(prefs.KEYS.gradUnit, ['Hz/m', 'mT/m', 'G/cm'], 'Hz/m')).toBe('Hz/m');
            storage.setItem(prefs.KEYS.gradUnit, 'mT/m');
            expect(prefs.getEnum(prefs.KEYS.gradUnit, ['Hz/m', 'mT/m', 'G/cm'], 'Hz/m')).toBe('mT/m');
        });

        it('survives a host with no storage at all', () => {
            const noStorage = loadPrefs(null);
            expect(noStorage.enabled()).toBe(true);
            expect(() => noStorage.set(noStorage.KEYS.theme, 'nord')).not.toThrow();
            // Still readable for this session even though nothing was written.
            expect(noStorage.get(noStorage.KEYS.theme)).toBe('nord');
            expect(noStorage.storedKeys()).toEqual([]);
        });
    });

    describe('the consent gate', () => {
        it('purges what is already stored when the user opts out', () => {
            prefs.set(prefs.KEYS.theme, 'nord');
            prefs.set(prefs.KEYS.timeUnit, 'us');
            expect(prefs.storedKeys().sort()).toEqual([prefs.KEYS.theme, prefs.KEYS.timeUnit].sort());

            prefs.setEnabled(false);
            expect(prefs.enabled()).toBe(false);
            expect(prefs.storedKeys()).toEqual([]);
        });

        it('keeps the refusal itself, which the purge would otherwise erase', () => {
            prefs.setEnabled(false);
            expect(storage.getItem(prefs.KEYS.remember)).toBe('0');
            // A fresh load of the module must still see the "no".
            expect(loadPrefs(storage).enabled()).toBe(false);
        });

        it('keeps controls working while persisting nothing', () => {
            prefs.setEnabled(false);
            prefs.set(prefs.KEYS.gradUnit, 'G/cm');
            expect(prefs.get(prefs.KEYS.gradUnit)).toBe('G/cm');
            expect(storage.getItem(prefs.KEYS.gradUnit)).toBeNull();
        });

        it('writes the session through when the user opts back in', () => {
            prefs.setEnabled(false);
            prefs.set(prefs.KEYS.gradUnit, 'G/cm');
            prefs.setEnabled(true);
            expect(storage.getItem(prefs.KEYS.gradUnit)).toBe('G/cm');
        });

        it('forgets the in-memory shadow too, so a reload really starts clean', () => {
            prefs.set(prefs.KEYS.theme, 'dracula');
            prefs.forget();
            expect(prefs.get(prefs.KEYS.theme)).toBeNull();
            expect(prefs.storedKeys()).toEqual([]);
            expect(prefs.enabled()).toBe(true);   // forgetting is not opting out
        });

        it('leaves keys belonging to other applications alone', () => {
            storage.setItem('somethingElse', 'keep me');
            prefs.set(prefs.KEYS.theme, 'nord');
            prefs.forget();
            expect(storage.getItem('somethingElse')).toBe('keep me');
        });
    });

    describe('the ASC cache', () => {
        it('round-trips a profile', () => {
            expect(prefs.setAsc('gradient.asc', 'ASCCONV BEGIN')).toBe(true);
            expect(prefs.getAsc()).toEqual({ name: 'gradient.asc', text: 'ASCCONV BEGIN' });
        });

        it('refuses a file too large to be a gradient profile', () => {
            const huge = 'x'.repeat(prefs.ASC_MAX_CHARS + 1);
            expect(prefs.setAsc('huge.asc', huge)).toBe(false);
            expect(prefs.getAsc()).toBeNull();
            expect(storage.getItem(prefs.KEYS.ascText)).toBeNull();
        });

        it('replaces a stored profile rather than leaving the old text behind', () => {
            prefs.setAsc('first.asc', 'one');
            prefs.setAsc('second.asc', 'two');
            expect(prefs.getAsc()).toEqual({ name: 'second.asc', text: 'two' });
        });

        it('reports nothing when only half the pair survived', () => {
            prefs.setAsc('gradient.asc', 'ASCCONV BEGIN');
            storage.removeItem(prefs.KEYS.ascText);
            // A name with no text would restore a button labelled for a profile
            // that cannot be parsed back.
            expect(prefs.getAsc()).toBeNull();
        });

        it('says the write did not stick when the quota refuses it', () => {
            storage.quota = 64;
            expect(prefs.setAsc('gradient.asc', 'x'.repeat(200))).toBe(false);
            expect(storage.getItem(prefs.KEYS.ascText)).toBeNull();
        });

        it('clears both keys', () => {
            prefs.setAsc('gradient.asc', 'ASCCONV BEGIN');
            prefs.clearAsc();
            expect(prefs.getAsc()).toBeNull();
            expect(prefs.storedKeys()).toEqual([]);
        });
    });
});
