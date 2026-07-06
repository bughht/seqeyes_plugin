import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { exportKspaceFiles, type KspaceExportOptions } from '../pulseq/kspaceExport';

interface CliArgs {
    inputPath: string;
    outputDir: string;
    options: KspaceExportOptions;
}

function main(argv: string[]): number {
    try {
        const args = parseArgs(argv);
        const result = exportKspaceFiles(args.inputPath, args.outputDir, args.options);
        process.stdout.write(`Wrote ${result.ktrajAdcPath}\n`);
        if (result.ktrajPath) process.stdout.write(`Wrote ${result.ktrajPath}\n`);
        process.stdout.write(`Wrote ${result.metadataPath}\n`);
        process.stdout.write(`ADC samples: ${result.metadata.adcSampleCount}\n`);
        return 0;
    } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.stderr.write(`${usage()}\n`);
        return 1;
    }
}

function parseArgs(argv: string[]): CliArgs {
    let inputPath = '';
    let outputDir = '';
    let includeFullTrajectory = false;
    let maxGridPoints: number | undefined;
    const positional: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            process.stdout.write(`${usage()}\n`);
            process.exit(0);
        } else if (arg === '--input') {
            inputPath = requireValue(argv, ++i, arg);
        } else if (arg === '--out-dir') {
            outputDir = requireValue(argv, ++i, arg);
        } else if (arg === '--full') {
            includeFullTrajectory = true;
        } else if (arg === '--max-grid-points') {
            maxGridPoints = parsePositiveInteger(requireValue(argv, ++i, arg), arg);
        } else if (arg.startsWith('--')) {
            throw new Error(`Unknown option: ${arg}`);
        } else {
            positional.push(arg);
        }
    }

    if (!inputPath && positional[0]) inputPath = positional[0];
    if (!outputDir && positional[1]) outputDir = positional[1];
    if (positional.length > 2) throw new Error(`Unexpected argument: ${positional[2]}`);
    if (!inputPath || !outputDir) throw new Error('Missing required input path or output directory');

    const resolvedInput = resolve(inputPath);
    const resolvedOutput = resolve(outputDir);
    if (!existsSync(resolvedInput) || !statSync(resolvedInput).isFile()) {
        throw new Error(`Input file does not exist: ${resolvedInput}`);
    }

    return {
        inputPath: resolvedInput,
        outputDir: resolvedOutput,
        options: {
            includeFullTrajectory,
            maxGridPoints,
            packageVersion: readPackageVersion(),
        },
    };
}

function requireValue(argv: string[], index: number, option: string): string {
    const value = argv[index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`);
    return value;
}

function parsePositiveInteger(value: string, option: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${option} must be a positive integer`);
    }
    return parsed;
}

function readPackageVersion(): string {
    try {
        const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version?: unknown };
        return typeof pkg.version === 'string' ? pkg.version : 'unknown';
    } catch {
        return 'unknown';
    }
}

function usage(): string {
    return [
        'Usage: node out/cli/exportKspace.js <input.seq> <out-dir> [options]',
        '',
        'Options:',
        '  --input <file>             Pulseq .seq input file, alternative to positional input',
        '  --out-dir <dir>            Output directory, alternative to positional output',
        '  --full                     Also write full ktraj.txt in addition to ktraj_adc.txt',
        '  --max-grid-points <count>  Abort if the integration grid exceeds this count',
        '  -h, --help                 Show this help',
    ].join('\n');
}

if (require.main === module) {
    process.exitCode = main(process.argv.slice(2));
}
