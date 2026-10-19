/**
 * Minimal Pulseq v1.5.1 text writer for simulator tests. Shapes are written
 * uncompressed (sample count = listed values).
 */

export interface RfRow {
    amplitude: number;      // Hz
    magShape: number;
    phaseShape?: number;
    timeShape?: number;
    centerUs: number;
    delayUs?: number;
    freqPPM?: number;
    phasePPM?: number;
    freq?: number;          // Hz
    phase?: number;         // rad
    use?: string;
}

export interface TrapRow {
    amplitude: number;      // Hz/m
    riseUs: number;
    flatUs: number;
    fallUs: number;
    delayUs?: number;
}

export interface AdcRow {
    samples: number;
    dwellNs: number;
    delayUs?: number;
    freq?: number;
    phase?: number;
    freqPPM?: number;
    phasePPM?: number;
    phaseShape?: number;
}

export interface BlockRow {
    /** Duration in block-raster ticks (10 µs). */
    ticks: number;
    rf?: number;
    gx?: number;
    gy?: number;
    gz?: number;
    adc?: number;
}

export interface SeqSpec {
    blocks: BlockRow[];
    rf?: RfRow[];
    traps?: TrapRow[];
    adc?: AdcRow[];
    shapes?: number[][];
    extraDefinitions?: string;
}

const f = (v: number) => (Number.isInteger(v) ? String(v) : v.toPrecision(17));

export function seqText(spec: SeqSpec): string {
    const lines: string[] = [
        '[VERSION]', 'major 1', 'minor 5', 'revision 1', '',
        '[DEFINITIONS]',
        'AdcRasterTime 1e-07',
        'BlockDurationRaster 1e-05',
        'GradientRasterTime 1e-05',
        'RadiofrequencyRasterTime 1e-06',
    ];
    if (spec.extraDefinitions) lines.push(spec.extraDefinitions);
    lines.push('', '[BLOCKS]');
    spec.blocks.forEach((b, i) => lines.push(
        [i + 1, b.ticks, b.rf ?? 0, b.gx ?? 0, b.gy ?? 0, b.gz ?? 0, b.adc ?? 0, 0].join(' '),
    ));
    if (spec.rf?.length) {
        lines.push('', '[RF]');
        spec.rf.forEach((r, i) => lines.push([
            i + 1, f(r.amplitude), r.magShape, r.phaseShape ?? 0, r.timeShape ?? 0,
            f(r.centerUs), f(r.delayUs ?? 0), f(r.freqPPM ?? 0), f(r.phasePPM ?? 0),
            f(r.freq ?? 0), f(r.phase ?? 0), r.use ?? 'e',
        ].join(' ')));
    }
    if (spec.traps?.length) {
        lines.push('', '[TRAP]');
        spec.traps.forEach((t, i) => lines.push(
            [i + 1, f(t.amplitude), f(t.riseUs), f(t.flatUs), f(t.fallUs), f(t.delayUs ?? 0)].join(' '),
        ));
    }
    if (spec.adc?.length) {
        lines.push('', '[ADC]');
        spec.adc.forEach((a, i) => lines.push([
            i + 1, a.samples, f(a.dwellNs), f(a.delayUs ?? 0), f(a.freqPPM ?? 0), f(a.phasePPM ?? 0),
            f(a.freq ?? 0), f(a.phase ?? 0), a.phaseShape ?? 0,
        ].join(' ')));
    }
    if (spec.shapes?.length) {
        lines.push('', '[SHAPES]');
        spec.shapes.forEach((values, i) => {
            lines.push('', `shape_id ${i + 1}`, `num_samples ${values.length}`);
            for (const v of values) lines.push(f(v));
        });
    }
    lines.push('');
    return lines.join('\n');
}

/** Windowed-sinc magnitude shape normalised to a peak of 1 (Hann apodisation). */
export function sincShape(samples: number, timeBandwidth: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < samples; i++) {
        const t = (i + 0.5) / samples - 0.5;            // −½ … ½ of the pulse
        const x = timeBandwidth * t;
        const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const window = 0.5 + 0.5 * Math.cos(2 * Math.PI * t);
        out.push(sinc * window);
    }
    const peak = Math.max(...out);
    return out.map(v => v / peak);
}
