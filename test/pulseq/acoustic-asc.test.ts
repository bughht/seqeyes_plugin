import { describe, expect, it } from 'vitest';

import {
  countBandsOutsideRange,
  describeAscProfile,
  isEmptyAscProfile,
  parseAcousticResonancesAsc,
  parseAscProfile,
} from '../../src/pulseq/acousticAsc';
import { parsePnsHardwareAsc } from '../../src/pulseq/pns';

/** PNS coefficients only — the shape the viewer accepted before this feature. */
function pnsOnlyAsc(): string {
  return `
GradPatSup.Phys.PNS.flGSWDTauX[0] = 1
GradPatSup.Phys.PNS.flGSWDTauX[1] = 2
GradPatSup.Phys.PNS.flGSWDTauX[2] = 3
GradPatSup.Phys.PNS.flGSWDAX[0] = 0.2
GradPatSup.Phys.PNS.flGSWDAX[1] = 0.3
GradPatSup.Phys.PNS.flGSWDAX[2] = 0.5
GradPatSup.Phys.PNS.flGSWDStimulationLimitX = 10
GradPatSup.Phys.PNS.flGSWDStimulationThresholdX = 1
asGPAParameters[0].sGCParameters.flGScaleFactorX = 1

GradPatSup.Phys.PNS.flGSWDTauY[0] = 1
GradPatSup.Phys.PNS.flGSWDTauY[1] = 2
GradPatSup.Phys.PNS.flGSWDTauY[2] = 3
GradPatSup.Phys.PNS.flGSWDAY[0] = 0.2
GradPatSup.Phys.PNS.flGSWDAY[1] = 0.3
GradPatSup.Phys.PNS.flGSWDAY[2] = 0.5
GradPatSup.Phys.PNS.flGSWDStimulationLimitY = 10
GradPatSup.Phys.PNS.flGSWDStimulationThresholdY = 1
asGPAParameters[0].sGCParameters.flGScaleFactorY = 1.1

GradPatSup.Phys.PNS.flGSWDTauZ[0] = 1
GradPatSup.Phys.PNS.flGSWDTauZ[1] = 2
GradPatSup.Phys.PNS.flGSWDTauZ[2] = 3
GradPatSup.Phys.PNS.flGSWDAZ[0] = 0.2
GradPatSup.Phys.PNS.flGSWDAZ[1] = 0.3
GradPatSup.Phys.PNS.flGSWDAZ[2] = 0.5
GradPatSup.Phys.PNS.flGSWDStimulationLimitZ = 10
GradPatSup.Phys.PNS.flGSWDStimulationThresholdZ = 1
asGPAParameters[0].sGCParameters.flGScaleFactorZ = 1.2
`;
}

/** Top-level spelling, as older profiles carry it. */
function topLevelAcousticAsc(): string {
  return `
aflGCAcousticResonanceFrequency[0] = 550.0
aflGCAcousticResonanceBandwidth[0] = 100.0
aflGCAcousticResonanceFrequency[1] = 1150.0
aflGCAcousticResonanceBandwidth[1] = 220.0
aflGCAcousticResonanceFrequency[2] = 0
aflGCAcousticResonanceBandwidth[2] = 0
`;
}

/** Nested spelling, as newer profiles carry it. */
function nestedAcousticAsc(): string {
  return `
asGPAParameters[0].sGCParameters.aflAcousticResonanceFrequency[0] = 590.0
asGPAParameters[0].sGCParameters.aflAcousticResonanceBandwidth[0] = 120.0
asGPAParameters[0].sGCParameters.aflAcousticResonanceFrequency[1] = 1290.0
asGPAParameters[0].sGCParameters.aflAcousticResonanceBandwidth[1] = 250.0
`;
}

describe('acoustic resonance ASC parsing', () => {
  it('reads the top-level key spelling and drops zero-frequency entries', () => {
    const bands = parseAcousticResonancesAsc(topLevelAcousticAsc());

    expect(bands).toEqual([
      { freqHz: 550, bwHz: 100 },
      { freqHz: 1150, bwHz: 220 },
    ]);
  });

  it('reads the nested asGPAParameters spelling', () => {
    const bands = parseAcousticResonancesAsc(nestedAcousticAsc());

    expect(bands).toEqual([
      { freqHz: 590, bwHz: 120 },
      { freqHz: 1290, bwHz: 250 },
    ]);
  });

  it('returns bands sorted by centre frequency', () => {
    const bands = parseAcousticResonancesAsc(`
aflGCAcousticResonanceFrequency[0] = 1400
aflGCAcousticResonanceBandwidth[0] = 90
aflGCAcousticResonanceFrequency[1] = 620
aflGCAcousticResonanceBandwidth[1] = 80
`);

    expect(bands.map(band => band.freqHz)).toEqual([620, 1400]);
  });

  it('excludes .CarNS. variants, matching the PNS reader', () => {
    const bands = parseAcousticResonancesAsc(`
GradPatSup.Phys.CarNS.aflGCAcousticResonanceFrequency[0] = 999
GradPatSup.Phys.CarNS.aflGCAcousticResonanceBandwidth[0] = 50
GradPatSup.Phys.Acoustic.aflGCAcousticResonanceFrequency[0] = 550
GradPatSup.Phys.Acoustic.aflGCAcousticResonanceBandwidth[0] = 100
`);

    expect(bands).toEqual([{ freqHz: 550, bwHz: 100 }]);
  });

  it('tolerates a frequency table with no matching bandwidth table', () => {
    const bands = parseAcousticResonancesAsc('aflGCAcousticResonanceFrequency[0] = 700\n');

    expect(bands).toEqual([{ freqHz: 700, bwHz: 0 }]);
  });

  it('returns no bands rather than throwing when the table is absent', () => {
    expect(parseAcousticResonancesAsc(pnsOnlyAsc())).toEqual([]);
  });

  it('rejects $include in browser text, as the PNS path already does', () => {
    expect(() => parseAcousticResonancesAsc('$include MP_GPA\n')).toThrow(/combined ASC profile/);
  });
});

describe('combined ASC profile', () => {
  it('reports both concerns when the file carries both', () => {
    const profile = parseAscProfile(pnsOnlyAsc() + topLevelAcousticAsc());

    expect(profile.pns?.valid).toBe(true);
    expect(profile.pnsError).toBeUndefined();
    expect(profile.acoustic).toHaveLength(2);
    expect(profile.acousticError).toBeUndefined();
    expect(profile.notice).toBeUndefined();
    expect(isEmptyAscProfile(profile)).toBe(false);
  });

  it('keeps PNS when the acoustic table is missing', () => {
    const profile = parseAscProfile(pnsOnlyAsc());

    expect(profile.pns?.valid).toBe(true);
    expect(profile.acoustic).toEqual([]);
    expect(profile.acousticError).toMatch(/no acoustic resonance table/);
    expect(profile.notice).toBe('PNS coefficients loaded. This ASC has no acoustic resonance table.');
  });

  it('keeps acoustic bands when PNS coefficients are missing', () => {
    // The behavioural heart of the button rename: `parsePnsHardwareAsc` throws
    // for this file, and that must not discard the acoustic data alongside it.
    expect(() => parsePnsHardwareAsc(topLevelAcousticAsc())).toThrow();

    const profile = parseAscProfile(topLevelAcousticAsc());

    expect(profile.pns).toBeUndefined();
    expect(profile.pnsError).toBeTruthy();
    expect(profile.acoustic).toHaveLength(2);
    expect(profile.notice).toBe(
      'Acoustic resonances loaded (2 bands). PNS coefficients are missing from this ASC.',
    );
  });

  it('reports an empty profile when the file carries neither', () => {
    const profile = parseAscProfile('someOtherKey = 1\n');

    expect(isEmptyAscProfile(profile)).toBe(true);
    expect(profile.notice).toBe('This ASC contains neither PNS coefficients nor acoustic resonances.');
  });

  it('fails the whole file for $include, since nothing can be resolved', () => {
    expect(() => parseAscProfile('$include MP_GPA\n')).toThrow(/combined ASC profile/);
  });

  it('describes each of the four outcomes distinctly', () => {
    const hardware = parsePnsHardwareAsc(pnsOnlyAsc());
    const band = [{ freqHz: 550, bwHz: 100 }];

    expect(describeAscProfile(hardware, band)).toBeUndefined();
    expect(describeAscProfile(hardware, [])).toMatch(/no acoustic resonance table/);
    expect(describeAscProfile(undefined, band)).toMatch(/1 band\)/);
    expect(describeAscProfile(undefined, [])).toMatch(/neither/);
  });
});

describe('band range reporting', () => {
  it('counts bands whose centre falls outside the displayed range', () => {
    const bands = [
      { freqHz: 550, bwHz: 100 },
      { freqHz: 1150, bwHz: 220 },
      { freqHz: 4200, bwHz: 300 },
    ];

    expect(countBandsOutsideRange(bands, 0, 3000)).toBe(1);
    expect(countBandsOutsideRange(bands, 0, 5000)).toBe(0);
    expect(countBandsOutsideRange(bands, 1000, 3000)).toBe(2);
  });
});
