/**
 * A small worker pool with one API over browser/Deno `Worker` and Node
 * `worker_threads` (adapters in ../platform). Isomorphic: no DOM or Node types.
 *
 * Protocol (main → worker):  { taskId, kind, payload }
 *          (worker → main):  { taskId, ok: true, result } | { taskId, ok: false, error }
 *
 * Bulk data travels as transferable ArrayBuffers, which every host supports
 * without cross-origin isolation (SharedArrayBuffer is not assumed: GitHub
 * Pages, VS Code webviews and MATLAB are not isolated). Results arrive in
 * whatever order workers finish; callers that need determinism reduce them by
 * task identity (see ../reduce.ts), never by arrival.
 */

/** Main-thread view of one worker. */
export interface WorkerPort {
    post(message: unknown, transfer: ArrayBuffer[]): void;
    /** Install handlers; called once, before the first post. */
    listen(onMessage: (data: unknown) => void, onError: (error: Error) => void): void;
    terminate(): void;
}

export type WorkerFactory = () => WorkerPort;

/** A task result plus the buffers to transfer back instead of copying. */
export interface TransferResult<T> {
    readonly __transfer: true;
    value: T;
    transfer: ArrayBuffer[];
}

export function withTransfer<T>(value: T, transfer: ArrayBuffer[]): TransferResult<T> {
    return { __transfer: true, value, transfer };
}

export class TaskAbortedError extends Error {
    constructor() {
        super('The task was cancelled.');
        this.name = 'TaskAbortedError';
    }
}

interface QueuedTask {
    taskId: number;
    kind: string;
    payload: unknown;
    transfer: ArrayBuffer[];
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    signal?: AbortSignalLike;
    onAbort?: () => void;
}

/** The subset of AbortSignal the pool uses (present in browsers, Node and Deno). */
export interface AbortSignalLike {
    readonly aborted: boolean;
    addEventListener(type: 'abort', listener: () => void): void;
    removeEventListener(type: 'abort', listener: () => void): void;
}

interface Slot {
    port: WorkerPort;
    task: QueuedTask | null;
}

export class WorkerPool {
    private readonly slots: Slot[] = [];
    private readonly queue: QueuedTask[] = [];
    private nextTaskId = 1;
    private closed = false;

    constructor(private readonly factory: WorkerFactory, size: number) {
        if (!(size >= 1) || !Number.isInteger(size)) throw new Error(`pool size must be a positive integer, got ${size}`);
        for (let i = 0; i < size; i++) this.slots.push(this.spawn());
    }

    get size(): number {
        return this.slots.length;
    }

    /** Queue a task; resolves with the handler's result (transferred buffers included). */
    run<T>(kind: string, payload: unknown, transfer: ArrayBuffer[] = [], signal?: AbortSignalLike): Promise<T> {
        if (this.closed) return Promise.reject(new Error('The worker pool is closed.'));
        if (signal?.aborted) return Promise.reject(new TaskAbortedError());
        return new Promise<T>((resolve, reject) => {
            const task: QueuedTask = {
                taskId: this.nextTaskId++,
                kind,
                payload,
                transfer,
                resolve: resolve as (value: unknown) => void,
                reject,
                signal,
            };
            if (signal) {
                task.onAbort = () => this.abort(task);
                signal.addEventListener('abort', task.onAbort);
            }
            this.queue.push(task);
            this.dispatch();
        });
    }

    /** Terminate every worker and reject queued and running tasks. */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        const error = new Error('The worker pool was closed.');
        for (const task of this.queue.splice(0)) this.settle(task, undefined, error);
        for (const slot of this.slots) {
            if (slot.task) this.settle(slot.task, undefined, error);
            slot.task = null;
            slot.port.terminate();
        }
    }

    private spawn(): Slot {
        const slot: Slot = { port: this.factory(), task: null };
        slot.port.listen(
            data => this.onReply(slot, data),
            error => this.onCrash(slot, error),
        );
        return slot;
    }

    private dispatch(): void {
        for (const slot of this.slots) {
            if (slot.task || !this.queue.length) continue;
            const task = this.queue.shift()!;
            slot.task = task;
            slot.port.post({ taskId: task.taskId, kind: task.kind, payload: task.payload }, task.transfer);
        }
    }

    private onReply(slot: Slot, data: unknown): void {
        const reply = data as { taskId?: number; ok?: boolean; result?: unknown; error?: string };
        const task = slot.task;
        if (!task || reply?.taskId !== task.taskId) return;   // late reply from an aborted task
        slot.task = null;
        if (reply.ok) this.settle(task, reply.result);
        else this.settle(task, undefined, new Error(reply.error ?? 'worker task failed'));
        this.dispatch();
    }

    private onCrash(slot: Slot, error: Error): void {
        const task = slot.task;
        slot.task = null;
        slot.port.terminate();
        if (task) this.settle(task, undefined, error);
        if (this.closed) return;
        const index = this.slots.indexOf(slot);
        if (index >= 0) this.slots[index] = this.spawn();
        this.dispatch();
    }

    private abort(task: QueuedTask): void {
        const queued = this.queue.indexOf(task);
        if (queued >= 0) {
            this.queue.splice(queued, 1);
            this.settle(task, undefined, new TaskAbortedError());
            return;
        }
        const slot = this.slots.find(s => s.task === task);
        if (!slot) return;
        // A running task cannot be interrupted cooperatively here; terminating
        // the worker frees its memory immediately, and a fresh one replaces it.
        slot.task = null;
        slot.port.terminate();
        this.settle(task, undefined, new TaskAbortedError());
        const index = this.slots.indexOf(slot);
        if (!this.closed) {
            this.slots[index] = this.spawn();
            this.dispatch();
        }
    }

    private settle(task: QueuedTask, value: unknown, error?: Error): void {
        if (task.signal && task.onAbort) task.signal.removeEventListener('abort', task.onAbort);
        if (error) task.reject(error);
        else task.resolve(value);
    }
}

// ─── Worker side ─────────────────────────────────────────────────────────

/** Worker-side view of its connection to the main thread. */
export interface WorkerSelfPort {
    post(message: unknown, transfer: ArrayBuffer[]): void;
    onMessage(handler: (data: unknown) => void): void;
}

export type TaskHandler = (payload: unknown) => unknown | Promise<unknown>;

/**
 * Answer pool tasks inside a worker. A handler returns a plain value, or
 * `withTransfer(value, buffers)` to hand buffers back without copying.
 */
export function serveWorkerTasks(port: WorkerSelfPort, handlers: Record<string, TaskHandler>): void {
    port.onMessage(async data => {
        const message = data as { taskId: number; kind: string; payload: unknown };
        try {
            const handler = handlers[message.kind];
            if (!handler) throw new Error(`unknown task kind '${message.kind}'`);
            const output = await handler(message.payload);
            if (isTransferResult(output)) {
                port.post({ taskId: message.taskId, ok: true, result: output.value }, output.transfer);
            } else {
                port.post({ taskId: message.taskId, ok: true, result: output }, []);
            }
        } catch (error) {
            const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            port.post({ taskId: message.taskId, ok: false, error: text }, []);
        }
    });
}

function isTransferResult(value: unknown): value is TransferResult<unknown> {
    return typeof value === 'object' && value !== null && (value as { __transfer?: unknown }).__transfer === true;
}
