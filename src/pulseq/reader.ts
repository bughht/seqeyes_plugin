/**
 * Pulseq .seq file reader — parses the text-based Pulseq file format v1.x.
 *
 * The .seq file is a human-readable text file with sections delimited by
 * [SECTION_NAME] headers. Each section contains structured data.
 */
import { decompressShape } from './decompressor';
import {
    PulseqSequence,
    TrapGradEntry,
    ADCEntry,
    ExtensionEntry,
    TriggerSpec,
    NCOSpec,
    DecompressedShape,
} from './types';

/**
 * Parse a Pulseq .seq file from raw text content.
 */
export function parseSequenceText(text: string): PulseqSequence {
    const lines = text.split(/\r?\n/);

    const seq: PulseqSequence = {
        version: { major: 1, minor: 0, revision: 0 },
        definitions: new Map(),
        definitionsRaw: new Map(),
        blocks: [],
        rfs: new Map(),
        arbitraryGrads: new Map(),
        trapGrads: new Map(),
        adcs: new Map(),
        extensions: new Map(),
        triggers: [],
        ncos: [],
        shapes: new Map(),
        rasterTimes: {
            blockDurationRaster: 1e-5,
            gradientRaster: 1e-5,
            rfRaster: 1e-6,
            adcRaster: 1e-7,
        },
    };

    let section: string | null = null;
    let sectionLines: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const sectionMatch = line.match(/^\[(\w+)\]$/);
        if (sectionMatch) {
            // Process previous section
            if (section) {
                processSection(seq, section, sectionLines);
            }
            section = sectionMatch[1];
            sectionLines = [];
        } else {
            sectionLines.push(line);
        }
        i++;
    }
    // Process last section
    if (section) {
        processSection(seq, section, sectionLines);
    }

    // Set raster times from definitions if available
    extractRasterTimes(seq);

    return seq;
}

function processSection(seq: PulseqSequence, section: string, lines: string[]): void {
    const nonEmptyLines = lines.filter(l => l.trim() !== '' && !l.trim().startsWith('#'));

    switch (section) {
        case 'VERSION':
            parseVersion(seq, nonEmptyLines);
            break;
        case 'DEFINITIONS':
            parseDefinitions(seq, nonEmptyLines);
            break;
        case 'BLOCKS':
            parseBlocks(seq, nonEmptyLines);
            break;
        case 'RF':
            parseRF(seq, nonEmptyLines);
            break;
        case 'GRADIENTS':
            parseArbitraryGrads(seq, nonEmptyLines);
            break;
        case 'TRAP':
            parseTrapGrads(seq, nonEmptyLines);
            break;
        case 'ADC':
            parseADC(seq, nonEmptyLines);
            break;
        case 'EXTENSIONS':
            parseExtensions(seq, nonEmptyLines, lines);
            break;
        case 'SHAPES':
            parseShapes(seq, lines);
            break;
        case 'SIGNATURE':
            // Skip signature — not needed for visualization
            break;
    }
}

function parseVersion(seq: PulseqSequence, lines: string[]): void {
    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
            const val = parseInt(parts[1], 10);
            if (parts[0] === 'major') seq.version.major = val;
            else if (parts[0] === 'minor') seq.version.minor = val;
            else if (parts[0] === 'revision') seq.version.revision = val;
        }
    }
}

function parseDefinitions(seq: PulseqSequence, lines: string[]): void {
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Find first whitespace to separate key from values
        const wsIdx = trimmed.search(/\s/);
        if (wsIdx === -1) {
            seq.definitions.set(trimmed, []);
            seq.definitionsRaw.set(trimmed, '');
            continue;
        }
        const key = trimmed.substring(0, wsIdx);
        const valueStr = trimmed.substring(wsIdx + 1).trim();
        const values = valueStr.split(/\s+/).map(Number).filter(n => !isNaN(n));
        seq.definitions.set(key, values);
        seq.definitionsRaw.set(key, valueStr);
    }
}

function parseBlocks(seq: PulseqSequence, lines: string[]): void {
    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 8) {
            seq.blocks.push({
                num: parseInt(parts[0], 10),
                dur: parseFloat(parts[1]),
                rfId: parseInt(parts[2], 10),
                gxId: parseInt(parts[3], 10),
                gyId: parseInt(parts[4], 10),
                gzId: parseInt(parts[5], 10),
                adcId: parseInt(parts[6], 10),
                extId: parseInt(parts[7], 10),
            });
        }
    }
}

function parseRF(seq: PulseqSequence, lines: string[]): void {
    const isV15 = seq.version.major >= 1 && seq.version.minor >= 5;
    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        // Skip trailing non-numeric use flags like 'i', 'e', 's', 'u'
        let use = '';
        if (parts.length > 0 && /^[iesu]$/i.test(parts[parts.length - 1])) {
            use = parts.pop()!.toLowerCase();
        }
        if (parts.length >= 6) {
            const id = parseInt(parts[0], 10);
            if (isV15) {
                // v1.5.x: id amplitude magShape phaseShape timeShape delay phaseOffset freqOffset [phaseModShapeId] [use]
                seq.rfs.set(id, {
                    id,
                    amplitude: parseFloat(parts[1]),
                    magShapeId: parseInt(parts[2], 10),
                    phaseShapeId: parseInt(parts[3], 10),
                    timeShapeId: parts.length > 4 ? parseInt(parts[4], 10) : 0,
                    delay: parts.length > 5 ? parseFloat(parts[5]) : 0,
                    phaseOffset: parts.length > 6 ? parseFloat(parts[6]) : 0,
                    freqOffset: parts.length > 7 ? parseFloat(parts[7]) : 0,
                    phaseModShapeId: parts.length > 8 ? parseInt(parts[8], 10) : 0,
                    use,
                });
            } else {
                // v1.4.x: id amplitude magShape phaseShape [timeShape] [phaseOffset] [freqOffset] [phaseModShapeId]
                seq.rfs.set(id, {
                    id,
                    amplitude: parseFloat(parts[1]),
                    magShapeId: parseInt(parts[2], 10),
                    phaseShapeId: parseInt(parts[3], 10),
                    timeShapeId: parts.length > 4 ? parseInt(parts[4], 10) : 0,
                    delay: 0,
                    phaseOffset: parts.length > 5 ? parseFloat(parts[5]) : 0,
                    freqOffset: parts.length > 6 ? parseFloat(parts[6]) : 0,
                    phaseModShapeId: parts.length > 7 ? parseInt(parts[7], 10) : 0,
                    use: '',
                });
            }
        }
    }
}

function parseArbitraryGrads(seq: PulseqSequence, lines: string[]): void {
    const isV15 = seq.version.major >= 1 && seq.version.minor >= 5;
    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4) {
            const id = parseInt(parts[0], 10);
            if (isV15) {
                // v1.5.x: id amplitude first last shapeId timeId delay
                seq.arbitraryGrads.set(id, {
                    id,
                    amplitude: parseFloat(parts[1]),
                    first: parts.length > 2 ? parseFloat(parts[2]) : 0,
                    last: parts.length > 3 ? parseFloat(parts[3]) : 0,
                    shapeId: parts.length > 4 ? parseInt(parts[4], 10) : 0,
                    timeId: parts.length > 5 ? parseInt(parts[5], 10) : 0,
                    delay: parts.length > 6 ? parseFloat(parts[6]) : 0,
                });
            } else {
                // v1.4.x: id amplitude shapeId timeId timeRange
                seq.arbitraryGrads.set(id, {
                    id,
                    amplitude: parseFloat(parts[1]),
                    first: 0,
                    last: 0,
                    shapeId: parseInt(parts[2], 10),
                    timeId: parts.length > 3 ? parseInt(parts[3], 10) : 0,
                    delay: parts.length > 4 ? parseFloat(parts[4]) : 0,
                });
            }
        }
    }
}

function parseTrapGrads(seq: PulseqSequence, lines: string[]): void {
    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
            const id = parseInt(parts[0], 10);
            seq.trapGrads.set(id, {
                id,
                amplitude: parseFloat(parts[1]),
                rise: parseFloat(parts[2]),
                flat: parseFloat(parts[3]),
                fall: parseFloat(parts[4]),
                delay: parts.length > 5 ? parseFloat(parts[5]) : 0,
            });
        }
    }
}

function parseADC(seq: PulseqSequence, lines: string[]): void {
    const isV15 = seq.version.major >= 1 && seq.version.minor >= 5;
    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
            const id = parseInt(parts[0], 10);
            if (isV15) {
                // v1.5.x: id numSamples dwell delay freqOffset phaseOffset deadTime discardPre discardPost [phaseModShapeId]
                seq.adcs.set(id, {
                    id,
                    numSamples: parseInt(parts[1], 10),
                    dwell: parseFloat(parts[2]),
                    delay: parseFloat(parts[3]),
                    freqOffset: parts.length > 4 ? parseFloat(parts[4]) : 0,
                    phaseOffset: parts.length > 5 ? parseFloat(parts[5]) : 0,
                    deadTime: parts.length > 6 ? parseFloat(parts[6]) : 0,
                    discardPre: parts.length > 7 ? parseInt(parts[7], 10) : 0,
                    discardPost: parts.length > 8 ? parseInt(parts[8], 10) : 0,
                    phaseModShapeId: parts.length > 9 ? parseInt(parts[9], 10) : 0,
                });
            } else {
                // v1.4.x: id numSamples dwell delay freqOffset phaseOffset [phaseModShapeId]
                seq.adcs.set(id, {
                    id,
                    numSamples: parseInt(parts[1], 10),
                    dwell: parseFloat(parts[2]),
                    delay: parseFloat(parts[3]),
                    freqOffset: parts.length > 4 ? parseFloat(parts[4]) : 0,
                    phaseOffset: parts.length > 5 ? parseFloat(parts[5]) : 0,
                    deadTime: 0,
                    discardPre: 0,
                    discardPost: 0,
                    phaseModShapeId: parts.length > 6 ? parseInt(parts[6], 10) : 0,
                });
            }
        }
    }
}

function parseExtensions(seq: PulseqSequence, nonEmptyLines: string[], allLines: string[]): void {
    // First pass: parse extension list entries
    let inExtensionList = true;
    let extLines: string[] = [];

    for (const line of nonEmptyLines) {
        if (line.startsWith('extension ')) {
            inExtensionList = false;
            extLines.push(line);
            continue;
        }
        if (inExtensionList) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 4) {
                const id = parseInt(parts[0], 10);
                seq.extensions.set(id, {
                    id,
                    type: parseInt(parts[1], 10),
                    ref: parseInt(parts[2], 10),
                    nextId: parseInt(parts[3], 10),
                });
            }
        } else {
            extLines.push(line);
        }
    }

    // Parse extension specifications (TRIGGERS, NCO, etc.)
    let i = 0;
    while (i < extLines.length) {
        const line = extLines[i].trim();
        if (line.startsWith('extension TRIGGERS')) {
            const parts = line.split(/\s+/);
            const refId = parseInt(parts[2], 10);
            i++;
            // Parse trigger entries until next extension or end
            while (i < extLines.length) {
                const entryLine = extLines[i].trim();
                if (entryLine.startsWith('extension ')) break;
                const entryParts = entryLine.split(/\s+/);
                // Trigger format: id type channel delay(us) duration(us)  (5 fields)
                if (entryParts.length >= 5) {
                    seq.triggers.push({
                        id: parseInt(entryParts[0], 10),
                        channel: parseInt(entryParts[2], 10),   // entryParts[1] is 'type'
                        delay: parseFloat(entryParts[3]),       // us
                        duration: parseFloat(entryParts[4]),    // us
                    });
                }
                i++;
            }
        } else if (line.startsWith('extension NCO')) {
            const parts = line.split(/\s+/);
            i++;
            while (i < extLines.length) {
                const entryLine = extLines[i].trim();
                if (entryLine.startsWith('extension ')) break;
                const entryParts = entryLine.split(/\s+/);
                if (entryParts.length >= 6) {
                    seq.ncos.push({
                        id: parseInt(entryParts[0], 10),
                        channel: parseInt(entryParts[1], 10),
                        frequency: parseFloat(entryParts[2]),
                        phase: parseFloat(entryParts[3]),
                        delay: parseFloat(entryParts[4]),
                        duration: parseFloat(entryParts[5]),
                    });
                }
                i++;
            }
        } else {
            i++;
        }
    }
}

function parseShapes(seq: PulseqSequence, lines: string[]): void {
    let i = 0;
    while (i < lines.length) {
        const trimmed = lines[i].trim();

        // Skip empty lines, comments, and section headers
        if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('[')) {
            i++;
            continue;
        }

        // Find shape_id declaration
        const shapeIdMatch = trimmed.match(/^shape_id\s+(\d+)/);
        if (!shapeIdMatch) {
            i++;
            continue;
        }

        const currentShapeId = parseInt(shapeIdMatch[1], 10);
        i++; // move past shape_id line

        // Find num_samples
        let numSamples = 0;
        while (i < lines.length) {
            const l = lines[i].trim();
            if (l === '' || l.startsWith('#')) {
                i++;
                continue;
            }
            const nm = l.match(/^num_samples\s+(\d+)/);
            if (nm) {
                numSamples = parseInt(nm[1], 10);
                i++;
                break;
            }
            // If we hit another shape_id or section, something is wrong
            if (l.match(/^shape_id\s+\d+/) || l.startsWith('[')) {
                break;
            }
            i++;
        }

        if (numSamples <= 0) {
            continue;
        }

        // Read sample values
        const sampleValues: number[] = [];
        let samplesRead = 0;
        while (i < lines.length && samplesRead < numSamples) {
            const l = lines[i].trim();
            // Stop at next shape, section header, or comment line that starts a shape
            if (l.match(/^shape_id\s+\d+/) || (l.startsWith('[') && !l.startsWith('[') === false)) {
                break;
            }
            // Allow empty lines between samples
            if (l === '' || l.startsWith('#')) {
                i++;
                continue;
            }
            const nums = l.split(/\s+/).map(Number).filter(n => !isNaN(n));
            for (const n of nums) {
                if (samplesRead < numSamples) {
                    sampleValues.push(n);
                    samplesRead++;
                }
            }
            i++;
        }

        if (samplesRead > 0 && currentShapeId > 0) {
            shapeHelper(seq, currentShapeId, numSamples, sampleValues);
        }
    }
}

function shapeHelper(seq: PulseqSequence, id: number, numSamples: number, rawValues: number[]): void {
    let decompressed: Float64Array;

    if (rawValues.length === numSamples) {
        // Uncompressed — use as-is
        decompressed = new Float64Array(rawValues);
    } else {
        // Compressed — decompress
        decompressed = decompressShape(rawValues, numSamples);
    }

    // Normalize if values are clearly outside [0, 1] range
    const maxVal = Math.max(...decompressed);
    const minVal = Math.min(...decompressed);

    if (maxVal > 1.5 || minVal < -0.5) {
        // Values need normalization to [0, 1]
        const range = maxVal - minVal;
        if (range > 1e-12) {
            for (let j = 0; j < numSamples; j++) {
                decompressed[j] = (decompressed[j] - minVal) / range;
            }
        } else {
            decompressed.fill(0.5);
        }
    }

    // Clamp to [0, 1]
    for (let j = 0; j < numSamples; j++) {
        if (decompressed[j] < 0) decompressed[j] = 0;
        if (decompressed[j] > 1) decompressed[j] = 1;
    }

    seq.shapes.set(id, {
        numSamples,
        samples: decompressed,
    });
}

function extractRasterTimes(seq: PulseqSequence): void {
    const bdr = seq.definitions.get('BlockDurationRaster');
    if (bdr && bdr.length > 0) seq.rasterTimes.blockDurationRaster = bdr[0];

    const grt = seq.definitions.get('GradientRasterTime');
    if (grt && grt.length > 0) seq.rasterTimes.gradientRaster = grt[0];

    const rfr = seq.definitions.get('RadiofrequencyRasterTime');
    if (rfr && rfr.length > 0) seq.rasterTimes.rfRaster = rfr[0];

    const adcr = seq.definitions.get('AdcRasterTime');
    if (adcr && adcr.length > 0) seq.rasterTimes.adcRaster = adcr[0];
}

/**
 * Re-parse shapes from raw lines for a more robust approach.
 * This handles the case where parseShapes may have issues with certain shape formats.
 */
export function getShapeRawData(text: string, shapeId: number): Float64Array | null {
    const lines = text.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
        const trimmed = lines[i].trim();
        const m = trimmed.match(/^shape_id\s+(\d+)/);
        if (m && parseInt(m[1], 10) === shapeId) {
            i++;
            // Find num_samples
            while (i < lines.length) {
                const l = lines[i].trim();
                const nm = l.match(/^num_samples\s+(\d+)/);
                if (nm) {
                    const ns = parseInt(nm[1], 10);
                    i++;
                    const vals: number[] = [];
                    let count = 0;
                    while (i < lines.length && count < ns) {
                        const ln = lines[i].trim();
                        if (ln === '' || ln.startsWith('shape_id') || ln.startsWith('[')) break;
                        const nums = ln.split(/\s+/).map(Number).filter(n => !isNaN(n));
                        for (const n of nums) {
                            if (count < ns) { vals.push(n); count++; }
                        }
                        i++;
                    }
                    if (count === ns) {
                        return decompressShape(vals, ns);
                    }
                    return null;
                }
                i++;
            }
        }
        i++;
    }
    return null;
}
