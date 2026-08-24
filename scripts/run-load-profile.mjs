import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const STAGES = ['parse', 'decode', 'display'];

async function main() {
    const options = parseArguments(process.argv.slice(2));
    const report = {
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        mode: 'reporting-first',
        supervisor: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            timeoutMs: options.timeoutMs,
            maxOldSpaceMiB: options.maxOldSpaceMiB,
        },
        runs: [],
    };

    for (const input of options.inputs) {
        for (const stage of options.stages) {
            const run = await runChild(input, stage, options);
            report.runs.push(run);
            printRun(run);
            if (run.status !== 'ok') break;
        }
    }

    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`Report: ${options.output}\n`);
    if (report.runs.some(run => run.status !== 'ok')) process.exitCode = 1;
}

function runChild(input, stage, options) {
    return new Promise(resolveRun => {
        const started = performance.now();
        const child = spawn(process.execPath, [
            '--expose-gc',
            `--max-old-space-size=${options.maxOldSpaceMiB}`,
            resolve('out/cli/profileLoad.js'),
            '--input', input,
            '--stage', stage,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
        }, options.timeoutMs);

        child.stdout.on('data', chunk => { stdout = appendBounded(stdout, chunk); });
        child.stderr.on('data', chunk => { stderr = appendBounded(stderr, chunk); });
        child.on('error', error => {
            clearTimeout(timer);
            resolveRun({
                input,
                stage,
                status: 'spawn-error',
                elapsedMs: performance.now() - started,
                error: error.message,
            });
        });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            let result = null;
            try {
                result = stdout.trim() ? JSON.parse(stdout.trim()) : null;
            } catch (error) {
                stderr = `${stderr}\nInvalid child JSON: ${error.message}`.trim();
            }
            resolveRun({
                input,
                stage,
                status: timedOut ? 'timeout' : (code === 0 && result?.status === 'ok' ? 'ok' : 'failed'),
                elapsedMs: performance.now() - started,
                exitCode: code,
                signal,
                result,
                stderr: stderr.trim() || undefined,
            });
        });
    });
}

function appendBounded(current, chunk) {
    const next = current + chunk.toString('utf8');
    return next.length <= 4_000_000 ? next : next.slice(next.length - 4_000_000);
}

function printRun(run) {
    const seconds = (run.elapsedMs / 1000).toFixed(2);
    const memory = run.result?.phases
        ? Math.max(...Object.values(run.result.phases).map(phase => phase.memory.peakRssBytes || 0))
        : 0;
    const memoryText = memory > 0 ? `, peak RSS ${(memory / 1024 ** 3).toFixed(2)} GiB` : '';
    process.stdout.write(`${run.status.toUpperCase()} ${run.stage} ${run.input} (${seconds} s${memoryText})\n`);
    if (run.stderr) process.stderr.write(`${run.stderr}\n`);
}

function parseArguments(argv) {
    const options = {
        inputs: [],
        stages: [...STAGES],
        output: resolve('performance-results/load-profile.json'),
        timeoutMs: 10 * 60_000,
        maxOldSpaceMiB: 4096,
    };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--input') options.inputs.push(resolve(requireValue(argv, ++index, argument)));
        else if (argument === '--stages') options.stages = parseStages(requireValue(argv, ++index, argument));
        else if (argument === '--output') options.output = resolve(requireValue(argv, ++index, argument));
        else if (argument === '--timeout-ms') options.timeoutMs = positiveInteger(requireValue(argv, ++index, argument), argument);
        else if (argument === '--max-old-space-mib') options.maxOldSpaceMiB = positiveInteger(requireValue(argv, ++index, argument), argument);
        else if (argument === '--help' || argument === '-h') {
            process.stdout.write(`${usage()}\n`);
            process.exit(0);
        } else throw new Error(`Unknown argument: ${argument}`);
    }
    if (!options.inputs.length) throw new Error('At least one --input is required');
    return options;
}

function parseStages(value) {
    const stages = value.split(',').map(item => item.trim()).filter(Boolean);
    if (!stages.length || stages.some(stage => !STAGES.includes(stage))) {
        throw new Error(`--stages must contain only ${STAGES.join(', ')}`);
    }
    return stages;
}

function positiveInteger(value, option) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${option} must be a positive integer`);
    return parsed;
}

function requireValue(argv, index, option) {
    const value = argv[index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`);
    return value;
}

function usage() {
    return [
        'Usage: node scripts/run-load-profile.mjs --input <file> [--input <file> ...] [options]',
        '',
        'Options:',
        '  --stages parse,decode,display  Fresh-process stages to run in order',
        '  --output <file>                JSON report path',
        '  --timeout-ms <ms>              Per-stage timeout (default 600000)',
        '  --max-old-space-mib <MiB>      Per-stage V8 heap ceiling (default 4096)',
        '  -h, --help                     Show this help',
    ].join('\n');
}

main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
    process.exitCode = 2;
});
