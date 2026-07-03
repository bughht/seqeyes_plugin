"use strict";
var Pulseq = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // web/pulseq-browser.ts
  var pulseq_browser_exports = {};
  __export(pulseq_browser_exports, {
    calculateKspace: () => calculateKspace,
    decodeAllBlocks: () => decodeAllBlocks,
    detectSequenceTiming: () => detectSequenceTiming,
    getTotalDuration: () => getTotalDuration,
    parseSequenceText: () => parseSequenceText
  });

  // src/pulseq/decompressor.ts
  function decompressShape(compressed, numSamples) {
    const packedLen = compressed.length;
    if (packedLen === numSamples) {
      return new Float64Array(compressed);
    }
    const result = new Float64Array(numSamples);
    let iPacked = 0;
    let iUnpacked = 0;
    while (iPacked < packedLen && iUnpacked < numSamples) {
      if (iPacked + 1 >= packedLen) {
        result[iUnpacked] = compressed[iPacked];
        iPacked++;
        iUnpacked++;
        break;
      }
      if (compressed[iPacked] !== compressed[iPacked + 1]) {
        result[iUnpacked] = compressed[iPacked];
        iPacked++;
        iUnpacked++;
      } else {
        if (iPacked + 2 >= packedLen) break;
        const value = compressed[iPacked];
        const repeatCount = Math.round(compressed[iPacked + 2]) + 2;
        iPacked += 3;
        const end = Math.min(iUnpacked + repeatCount, numSamples);
        while (iUnpacked < end) {
          result[iUnpacked] = value;
          iUnpacked++;
        }
      }
    }
    let cumSum = 0;
    for (let i = 0; i < numSamples; i++) {
      cumSum += result[i];
      result[i] = cumSum;
    }
    return result;
  }

  // src/pulseq/types.ts
  var VER_PRE_14 = 1004e3;
  var VER_V15 = 1005e3;
  function makeVersionCombined(major, minor, revision) {
    return major * 1e6 + minor * 1e3 + revision;
  }

  // src/pulseq/reader.ts
  function parseSequenceText(text) {
    const lines = text.split(/\r?\n/);
    const seq = createEmptySequence();
    let sectionName = null;
    let sectionLines = [];
    for (const line of lines) {
      const m = line.match(/^\[(\w+)\]$/);
      if (m) {
        if (sectionName) dispatchSection(seq, sectionName, sectionLines);
        sectionName = m[1];
        sectionLines = [];
      } else {
        sectionLines.push(line);
      }
    }
    if (sectionName) dispatchSection(seq, sectionName, sectionLines);
    seq.versionCombined = makeVersionCombined(
      seq.version.major,
      seq.version.minor,
      seq.version.revision
    );
    extractRasterTimes(seq);
    return seq;
  }
  function dispatchSection(seq, name, lines) {
    const valid = lines.filter((l) => {
      const t = l.trim();
      return t && !t.startsWith("#");
    });
    switch (name) {
      case "VERSION":
        parseVersion(seq, valid);
        break;
      case "DEFINITIONS":
        parseDefinitions(seq, valid);
        break;
      case "BLOCKS":
        parseBlocks(seq, valid);
        break;
      case "RF":
        parseRF(seq, valid);
        break;
      case "GRADIENTS":
        parseArbitraryGrads(seq, valid);
        break;
      case "TRAP":
        parseTrapGrads(seq, valid);
        break;
      case "ADC":
        parseADC(seq, valid);
        break;
      case "EXTENSIONS":
        parseExtensions(seq, valid);
        break;
      case "SHAPES":
        parseShapes(seq, lines);
        break;
    }
  }
  function createEmptySequence() {
    return {
      version: { major: 1, minor: 0, revision: 0 },
      versionCombined: 0,
      definitions: /* @__PURE__ */ new Map(),
      definitionsRaw: /* @__PURE__ */ new Map(),
      blocks: [],
      rfs: /* @__PURE__ */ new Map(),
      arbitraryGrads: /* @__PURE__ */ new Map(),
      trapGrads: /* @__PURE__ */ new Map(),
      adcs: /* @__PURE__ */ new Map(),
      extensions: /* @__PURE__ */ new Map(),
      triggers: [],
      ncos: [],
      rotations: [],
      labelSets: [],
      labelIncs: [],
      softDelays: [],
      rfShims: [],
      shapes: /* @__PURE__ */ new Map(),
      rasterTimes: { blockDurationRaster: 1e-5, gradientRaster: 1e-5, rfRaster: 1e-6, adcRaster: 1e-7 }
    };
  }
  function ver(seq) {
    if (seq.versionCombined > 0) return seq.versionCombined;
    return makeVersionCombined(seq.version.major, seq.version.minor, seq.version.revision);
  }
  function parseVersion(seq, lines) {
    for (const line of lines) {
      const [k, v] = line.trim().split(/\s+/);
      const n = parseInt(v, 10);
      if (k === "major") seq.version.major = n;
      else if (k === "minor") seq.version.minor = n;
      else if (k === "revision") seq.version.revision = n;
    }
    seq.versionCombined = makeVersionCombined(
      seq.version.major,
      seq.version.minor,
      seq.version.revision
    );
  }
  function parseDefinitions(seq, lines) {
    for (const line of lines) {
      const idx = line.search(/\s/);
      if (idx < 0) {
        seq.definitions.set(line.trim(), []);
        continue;
      }
      const key = line.substring(0, idx);
      const vals = line.substring(idx + 1).trim().split(/\s+/).map(Number).filter((n) => !isNaN(n));
      seq.definitions.set(key, vals);
      seq.definitionsRaw.set(key, line.substring(idx + 1).trim());
    }
  }
  function parseBlocks(seq, lines) {
    const vc = ver(seq);
    for (const line of lines) {
      const p = line.trim().split(/\s+/);
      if (p.length < 8) continue;
      const num = +p[0];
      if (vc < VER_PRE_14) {
        seq.blocks.push({
          num,
          dur: +p[1],
          // raw µs — will be converted to raster‑units later
          rfId: +p[2],
          gxId: +p[3],
          gyId: +p[4],
          gzId: +p[5],
          adcId: +p[6],
          extId: +p[7]
        });
      } else {
        seq.blocks.push({
          num,
          dur: +p[1],
          rfId: +p[2],
          gxId: +p[3],
          gyId: +p[4],
          gzId: +p[5],
          adcId: +p[6],
          extId: +p[7]
        });
      }
    }
  }
  function parseRF(seq, lines) {
    const vc = ver(seq);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      let use = "";
      if (parts.length && /^[erisu]$/i.test(parts[parts.length - 1])) {
        use = parts.pop().toLowerCase();
      }
      if (parts.length < 6) continue;
      const id = +parts[0];
      const amp = +parts[1];
      const magId = +parts[2];
      const phId = +parts[3];
      if (vc >= VER_V15) {
        seq.rfs.set(id, {
          id,
          amplitude: amp,
          magShapeId: magId,
          phaseShapeId: phId,
          timeShapeId: +parts[4],
          center: parts.length > 5 ? +parts[5] : -1,
          // [5] = centre (µs)
          delay: parts.length > 6 ? +parts[6] : 0,
          // [6] = delay (µs)
          freqPPM: parts.length > 7 ? +parts[7] : 0,
          // [7] = freqPPM
          phasePPM: parts.length > 8 ? +parts[8] : 0,
          // [8] = phasePPM
          freqOffset: parts.length > 9 ? +parts[9] : 0,
          // [9] = freq (Hz)
          phaseOffset: parts.length > 10 ? +parts[10] : 0,
          // [10] = phase (rad)
          phaseModShapeId: 0,
          use
        });
      } else if (vc >= VER_PRE_14) {
        const hasTimeShape = parts.length >= 8;
        const timeShapeId = hasTimeShape ? +parts[4] : 0;
        const offset = hasTimeShape ? 1 : 0;
        seq.rfs.set(id, {
          id,
          amplitude: amp,
          magShapeId: magId,
          phaseShapeId: phId,
          timeShapeId,
          center: -1,
          // not in v1.4.x
          delay: +parts[4 + offset],
          // delay
          freqPPM: 0,
          phasePPM: 0,
          freqOffset: parts.length > 5 + offset ? +parts[5 + offset] : 0,
          phaseOffset: parts.length > 6 + offset ? +parts[6 + offset] : 0,
          phaseModShapeId: parts.length > 7 + offset ? +parts[7 + offset] : 0,
          use: ""
        });
      } else {
        seq.rfs.set(id, {
          id,
          amplitude: amp,
          magShapeId: magId,
          phaseShapeId: phId,
          timeShapeId: 0,
          center: -1,
          delay: +parts[4],
          freqPPM: 0,
          phasePPM: 0,
          freqOffset: parts.length > 5 ? +parts[5] : 0,
          phaseOffset: parts.length > 6 ? +parts[6] : 0,
          phaseModShapeId: parts.length > 7 ? +parts[7] : 0,
          use: ""
        });
      }
    }
  }
  function parseArbitraryGrads(seq, lines) {
    const vc = ver(seq);
    for (const line of lines) {
      const p = line.trim().split(/\s+/);
      if (p.length < 4) continue;
      const id = +p[0];
      if (vc >= VER_V15) {
        seq.arbitraryGrads.set(id, {
          id,
          amplitude: +p[1],
          first: +p[2],
          last: +p[3],
          shapeId: +p[4],
          timeId: p.length > 5 ? +p[5] : 0,
          delay: p.length > 6 ? +p[6] : 0
        });
      } else if (vc >= VER_PRE_14) {
        seq.arbitraryGrads.set(id, {
          id,
          amplitude: +p[1],
          first: 0,
          last: 0,
          shapeId: +p[2],
          timeId: p.length > 3 ? +p[3] : 0,
          delay: p.length > 4 ? +p[4] : 0
        });
      } else {
        seq.arbitraryGrads.set(id, {
          id,
          amplitude: +p[1],
          first: 0,
          last: 0,
          shapeId: +p[2],
          timeId: 0,
          delay: p.length > 3 ? +p[3] : 0
        });
      }
    }
  }
  function parseTrapGrads(seq, lines) {
    for (const line of lines) {
      const p = line.trim().split(/\s+/);
      if (p.length >= 5) {
        seq.trapGrads.set(+p[0], {
          id: +p[0],
          amplitude: +p[1],
          rise: +p[2],
          flat: +p[3],
          fall: +p[4],
          delay: p.length > 5 ? +p[5] : 0
        });
      }
    }
  }
  function parseADC(seq, lines) {
    const vc = ver(seq);
    for (const line of lines) {
      const p = line.trim().split(/\s+/);
      if (p.length < 5) continue;
      const id = +p[0];
      if (vc >= VER_V15) {
        seq.adcs.set(id, {
          id,
          numSamples: +p[1],
          dwell: +p[2],
          delay: +p[3],
          freqPPM: p.length > 4 ? +p[4] : 0,
          phasePPM: p.length > 5 ? +p[5] : 0,
          freqOffset: p.length > 6 ? +p[6] : 0,
          phaseOffset: p.length > 7 ? +p[7] : 0,
          deadTime: 0,
          discardPre: 0,
          discardPost: 0,
          phaseModShapeId: p.length > 8 ? +p[8] : 0
        });
      } else {
        seq.adcs.set(id, {
          id,
          numSamples: +p[1],
          dwell: +p[2],
          delay: +p[3],
          freqPPM: 0,
          phasePPM: 0,
          freqOffset: p.length > 4 ? +p[4] : 0,
          phaseOffset: p.length > 5 ? +p[5] : 0,
          deadTime: 0,
          discardPre: 0,
          discardPost: 0,
          phaseModShapeId: p.length > 6 ? +p[6] : 0
        });
      }
    }
  }
  function parseExtensions(seq, valid) {
    const vc = ver(seq);
    let i = 0;
    while (i < valid.length) {
      const line = valid[i].trim();
      if (line.startsWith("extension ")) break;
      const p = line.split(/\s+/);
      if (p.length >= 4) {
        seq.extensions.set(+p[0], {
          id: +p[0],
          type: +p[1],
          ref: +p[2],
          nextId: +p[3]
        });
      }
      i++;
    }
    while (i < valid.length) {
      const line = valid[i].trim();
      const extM = line.match(/^extension\s+(\w+)\s+(\d+)/i);
      if (!extM) {
        i++;
        continue;
      }
      const extName = extM[1].toUpperCase();
      const extId = +extM[2];
      i++;
      const dataLines = [];
      while (i < valid.length && !valid[i].trim().startsWith("extension ")) {
        dataLines.push(valid[i].trim());
        i++;
      }
      switch (extName) {
        case "TRIGGERS":
          parseTriggerSpecs(seq, dataLines);
          break;
        case "NCO":
          parseNCOSpecs(seq, dataLines);
          break;
        case "ROTATIONS":
          parseRotationSpecs(seq, dataLines, vc);
          break;
        case "LABELSET":
          parseLabelSpecs(seq, dataLines, true);
          break;
        case "LABELINC":
          parseLabelSpecs(seq, dataLines, false);
          break;
        case "DELAYS":
          parseSoftDelaySpecs(seq, dataLines);
          break;
        case "RF_SHIMS":
          parseRFShimSpecs(seq, dataLines);
          break;
        default:
          break;
      }
    }
  }
  function parseTriggerSpecs(seq, lines) {
    for (const line of lines) {
      const p = line.split(/\s+/);
      if (p.length >= 5) {
        seq.triggers.push({
          id: +p[0],
          triggerType: +p[1],
          channel: +p[2],
          delay: +p[3],
          duration: +p[4]
        });
      }
    }
  }
  function parseNCOSpecs(seq, lines) {
    for (const line of lines) {
      const p = line.split(/\s+/);
      if (p.length >= 6) {
        seq.ncos.push({
          id: +p[0],
          channel: +p[1],
          frequency: +p[2],
          phase: +p[3],
          delay: +p[4],
          duration: +p[5]
        });
      }
    }
  }
  function parseRotationSpecs(seq, lines, vc) {
    for (const line of lines) {
      const p = line.split(/\s+/).map(Number);
      if (vc >= VER_V15) {
        if (p.length >= 5) {
          const [q0, q1, q2, q3] = [p[1], p[2], p[3], p[4]];
          const norm = Math.sqrt(q0 * q0 + q1 * q1 + q2 * q2 + q3 * q3) || 1;
          seq.rotations.push({
            id: p[0],
            values: [q0 / norm, q1 / norm, q2 / norm, q3 / norm]
          });
        }
      } else {
        if (p.length >= 10) {
          seq.rotations.push({ id: p[0], values: p.slice(1, 10) });
        }
      }
    }
  }
  var KNOWN_LABELS = {
    "SLC": { labelId: 0, flagId: 0 },
    "SEG": { labelId: 1, flagId: 0 },
    "ECO": { labelId: 2, flagId: 0 },
    "PHS": { labelId: 3, flagId: 0 },
    "REP": { labelId: 4, flagId: 0 },
    "SET": { labelId: 5, flagId: 0 },
    "AVG": { labelId: 6, flagId: 0 },
    "ACQ": { labelId: 7, flagId: 0 },
    "LIN": { labelId: 8, flagId: 0 },
    "PAR": { labelId: 9, flagId: 0 },
    "ONCE": { labelId: 10, flagId: 0 },
    "NAV": { labelId: 0, flagId: 1 },
    "REV": { labelId: 0, flagId: 2 },
    "SMS": { labelId: 0, flagId: 4 },
    "REF": { labelId: 0, flagId: 8 },
    "IMA": { labelId: 0, flagId: 16 },
    "OFF": { labelId: 0, flagId: 32 },
    "NOISE": { labelId: 0, flagId: 64 },
    "PMC": { labelId: 0, flagId: 128 },
    "NOPOS": { labelId: 0, flagId: 256 },
    "NOROT": { labelId: 0, flagId: 512 },
    "NOSCL": { labelId: 0, flagId: 1024 }
  };
  var _unknownLabelCounter = 0;
  var _unknownLabels = /* @__PURE__ */ new Map();
  function decodeLabel(name) {
    const known = KNOWN_LABELS[name];
    if (known) return known;
    let id = _unknownLabels.get(name);
    if (id === void 0) {
      id = 1e3 + ++_unknownLabelCounter;
      _unknownLabels.set(name, id);
    }
    return { labelId: id, flagId: 0 };
  }
  function parseLabelSpecs(seq, lines, isSet) {
    for (const line of lines) {
      const p = line.split(/\s+/);
      if (p.length < 3) continue;
      const { labelId, flagId } = decodeLabel(p[2]);
      const spec = {
        id: +p[0],
        value: +p[1],
        labelId,
        flagId
      };
      if (isSet) seq.labelSets.push(spec);
      else seq.labelIncs.push(spec);
    }
  }
  function parseSoftDelaySpecs(seq, lines) {
    for (const line of lines) {
      const p = line.split(/\s+/);
      if (p.length >= 4) {
        const hintIdx = line.search(/[a-zA-Z]/);
        seq.softDelays.push({
          id: +p[0],
          numId: +p[1],
          offset: +p[2],
          factor: +p[3],
          hint: hintIdx > 0 ? line.substring(hintIdx).trim() : ""
        });
      }
    }
  }
  function parseRFShimSpecs(seq, lines) {
    for (const line of lines) {
      const p = line.split(/\s+/);
      if (p.length < 2) continue;
      const nChan = +p[1];
      const amps = [];
      const phases = [];
      for (let c = 0; c < nChan && 2 + c * 2 + 1 < p.length; c++) {
        amps.push(+p[2 + c * 2]);
        phases.push(+p[2 + c * 2 + 1]);
      }
      seq.rfShims.push({ id: +p[0], nChannels: nChan, amplitudes: amps, phases });
    }
  }
  function parseShapes(seq, lines) {
    let i = 0;
    while (i < lines.length) {
      const t = lines[i].trim();
      if (!t || t.startsWith("#") || t.startsWith("[")) {
        i++;
        continue;
      }
      const m = t.match(/^shape_id\s+(\d+)/);
      if (!m) {
        i++;
        continue;
      }
      const shapeId = +m[1];
      i++;
      let numSamples = 0;
      while (i < lines.length) {
        const l = lines[i].trim();
        if (!l || l.startsWith("#")) {
          i++;
          continue;
        }
        const nm = l.match(/^num_samples\s+(\d+)/);
        if (nm) {
          numSamples = +nm[1];
          i++;
          break;
        }
        if (l.match(/^shape_id\s+\d+/) || l.startsWith("[")) break;
        i++;
      }
      if (numSamples <= 0) continue;
      const vals = [];
      while (i < lines.length && vals.length < numSamples) {
        const l = lines[i].trim();
        if (l.match(/^shape_id\s+\d+/) || l.startsWith("[")) break;
        if (!l || l.startsWith("#")) {
          i++;
          continue;
        }
        for (const n of l.split(/\s+/).map(Number).filter((x) => !isNaN(x))) {
          if (vals.length < numSamples) vals.push(n);
        }
        i++;
      }
      if (vals.length === 0) continue;
      storeShape(seq, shapeId, numSamples, vals);
    }
  }
  function storeShape(seq, id, num, raw) {
    const decompressed = raw.length === num ? new Float64Array(raw) : decompressShape(raw, num);
    seq.shapes.set(id, { numSamples: num, samples: decompressed });
  }
  function extractRasterTimes(seq) {
    const set = (key, field) => {
      const v = seq.definitions.get(key);
      if (v?.length) seq.rasterTimes[field] = v[0];
    };
    set("BlockDurationRaster", "blockDurationRaster");
    set("GradientRasterTime", "gradientRaster");
    set("RadiofrequencyRasterTime", "rfRaster");
    set("AdcRasterTime", "adcRaster");
  }

  // src/pulseq/decoder.ts
  var GAMMA_HZ_T = 42576e3;
  var DEFAULT_B0_T = 3;
  function getB0(seq) {
    const raw = seq.definitions.get("B0");
    if (raw && Array.isArray(raw) && raw.length > 0) return +raw[0];
    const raw2 = seq.definitions.get("b0") ?? seq.definitions.get("b_0");
    if (raw2 && Array.isArray(raw2) && raw2.length > 0) return +raw2[0];
    return DEFAULT_B0_T;
  }
  function effFreqOff(freqOffset, freqPPM, b0) {
    return freqOffset + freqPPM * 1e-6 * GAMMA_HZ_T * b0;
  }
  function effPhaseOff(phaseOffset, phasePPM, b0) {
    return phaseOffset + phasePPM * 1e-6 * GAMMA_HZ_T * b0;
  }
  function decodeAllBlocks(seq) {
    return decodeBlockRange(seq, 0, seq.blocks.length);
  }
  function decodeBlockRange(seq, startBlockIdx, endBlockIdx) {
    _trigCache.clear();
    _ncoCache.clear();
    const totalBlocks = seq.blocks.length;
    const s = Math.max(0, Math.min(startBlockIdx, totalBlocks));
    const e = Math.max(s, Math.min(endBlockIdx, totalBlocks));
    if (s >= e) return [];
    let cumulative = 0;
    for (let i = 0; i < Math.min(s, totalBlocks); i++) {
      cumulative += seq.blocks[i].dur * seq.rasterTimes.blockDurationRaster;
    }
    const decoded = [];
    for (let i = s; i < e; i++) {
      const block = seq.blocks[i];
      const dur = block.dur * seq.rasterTimes.blockDurationRaster;
      const db = { index: block.num, duration: dur, startTime: cumulative };
      if (block.rfId > 0) {
        const rf = seq.rfs.get(block.rfId);
        if (rf) db.rf = decodeRF(seq, rf, cumulative, dur);
      }
      db.gx = decodeGradient(seq, block.gxId, cumulative, dur, "gx");
      db.gy = decodeGradient(seq, block.gyId, cumulative, dur, "gy");
      db.gz = decodeGradient(seq, block.gzId, cumulative, dur, "gz");
      if (block.adcId > 0) {
        const adc = seq.adcs.get(block.adcId);
        if (adc) db.adc = decodeADC(adc, cumulative, seq);
      }
      if (block.extId > 0) {
        const ext = seq.extensions.get(block.extId);
        if (ext) decodeExtensions(seq, ext, db, cumulative);
      }
      decoded.push(db);
      cumulative += dur;
    }
    return decoded;
  }
  function getTotalDuration(seq) {
    let total = 0;
    for (const block of seq.blocks) {
      total += block.dur * seq.rasterTimes.blockDurationRaster;
    }
    return total;
  }
  function decodeRF(seq, rf, blockStart, _blockDur) {
    const raster = seq.rasterTimes.rfRaster;
    const rfStart = blockStart + rf.delay * raster;
    const b0 = getB0(seq);
    const freqFull = effFreqOff(rf.freqOffset, rf.freqPPM, b0);
    const phaseFull = effPhaseOff(rf.phaseOffset, rf.phasePPM, b0);
    const magShape = seq.shapes.get(rf.magShapeId);
    const nSamples = magShape?.numSamples ?? Math.max(2, Math.round(_blockDur / raster));
    const mag = magShape ? new Float64Array(magShape.samples) : makeConstant(nSamples, 1);
    const phShape = seq.shapes.get(rf.phaseShapeId);
    const ph = phShape ? new Float64Array(phShape.samples) : new Float64Array(mag.length);
    const timeShape = rf.timeShapeId > 0 ? seq.shapes.get(rf.timeShapeId)?.samples ?? null : null;
    const n = Math.min(mag.length, ph.length);
    const t = new Float64Array(n);
    const amp = new Float64Array(n);
    const phase = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = timeShape ? rfStart + timeShape[i] * raster : rfStart + (i + 0.5) * raster;
      amp[i] = rf.amplitude * mag[i];
      const dt = t[i] - rfStart;
      phase[i] = 2 * Math.PI * ph[i] + phaseFull + 2 * Math.PI * freqFull * dt;
    }
    const duration = n > 0 ? t[n - 1] - rfStart + raster : 0;
    let use = rf.use || "";
    if (!use || use === "u") {
      let faDeg = 0;
      for (let i = 1; i < n; i++) {
        const dt = t[i] - t[i - 1];
        faDeg += 360 * (amp[i] + amp[i - 1]) * 0.5 * dt;
      }
      use = faDeg >= 120 ? "r" : "e";
    }
    return {
      blockIndex: rf.id,
      startTime: rfStart,
      duration,
      timePoints: t,
      magnitude: amp,
      phase,
      amplitude: rf.amplitude,
      freqOffset: freqFull,
      phaseOffset: phaseFull,
      use
    };
  }
  function decodeGradient(seq, gradId, blockStart, blockDur, channel) {
    if (gradId <= 0) return zeroGradient(blockStart, blockDur, channel);
    const trap = seq.trapGrads.get(gradId);
    if (trap) return decodeTrap(trap, blockStart, channel);
    const arb = seq.arbitraryGrads.get(gradId);
    if (arb) return decodeArb(seq, arb, blockStart, channel);
    return zeroGradient(blockStart, blockDur, channel);
  }
  function zeroGradient(t0, dur, ch) {
    return {
      blockIndex: 0,
      startTime: t0,
      duration: dur,
      timePoints: new Float64Array([t0, t0 + dur]),
      waveform: new Float64Array([0, 0]),
      amplitude: 0,
      type: "none",
      channel: ch
    };
  }
  function decodeTrap(trap, blockStart, ch) {
    const rise = trap.rise * 1e-6;
    const flat = trap.flat * 1e-6;
    const fall = trap.fall * 1e-6;
    const delay = trap.delay * 1e-6;
    const gradStart = blockStart + delay;
    const tRel = [0, rise, rise + flat, rise + flat + fall];
    const wfRel = [0, trap.amplitude, trap.amplitude, 0];
    if (delay > 0) {
      const tp2 = new Float64Array(5);
      const wf2 = new Float64Array(5);
      tp2[0] = blockStart;
      wf2[0] = 0;
      for (let i = 0; i < 4; i++) {
        tp2[i + 1] = gradStart + tRel[i];
        wf2[i + 1] = wfRel[i];
      }
      return {
        blockIndex: trap.id,
        startTime: blockStart,
        duration: delay + rise + flat + fall,
        timePoints: tp2,
        waveform: wf2,
        amplitude: trap.amplitude,
        type: "trap",
        channel: ch
      };
    }
    const tp = new Float64Array(4);
    const wf = new Float64Array(4);
    for (let i = 0; i < 4; i++) {
      tp[i] = gradStart + tRel[i];
      wf[i] = wfRel[i];
    }
    return {
      blockIndex: trap.id,
      startTime: blockStart,
      duration: rise + flat + fall,
      timePoints: tp,
      waveform: wf,
      amplitude: trap.amplitude,
      type: "trap",
      channel: ch
    };
  }
  function decodeArb(seq, arb, blockStart, ch) {
    const shape = seq.shapes.get(arb.shapeId);
    if (!shape) return zeroGradient(blockStart, 0, ch);
    const raster = seq.rasterTimes.gradientRaster;
    const delay = arb.delay * raster;
    const gradStart = blockStart + delay;
    const n = shape.numSamples;
    const oversample = arb.timeId === -1 ? 2 : 1;
    const nOut = n * oversample;
    const timeShape = arb.timeId > 0 ? seq.shapes.get(arb.timeId)?.samples ?? null : null;
    const tp = new Float64Array(nOut);
    const wf = new Float64Array(nOut);
    if (timeShape) {
      for (let i = 0; i < n; i++) {
        tp[i] = gradStart + timeShape[i] * raster;
        wf[i] = arb.amplitude * shape.samples[i];
      }
    } else {
      const dt = raster / oversample;
      for (let i = 0; i < nOut; i++) {
        tp[i] = gradStart + (i + 0.5) * dt;
        const srcIdx = Math.floor(i / oversample);
        const frac = i % oversample / oversample;
        const s0 = shape.samples[Math.min(srcIdx, n - 1)];
        const s1 = shape.samples[Math.min(srcIdx + 1, n - 1)];
        const sv = s0 + (s1 - s0) * frac;
        wf[i] = arb.amplitude * sv;
      }
    }
    const dur = nOut > 0 ? tp[nOut - 1] - blockStart + raster : delay;
    return {
      blockIndex: arb.id,
      startTime: blockStart,
      duration: dur,
      timePoints: tp,
      waveform: wf,
      amplitude: arb.amplitude,
      type: "arb",
      channel: ch
    };
  }
  function decodeADC(adc, blockStart, seq) {
    const b0 = getB0(seq);
    const freqFull = effFreqOff(adc.freqOffset, adc.freqPPM, b0);
    const phaseFull = effPhaseOff(adc.phaseOffset, adc.phasePPM, b0);
    return {
      blockIndex: adc.id,
      startTime: blockStart,
      numSamples: adc.numSamples,
      dwell: adc.dwell * 1e-9,
      // ns → s
      delay: adc.delay * 1e-6,
      // µs → s
      freqOffset: freqFull,
      phaseOffset: phaseFull
    };
  }
  var _trigCache = /* @__PURE__ */ new Map();
  var _ncoCache = /* @__PURE__ */ new Map();
  function decodeExtensions(seq, ext, db, blockStart) {
    const visited = /* @__PURE__ */ new Set();
    let cur = ext;
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id);
      if (cur.type === 1) {
        let cached = _trigCache.get(cur.id);
        if (!cached) {
          cached = seq.triggers.map((t) => ({
            blockIndex: t.id,
            startTime: 0,
            // startTime filled per-block below
            channel: t.channel,
            delay: t.delay * 1e-6,
            duration: t.duration * 1e-6
          }));
          _trigCache.set(cur.id, cached);
        }
        db.triggers = cached.map((t) => ({ ...t, startTime: blockStart }));
      } else if (cur.type === 2) {
        let cached = _ncoCache.get(cur.id);
        if (!cached) {
          cached = seq.ncos.map((n) => ({
            blockIndex: n.id,
            startTime: 0,
            channel: n.channel,
            frequency: n.frequency,
            phase: n.phase,
            delay: n.delay * 1e-6,
            duration: n.duration * 1e-6
          }));
          _ncoCache.set(cur.id, cached);
        }
        db.nco = cached.map((n) => ({ ...n, startTime: blockStart }));
      }
      cur = cur.nextId > 0 ? seq.extensions.get(cur.nextId) : void 0;
    }
  }
  function makeConstant(n, value) {
    const a = new Float64Array(Math.max(n, 2));
    a.fill(value);
    return a;
  }

  // src/pulseq/kspace.ts
  function calculateKspace(blocks, gradientRaster, totalDuration, trajectoryDelay = 0, _options) {
    if (!blocks.length || !gradientRaster || gradientRaster <= 0) return null;
    const GR = gradientRaster;
    const tacc = 1e-10;
    const excT = [], refT = [];
    const gradBreaks = [];
    let totalAdcSamples = 0;
    for (const b of blocks) {
      if (b.adc) totalAdcSamples += b.adc.numSamples;
    }
    const adcT = new Float64Array(totalAdcSamples);
    let adcIdx = 0;
    for (const b of blocks) {
      collectBreaks(b.gx, gradBreaks);
      collectBreaks(b.gy, gradBreaks);
      collectBreaks(b.gz, gradBreaks);
      if (b.rf) {
        const iso = b.rf.startTime + b.rf.duration * 0.5;
        const u = b.rf.use || "";
        if (u === "e" || u === "" || u === "u") excT.push(iso);
        else if (u === "r") refT.push(iso);
      }
      if (b.adc) {
        const t0 = b.adc.startTime + b.adc.delay;
        const dwell = b.adc.dwell;
        const nSamp = b.adc.numSamples;
        for (let s = 0; s < nSamp; s++)
          adcT[adcIdx++] = t0 + (s + 0.5) * dwell + trajectoryDelay;
      }
    }
    const cand = [];
    const pushC = (t) => {
      if (isFinite(t) && t >= -tacc) cand.push(Math.max(0, tacc * Math.round(t / tacc)));
    };
    for (const t of gradBreaks) pushC(t);
    for (const t of excT) {
      pushC(t);
      pushC(t - GR);
    }
    for (const t of refT) {
      pushC(t);
      pushC(t - GR);
    }
    for (const t of adcT) pushC(t);
    pushC(0);
    pushC(totalDuration);
    if (totalDuration > 0) {
      const nS = Math.max(1, Math.round(totalDuration / GR));
      for (let i = 0; i <= nS; i++) pushC(i * GR);
    }
    if (cand.length === 0) return null;
    cand.sort((a, b) => a - b);
    const grid = [];
    for (let i = 0; i < cand.length; i++) {
      if (i === 0 || cand[i] - cand[i - 1] > tacc * 0.5) grid.push(cand[i]);
    }
    const N = grid.length;
    if (N < 2) return null;
    const gx = new Float64Array(N), gy = new Float64Array(N), gz = new Float64Array(N);
    const edges = [0];
    let cum = 0;
    for (const b of blocks) {
      cum += b.duration;
      edges.push(cum);
    }
    for (let i = 0; i < N; i++) {
      const t = grid[i];
      const bi = blockIdx(t, edges);
      if (bi >= 0 && bi < blocks.length) {
        gx[i] = gradVal(blocks[bi].gx, t);
        gy[i] = gradVal(blocks[bi].gy, t);
        gz[i] = gradVal(blocks[bi].gz, t);
      }
    }
    const kx = new Float64Array(N), ky = new Float64Array(N), kz = new Float64Array(N);
    for (let i = 1; i < N; i++) {
      const dt = grid[i] - grid[i - 1];
      if (dt <= 0) {
        kx[i] = kx[i - 1];
        ky[i] = ky[i - 1];
        kz[i] = kz[i - 1];
        continue;
      }
      const gxm = 0.5 * (gx[i - 1] + gx[i]), gym = 0.5 * (gy[i - 1] + gy[i]), gzm = 0.5 * (gz[i - 1] + gz[i]);
      kx[i] = kx[i - 1] + gxm * dt;
      ky[i] = ky[i - 1] + gym * dt;
      kz[i] = kz[i - 1] + gzm * dt;
    }
    const eIdx = [], rIdx = [];
    for (const t of excT) {
      const i = timeIdx(t, grid);
      if (i >= 0) eIdx.push(i);
    }
    for (const t of refT) {
      const i = timeIdx(t, grid);
      if (i >= 0) rIdx.push(i);
    }
    eIdx.sort((a, b) => a - b);
    rIdx.sort((a, b) => a - b);
    const bounds = [0];
    for (const i of eIdx) bounds.push(i);
    for (const i of rIdx) bounds.push(i);
    bounds.push(N - 1);
    bounds.sort((a, b) => a - b);
    const bUniq = [bounds[0]];
    for (let i = 1; i < bounds.length; i++) if (bounds[i] !== bUniq[bUniq.length - 1]) bUniq.push(bounds[i]);
    let dkX = -kx[0], dkY = -ky[0], dkZ = -kz[0];
    let pE = 0, pR = 0;
    for (let s = 0; s < bUniq.length - 1; s++) {
      const st = bUniq[s], en = bUniq[s + 1];
      if (pE < eIdx.length && eIdx[pE] === st) {
        dkX = -kx[st];
        dkY = -ky[st];
        dkZ = -kz[st];
        pE++;
      } else if (pR < rIdx.length && rIdx[pR] === st) {
        dkX = -2 * kx[st] - dkX;
        dkY = -2 * ky[st] - dkY;
        dkZ = -2 * kz[st] - dkZ;
        pR++;
      }
      for (let j = st; j < en; j++) {
        kx[j] += dkX;
        ky[j] += dkY;
        kz[j] += dkZ;
      }
    }
    kx[N - 1] += dkX;
    ky[N - 1] += dkY;
    kz[N - 1] += dkZ;
    const kxP = new Float64Array(kx), kyP = new Float64Array(ky), kzP = new Float64Array(kz);
    for (const i of eIdx) {
      if (i > 0) {
        kxP[i - 1] = NaN;
        kyP[i - 1] = NaN;
        kzP[i - 1] = NaN;
      }
    }
    const nA = adcT.length;
    const kxA = new Float64Array(nA), kyA = new Float64Array(nA), kzA = new Float64Array(nA);
    for (let a = 0; a < nA; a++) {
      kxA[a] = interp(kx, grid, adcT[a]);
      kyA[a] = interp(ky, grid, adcT[a]);
      kzA[a] = interp(kz, grid, adcT[a]);
    }
    return { ktraj: [kxP, kyP, kzP], t_ktraj: new Float64Array(grid), ktraj_adc: [kxA, kyA, kzA], t_adc: new Float64Array(adcT) };
  }
  function collectBreaks(g, breaks) {
    if (!g || g.type === "none" || !g.timePoints || g.timePoints.length < 2) return;
    breaks.push(g.timePoints[0], g.timePoints[g.timePoints.length - 1]);
  }
  function gradVal(g, t) {
    if (!g || g.type === "none") return 0;
    const tp = g.timePoints, wf = g.waveform;
    if (!tp || tp.length < 2) return 0;
    if (t < tp[0] || t > tp[tp.length - 1]) return 0;
    let lo = 0, hi = tp.length - 1;
    while (hi - lo > 1) {
      const m = lo + hi >> 1;
      if (tp[m] <= t) lo = m;
      else hi = m;
    }
    const s = tp[hi] - tp[lo];
    if (s <= 0) return wf[lo];
    return wf[lo] + (wf[hi] - wf[lo]) * (t - tp[lo]) / s;
  }
  function blockIdx(t, edges) {
    let lo = 0, hi = edges.length - 1;
    while (lo < hi) {
      const m = lo + hi >> 1;
      if (edges[m] <= t + 1e-12) lo = m + 1;
      else hi = m;
    }
    return Math.max(0, lo - 1);
  }
  function timeIdx(t, g) {
    let lo = 0, hi = g.length;
    while (lo < hi) {
      const m = lo + hi >> 1;
      if (g[m] < t - 1e-12) lo = m + 1;
      else hi = m;
    }
    return lo < g.length ? lo : -1;
  }
  function interp(d, g, t) {
    const n = g.length;
    if (n === 0) return 0;
    let lo = 0, hi = n;
    while (lo < hi) {
      const m = lo + hi >> 1;
      if (g[m] < t) lo = m + 1;
      else hi = m;
    }
    if (lo === 0) return d[0];
    if (lo >= n) return d[n - 1];
    if (Math.abs(g[lo] - t) < 1e-12) return d[lo];
    const i0 = lo - 1, i1 = lo, dt = g[i1] - g[i0];
    if (dt <= 0) return d[i1];
    return d[i0] + (d[i1] - d[i0]) * (t - g[i0]) / dt;
  }

  // src/pulseq/trdetect.ts
  var GAMMA_HZ_T2 = 42576e3;
  var DEFAULT_B0_T2 = 3;
  function detectSequenceTiming(seq) {
    const b0 = getB02(seq);
    const supportsRfUse = seq.versionCombined >= 1005e3;
    let teTimeSec = 0;
    let hasExplicitTE = false;
    const teDef = seq.definitions.get("EchoTime") ?? seq.definitions.get("TE");
    if (teDef && teDef.length > 0) {
      teTimeSec = teDef[0];
      hasExplicitTE = true;
    }
    let trTimeSec = 0;
    let hasExplicitTR = false;
    const trDef = seq.definitions.get("RepetitionTime") ?? seq.definitions.get("TR");
    if (trDef && trDef.length > 0) {
      trTimeSec = trDef[0];
      hasExplicitTR = true;
    }
    const rfUsePerBlock = [];
    const excitationTimesSec = [];
    let rfUseGuessed = false;
    const blockStartTimes = computeCumulativeTimes(seq);
    for (let i = 0; i < seq.blocks.length; i++) {
      const blk = seq.blocks[i];
      if (blk.rfId <= 0) {
        rfUsePerBlock.push(0);
        continue;
      }
      const rf = seq.rfs.get(blk.rfId);
      if (!rf) {
        rfUsePerBlock.push(0);
        continue;
      }
      const useChar = classifyRfUse(rf, supportsRfUse, b0);
      const useCode = useChar.charCodeAt(0);
      rfUsePerBlock.push(useCode);
      if (useChar === "e") {
        const rfRaster = seq.rasterTimes.rfRaster;
        const center = rf.center >= 0 ? rf.center * 1e-6 : estimateRfCenter(rf, seq);
        const excTime = blockStartTimes[i] + rf.delay * rfRaster + center;
        excitationTimesSec.push(excTime);
      }
      if (!supportsRfUse && useChar !== "u") rfUseGuessed = true;
    }
    let trCount = 0;
    const trStartBlocks = [];
    if (!hasExplicitTR && excitationTimesSec.length >= 2) {
      trTimeSec = estimateTRFromExcitations(excitationTimesSec);
      hasExplicitTR = false;
    }
    if (trTimeSec > 0) {
      const totalDuration = blockStartTimes.length > 0 ? blockStartTimes[blockStartTimes.length - 1] + seq.blocks[seq.blocks.length - 1].dur * seq.rasterTimes.blockDurationRaster : 0;
      trCount = Math.max(1, Math.ceil(totalDuration / trTimeSec));
      const tol = trTimeSec * 0.3;
      let trIdx = 0;
      for (let i = 0; i < seq.blocks.length; i++) {
        const blkStart = blockStartTimes[i];
        const expected = trIdx * trTimeSec;
        if (blkStart >= expected - tol && trIdx < trCount) {
          trStartBlocks.push(i);
          trIdx++;
        }
      }
      trStartBlocks.push(seq.blocks.length);
      trCount = trStartBlocks.length - 1;
    } else {
      trCount = 0;
      for (let i = 0; i < seq.blocks.length; i++) {
        if (seq.blocks[i].adcId > 0) {
          trStartBlocks.push(i);
          trCount++;
        }
      }
      trStartBlocks.push(seq.blocks.length);
    }
    return {
      teTimeSec,
      hasExplicitTE,
      trTimeSec,
      hasExplicitTR,
      trCount,
      trStartBlocks,
      excitationTimesSec,
      rfUseGuessed,
      rfUsePerBlock
    };
  }
  function getB02(seq) {
    const raw = seq.definitions.get("B0") ?? seq.definitions.get("b0") ?? seq.definitions.get("b_0");
    if (raw && Array.isArray(raw) && raw.length > 0) return +raw[0];
    return DEFAULT_B0_T2;
  }
  function computeCumulativeTimes(seq) {
    const times = [];
    let cum = 0;
    for (const blk of seq.blocks) {
      times.push(cum);
      cum += blk.dur * seq.rasterTimes.blockDurationRaster;
    }
    return times;
  }
  function classifyRfUse(rf, supportsMetadata, b0Tesla) {
    if (supportsMetadata && rf.use && rf.use !== "u" && rf.use !== "U") {
      return rf.use.toLowerCase();
    }
    const faDeg = estimateFlipAngleDeg(rf);
    if (faDeg < 90.01) return "e";
    const freqPPM = rf.freqPPM !== 0 ? rf.freqPPM : b0Tesla > 0 ? 1e6 * rf.freqOffset / (GAMMA_HZ_T2 * b0Tesla) : 0;
    const durEst = 0;
    if (durEst > 6e-3 && freqPPM >= -4.5 && freqPPM <= -3) return "s";
    return "r";
  }
  function estimateFlipAngleDeg(rf) {
    const absAmp = Math.abs(rf.amplitude);
    if (absAmp > 3e3) return 180;
    if (absAmp > 1500) return 120;
    return 90;
  }
  function estimateRfCenter(rf, _seq) {
    return 0;
  }
  function estimateTRFromExcitations(excTimesSec) {
    if (excTimesSec.length < 2) return 0;
    const intervals = [];
    for (let i = 1; i < excTimesSec.length; i++) {
      const dt = excTimesSec[i] - excTimesSec[i - 1];
      if (dt > 1e-9) intervals.push(dt);
    }
    if (intervals.length === 0) return 0;
    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];
    const niceMs = niceRound(median * 1e3, 10);
    return niceMs * 1e-3;
  }
  function niceRound(value, base) {
    return Math.round(value / base) * base;
  }
  return __toCommonJS(pulseq_browser_exports);
})();
