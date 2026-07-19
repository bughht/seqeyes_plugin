"use strict";
var Pulseq = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
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
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // web/pulseq-browser.ts
  var pulseq_browser_exports = {};
  __export(pulseq_browser_exports, {
    INTERACTIVE_COMPUTE_LIMITS: () => INTERACTIVE_COMPUTE_LIMITS,
    PACKAGE_VERSION: () => PACKAGE_VERSION,
    calculateKspace: () => calculateKspace,
    calculateM1: () => calculateM1,
    calculateM1Coarse: () => calculateM1Coarse,
    calculatePns: () => calculatePns,
    calculatePnsCoarse: () => calculatePnsCoarse,
    decodeAllBlocks: () => decodeAllBlocks,
    detectSequenceTiming: () => detectSequenceTiming,
    estimateDerivedCost: () => estimateDerivedCost,
    estimateKspaceCost: () => estimateKspaceCost,
    estimateKspacePeakMemoryBytes: () => estimateKspacePeakMemoryBytes,
    exportKspaceArtifacts: () => exportKspaceArtifacts,
    exportKspaceArtifactsFromBytes: () => exportKspaceArtifactsFromBytes,
    exportKspaceArtifactsFromSequence: () => exportKspaceArtifactsFromSequence,
    formatMemorySize: () => formatMemorySize,
    formatSampleCount: () => formatSampleCount,
    formatTrajectoryText: () => formatTrajectoryText,
    getTotalDuration: () => getTotalDuration,
    hasPulseqBinaryMagic: () => hasPulseqBinaryMagic,
    parsePnsHardwareAsc: () => parsePnsHardwareAsc,
    parseSequenceBinary: () => parseSequenceBinary,
    parseSequenceBytes: () => parseSequenceBytes,
    parseSequenceText: () => parseSequenceText,
    safePnsModel: () => safePnsModel,
    selectM1WindowBlocks: () => selectM1WindowBlocks,
    selectPnsWindowBlocks: () => selectPnsWindowBlocks
  });

  // package.json
  var version = "0.2.8";

  // src/pulseq/decompressor.ts
  function decompressShape(compressed, numSamples) {
    const packedLen = compressed.length;
    if (!Number.isInteger(numSamples) || numSamples <= 0) {
      throw new Error(`Invalid shape sample count: ${numSamples}`);
    }
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
        if (iPacked + 2 >= packedLen) {
          throw new Error("Malformed compressed shape: repeat marker is missing its count");
        }
        const value = compressed[iPacked];
        const rawRepeat = compressed[iPacked + 2];
        const repeatCount = Math.round(rawRepeat) + 2;
        if (Math.abs(rawRepeat + 2 - repeatCount) > 1e-6 || repeatCount < 2) {
          throw new Error(`Malformed compressed shape: invalid repeat count ${rawRepeat}`);
        }
        if (iUnpacked + repeatCount > numSamples) {
          throw new Error("Malformed compressed shape: repeat block exceeds expected sample count");
        }
        iPacked += 3;
        const end = iUnpacked + repeatCount;
        while (iUnpacked < end) {
          result[iUnpacked] = value;
          iUnpacked++;
        }
      }
    }
    if (iUnpacked !== numSamples) {
      throw new Error(`Malformed compressed shape: expected ${numSamples} samples, decoded ${iUnpacked}`);
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
  var VER_V15001 = 1005001;
  function makeVersionCombined(major, minor, revision) {
    return major * 1e6 + minor * 1e3 + revision;
  }

  // src/pulseq/readerShared.ts
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
      extensionNames: /* @__PURE__ */ new Map(),
      extensionTypes: /* @__PURE__ */ new Map(),
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
  function parseError(message) {
    throw new Error(`Pulseq parse error: ${message}`);
  }
  function extensionNameToType(name) {
    switch (name.toUpperCase()) {
      case "TRIGGERS":
        return 1 /* EXT_TRIGGER */;
      case "ROTATIONS":
        return 2 /* EXT_ROTATION */;
      case "LABELSET":
        return 3 /* EXT_LABELSET */;
      case "LABELINC":
        return 4 /* EXT_LABELINC */;
      case "DELAYS":
        return 5 /* EXT_DELAY */;
      case "RF_SHIMS":
        return 6 /* EXT_RF_SHIM */;
      case "NCO":
        return 100 /* EXT_NCO */;
      default:
        return 999 /* EXT_UNKNOWN */;
    }
  }
  var KNOWN_LABELS = {
    "SLC": { labelId: 0, flagId: 0 },
    "SEG": { labelId: 1, flagId: 0 },
    "REP": { labelId: 2, flagId: 0 },
    "AVG": { labelId: 3, flagId: 0 },
    "ECO": { labelId: 4, flagId: 0 },
    "PHS": { labelId: 5, flagId: 0 },
    "SET": { labelId: 6, flagId: 0 },
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
  var unknownLabelCounter = 0;
  var unknownLabels = /* @__PURE__ */ new Map();
  function resetUnknownLabels() {
    unknownLabelCounter = 0;
    unknownLabels.clear();
  }
  function decodeLabel(name) {
    const known = KNOWN_LABELS[name];
    if (known) return known;
    let id = unknownLabels.get(name);
    if (id === void 0) {
      id = 1e3 + unknownLabelCounter++;
      unknownLabels.set(name, id);
    }
    return { labelId: id, flagId: 0 };
  }
  function extractRasterTimes(seq) {
    const set = (key, field) => {
      const value = seq.definitions.get(key);
      if (value?.length) seq.rasterTimes[field] = value[0];
    };
    set("BlockDurationRaster", "blockDurationRaster");
    set("GradientRasterTime", "gradientRaster");
    set("RadiofrequencyRasterTime", "rfRaster");
    set("AdcRasterTime", "adcRaster");
  }
  function validateSequence(seq, seenSections) {
    if (!seenSections.has("VERSION")) parseError("Required [VERSION] section is missing");
    if (seq.version.major !== 1 || seq.version.minor > 5) {
      parseError(`Unsupported Pulseq version ${seq.version.major}.${seq.version.minor}.${seq.version.revision}`);
    }
    const version2 = seq.versionCombined > 0 ? seq.versionCombined : makeVersionCombined(seq.version.major, seq.version.minor, seq.version.revision);
    if (version2 >= VER_PRE_14) {
      requireNumericDefinition(seq, "AdcRasterTime");
      requireNumericDefinition(seq, "GradientRasterTime");
      requireNumericDefinition(seq, "RadiofrequencyRasterTime");
      requireNumericDefinition(seq, "BlockDurationRaster");
    }
    if (version2 >= VER_V15001) {
      const required = seq.definitionsRaw.get("RequiredExtensions")?.split(/\s+/).filter(Boolean) ?? [];
      for (const name of required) {
        if (extensionNameToType(name) === 999 /* EXT_UNKNOWN */) {
          parseError(`Unknown required extension '${name}'`);
        }
      }
    }
    if (!seenSections.has("BLOCKS")) parseError("Required [BLOCKS] section is missing");
    for (const block of seq.blocks) {
      if (block.rfId > 0 && !seq.rfs.has(block.rfId)) {
        parseError(`Block ${block.num} references undefined RF event ${block.rfId}`);
      }
      for (const [channel, gradId] of [["GX", block.gxId], ["GY", block.gyId], ["GZ", block.gzId]]) {
        if (gradId > 0 && !seq.arbitraryGrads.has(gradId) && !seq.trapGrads.has(gradId)) {
          parseError(`Block ${block.num} references undefined ${channel} gradient event ${gradId}`);
        }
      }
      if (block.adcId > 0 && !seq.adcs.has(block.adcId)) {
        parseError(`Block ${block.num} references undefined ADC event ${block.adcId}`);
      }
      if (block.extId > 0 && !seq.extensions.has(block.extId)) {
        parseError(`Block ${block.num} references undefined extension list ${block.extId}`);
      }
    }
    for (const ext of seq.extensions.values()) {
      if (ext.nextId > 0 && !seq.extensions.has(ext.nextId)) {
        parseError(`Extension list ${ext.id} references undefined next extension ${ext.nextId}`);
      }
      const type = seq.extensionTypes.get(ext.type) ?? 999 /* EXT_UNKNOWN */;
      if (type === 999 /* EXT_UNKNOWN */) continue;
      if (!extensionPayloadExists(seq, type, ext.ref)) {
        const name = seq.extensionNames.get(ext.type) ?? `type ${ext.type}`;
        parseError(`Extension list ${ext.id} references undefined ${name} payload ${ext.ref}`);
      }
    }
  }
  function requireNumericDefinition(seq, name) {
    const value = seq.definitions.get(name);
    if (!value || value.length === 0 || !Number.isFinite(value[0])) {
      parseError(`Required definition ${name} is not present in the file`);
    }
  }
  function extensionPayloadExists(seq, type, ref) {
    switch (type) {
      case 1 /* EXT_TRIGGER */:
        return seq.triggers.some((value) => value.id === ref);
      case 2 /* EXT_ROTATION */:
        return seq.rotations.some((value) => value.id === ref);
      case 3 /* EXT_LABELSET */:
        return seq.labelSets.some((value) => value.id === ref);
      case 4 /* EXT_LABELINC */:
        return seq.labelIncs.some((value) => value.id === ref);
      case 5 /* EXT_DELAY */:
        return seq.softDelays.some((value) => value.id === ref);
      case 6 /* EXT_RF_SHIM */:
        return seq.rfShims.some((value) => value.id === ref);
      case 100 /* EXT_NCO */:
        return seq.ncos.some((value) => value.id === ref);
      default:
        return false;
    }
  }

  // src/pulseq/reader.ts
  function parseSequenceText(text) {
    const seq = createEmptySequence();
    const seenSections = /* @__PURE__ */ new Set();
    const shapeParser = new ShapeSectionParser(seq);
    let sectionName = null;
    let sectionLines = [];
    forEachLine(text, (line) => {
      const m = line.match(/^\[(\w+)\]$/);
      if (m) {
        if (sectionName === "SHAPES") shapeParser.finish();
        else if (sectionName) dispatchSection(seq, sectionName, sectionLines);
        sectionName = m[1];
        seenSections.add(sectionName);
        sectionLines = [];
      } else if (sectionName === "SHAPES") {
        shapeParser.consume(line);
      } else {
        sectionLines.push(line);
      }
    });
    if (sectionName === "SHAPES") shapeParser.finish();
    else if (sectionName) dispatchSection(seq, sectionName, sectionLines);
    seq.versionCombined = makeVersionCombined(
      seq.version.major,
      seq.version.minor,
      seq.version.revision
    );
    extractRasterTimes(seq);
    validateSequence(seq, seenSections);
    return seq;
  }
  function forEachLine(text, visit) {
    let start = 0;
    while (start <= text.length) {
      let end = text.indexOf("\n", start);
      if (end < 0) end = text.length;
      const contentEnd = end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
      visit(text.slice(start, contentEnd));
      if (end === text.length) break;
      start = end + 1;
    }
  }
  function dispatchSection(seq, name, lines) {
    if (name === "SHAPES") {
      parseShapes(seq, lines);
      return;
    }
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
    }
  }
  function ver(seq) {
    if (seq.versionCombined > 0) return seq.versionCombined;
    return makeVersionCombined(seq.version.major, seq.version.minor, seq.version.revision);
  }
  function requireFieldCount(section, line, count, allowed) {
    const allowedCounts = Array.isArray(allowed) ? allowed : [allowed];
    if (!allowedCounts.includes(count)) {
      parseError(`${section} row has ${count} fields, expected ${allowedCounts.join(" or ")}: ${line}`);
    }
  }
  function toNumber(value, section, line) {
    const n = Number(value);
    if (!Number.isFinite(n)) parseError(`${section} row contains a non-numeric field '${value}': ${line}`);
    return n;
  }
  function toInt(value, section, line) {
    const n = toNumber(value, section, line);
    if (!Number.isInteger(n)) parseError(`${section} row contains a non-integer field '${value}': ${line}`);
    return n;
  }
  function splitFields(line) {
    return line.trim().split(/\s+/);
  }
  function parseVersion(seq, lines) {
    for (const line of lines) {
      const p = splitFields(line);
      requireFieldCount("VERSION", line, p.length, 2);
      const [k, v] = p;
      const n = toInt(v, "VERSION", line);
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
      const p = splitFields(line);
      requireFieldCount("BLOCKS", line, p.length, [7, 8]);
      const num = toInt(p[0], "BLOCKS", line);
      const extId = p.length === 8 ? toInt(p[7], "BLOCKS", line) : 0;
      if (vc < VER_PRE_14) {
        seq.blocks.push({
          num,
          dur: toNumber(p[1], "BLOCKS", line),
          rfId: toInt(p[2], "BLOCKS", line),
          gxId: toInt(p[3], "BLOCKS", line),
          gyId: toInt(p[4], "BLOCKS", line),
          gzId: toInt(p[5], "BLOCKS", line),
          adcId: toInt(p[6], "BLOCKS", line),
          extId
        });
      } else {
        seq.blocks.push({
          num,
          dur: toNumber(p[1], "BLOCKS", line),
          rfId: toInt(p[2], "BLOCKS", line),
          gxId: toInt(p[3], "BLOCKS", line),
          gyId: toInt(p[4], "BLOCKS", line),
          gzId: toInt(p[5], "BLOCKS", line),
          adcId: toInt(p[6], "BLOCKS", line),
          extId
        });
      }
    }
  }
  function parseRF(seq, lines) {
    const vc = ver(seq);
    for (const line of lines) {
      const parts = splitFields(line);
      const id = toInt(parts[0], "RF", line);
      const amp = toNumber(parts[1], "RF", line);
      const magId = toInt(parts[2], "RF", line);
      const phId = toInt(parts[3], "RF", line);
      if (vc >= VER_V15) {
        requireFieldCount("RF", line, parts.length, 12);
        const use = parts[11].toLowerCase();
        if (!/^[erisu]$/.test(use)) parseError(`RF row has invalid use flag '${parts[11]}': ${line}`);
        seq.rfs.set(id, {
          id,
          amplitude: amp,
          magShapeId: magId,
          phaseShapeId: phId,
          timeShapeId: toInt(parts[4], "RF", line),
          center: toNumber(parts[5], "RF", line),
          delay: toNumber(parts[6], "RF", line),
          freqPPM: toNumber(parts[7], "RF", line),
          phasePPM: toNumber(parts[8], "RF", line),
          freqOffset: toNumber(parts[9], "RF", line),
          phaseOffset: toNumber(parts[10], "RF", line),
          phaseModShapeId: 0,
          use
        });
      } else if (vc >= VER_PRE_14) {
        requireFieldCount("RF", line, parts.length, 8);
        seq.rfs.set(id, {
          id,
          amplitude: amp,
          magShapeId: magId,
          phaseShapeId: phId,
          timeShapeId: toInt(parts[4], "RF", line),
          center: -1,
          // not in v1.4.x
          delay: toNumber(parts[5], "RF", line),
          freqPPM: 0,
          phasePPM: 0,
          freqOffset: toNumber(parts[6], "RF", line),
          phaseOffset: toNumber(parts[7], "RF", line),
          phaseModShapeId: 0,
          use: "u"
        });
      } else {
        requireFieldCount("RF", line, parts.length, 7);
        seq.rfs.set(id, {
          id,
          amplitude: amp,
          magShapeId: magId,
          phaseShapeId: phId,
          timeShapeId: 0,
          center: -1,
          delay: toNumber(parts[4], "RF", line),
          freqPPM: 0,
          phasePPM: 0,
          freqOffset: toNumber(parts[5], "RF", line),
          phaseOffset: toNumber(parts[6], "RF", line),
          phaseModShapeId: 0,
          use: "u"
        });
      }
    }
  }
  function parseArbitraryGrads(seq, lines) {
    const vc = ver(seq);
    for (const line of lines) {
      const p = splitFields(line);
      const id = toInt(p[0], "GRADIENTS", line);
      if (vc >= VER_V15) {
        requireFieldCount("GRADIENTS", line, p.length, 7);
        seq.arbitraryGrads.set(id, {
          id,
          amplitude: toNumber(p[1], "GRADIENTS", line),
          first: toNumber(p[2], "GRADIENTS", line),
          last: toNumber(p[3], "GRADIENTS", line),
          shapeId: toInt(p[4], "GRADIENTS", line),
          timeId: toInt(p[5], "GRADIENTS", line),
          delay: toNumber(p[6], "GRADIENTS", line)
        });
      } else if (vc >= VER_PRE_14) {
        requireFieldCount("GRADIENTS", line, p.length, 5);
        seq.arbitraryGrads.set(id, {
          id,
          amplitude: toNumber(p[1], "GRADIENTS", line),
          first: NaN,
          last: NaN,
          shapeId: toInt(p[2], "GRADIENTS", line),
          timeId: toInt(p[3], "GRADIENTS", line),
          delay: toNumber(p[4], "GRADIENTS", line)
        });
      } else {
        requireFieldCount("GRADIENTS", line, p.length, 4);
        seq.arbitraryGrads.set(id, {
          id,
          amplitude: toNumber(p[1], "GRADIENTS", line),
          first: NaN,
          last: NaN,
          shapeId: toInt(p[2], "GRADIENTS", line),
          timeId: 0,
          delay: toNumber(p[3], "GRADIENTS", line)
        });
      }
    }
  }
  function parseTrapGrads(seq, lines) {
    for (const line of lines) {
      const p = splitFields(line);
      requireFieldCount("TRAP", line, p.length, 6);
      const id = toInt(p[0], "TRAP", line);
      seq.trapGrads.set(id, {
        id,
        amplitude: toNumber(p[1], "TRAP", line),
        rise: toNumber(p[2], "TRAP", line),
        flat: toNumber(p[3], "TRAP", line),
        fall: toNumber(p[4], "TRAP", line),
        delay: toNumber(p[5], "TRAP", line)
      });
    }
  }
  function parseADC(seq, lines) {
    const vc = ver(seq);
    for (const line of lines) {
      const p = splitFields(line);
      const id = toInt(p[0], "ADC", line);
      if (vc >= VER_V15) {
        requireFieldCount("ADC", line, p.length, 9);
        seq.adcs.set(id, {
          id,
          numSamples: toInt(p[1], "ADC", line),
          dwell: toNumber(p[2], "ADC", line),
          delay: toNumber(p[3], "ADC", line),
          freqPPM: toNumber(p[4], "ADC", line),
          phasePPM: toNumber(p[5], "ADC", line),
          freqOffset: toNumber(p[6], "ADC", line),
          phaseOffset: toNumber(p[7], "ADC", line),
          deadTime: 0,
          discardPre: 0,
          discardPost: 0,
          phaseModShapeId: toInt(p[8], "ADC", line)
        });
      } else {
        requireFieldCount("ADC", line, p.length, 6);
        seq.adcs.set(id, {
          id,
          numSamples: toInt(p[1], "ADC", line),
          dwell: toNumber(p[2], "ADC", line),
          delay: toNumber(p[3], "ADC", line),
          freqPPM: 0,
          phasePPM: 0,
          freqOffset: toNumber(p[4], "ADC", line),
          phaseOffset: toNumber(p[5], "ADC", line),
          deadTime: 0,
          discardPre: 0,
          discardPost: 0,
          phaseModShapeId: 0
        });
      }
    }
  }
  function parseExtensions(seq, valid) {
    const vc = ver(seq);
    resetUnknownLabels();
    let i = 0;
    while (i < valid.length) {
      const line = valid[i].trim();
      if (line.startsWith("extension ")) break;
      const p = splitFields(line);
      requireFieldCount("EXTENSIONS", line, p.length, 4);
      const id = toInt(p[0], "EXTENSIONS", line);
      seq.extensions.set(id, {
        id,
        type: toInt(p[1], "EXTENSIONS", line),
        ref: toInt(p[2], "EXTENSIONS", line),
        nextId: toInt(p[3], "EXTENSIONS", line)
      });
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
      seq.extensionNames.set(extId, extName);
      seq.extensionTypes.set(extId, extensionNameToType(extName));
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
      const p = splitFields(line);
      requireFieldCount("TRIGGERS", line, p.length, 5);
      seq.triggers.push({
        id: toInt(p[0], "TRIGGERS", line),
        triggerType: toInt(p[1], "TRIGGERS", line),
        channel: toInt(p[2], "TRIGGERS", line),
        delay: toNumber(p[3], "TRIGGERS", line),
        duration: toNumber(p[4], "TRIGGERS", line)
      });
    }
  }
  function parseNCOSpecs(seq, lines) {
    for (const line of lines) {
      const p = splitFields(line);
      requireFieldCount("NCO", line, p.length, 6);
      seq.ncos.push({
        id: toInt(p[0], "NCO", line),
        channel: toInt(p[1], "NCO", line),
        frequency: toNumber(p[2], "NCO", line),
        phase: toNumber(p[3], "NCO", line),
        delay: toNumber(p[4], "NCO", line),
        duration: toNumber(p[5], "NCO", line)
      });
    }
  }
  function parseRotationSpecs(seq, lines, vc) {
    for (const line of lines) {
      const p = splitFields(line);
      if (vc >= VER_V15) {
        requireFieldCount("ROTATIONS", line, p.length, 5);
        const [q0, q1, q2, q3] = [
          toNumber(p[1], "ROTATIONS", line),
          toNumber(p[2], "ROTATIONS", line),
          toNumber(p[3], "ROTATIONS", line),
          toNumber(p[4], "ROTATIONS", line)
        ];
        const norm = Math.sqrt(q0 * q0 + q1 * q1 + q2 * q2 + q3 * q3);
        if (Math.abs(norm - 1) > 1e-3 || norm === 0) {
          parseError(`ROTATIONS row has a non-normalized quaternion: ${line}`);
        }
        seq.rotations.push({
          id: toInt(p[0], "ROTATIONS", line),
          values: [q0 / norm, q1 / norm, q2 / norm, q3 / norm]
        });
      } else {
        requireFieldCount("ROTATIONS", line, p.length, 10);
        seq.rotations.push({
          id: toInt(p[0], "ROTATIONS", line),
          values: p.slice(1, 10).map((v) => toNumber(v, "ROTATIONS", line))
        });
      }
    }
  }
  function parseLabelSpecs(seq, lines, isSet) {
    for (const line of lines) {
      const p = splitFields(line);
      requireFieldCount(isSet ? "LABELSET" : "LABELINC", line, p.length, 3);
      const { labelId, flagId } = decodeLabel(p[2]);
      const spec = {
        id: toInt(p[0], isSet ? "LABELSET" : "LABELINC", line),
        value: toNumber(p[1], isSet ? "LABELSET" : "LABELINC", line),
        labelId,
        flagId
      };
      if (isSet) seq.labelSets.push(spec);
      else seq.labelIncs.push(spec);
    }
  }
  function parseSoftDelaySpecs(seq, lines) {
    for (const line of lines) {
      const p = splitFields(line);
      if (p.length < 4) parseError(`DELAYS row has ${p.length} fields, expected at least 4: ${line}`);
      const hintMatch = line.match(/^\s*\S+\s+\S+\s+\S+\s+\S+\s*(.*)$/);
      seq.softDelays.push({
        id: toInt(p[0], "DELAYS", line),
        numId: toInt(p[1], "DELAYS", line),
        offset: toNumber(p[2], "DELAYS", line),
        factor: toNumber(p[3], "DELAYS", line),
        hint: hintMatch ? hintMatch[1].trim() : ""
      });
    }
  }
  function parseRFShimSpecs(seq, lines) {
    for (const line of lines) {
      const p = splitFields(line);
      if (p.length < 2) parseError(`RF_SHIMS row has ${p.length} fields, expected at least 2: ${line}`);
      const nChan = toInt(p[1], "RF_SHIMS", line);
      requireFieldCount("RF_SHIMS", line, p.length, 2 + nChan * 2);
      const amps = [];
      const phases = [];
      for (let c = 0; c < nChan; c++) {
        amps.push(toNumber(p[2 + c * 2], "RF_SHIMS", line));
        phases.push(toNumber(p[2 + c * 2 + 1], "RF_SHIMS", line));
      }
      seq.rfShims.push({ id: toInt(p[0], "RF_SHIMS", line), nChannels: nChan, amplitudes: amps, phases });
    }
  }
  function parseShapes(seq, lines) {
    const parser = new ShapeSectionParser(seq);
    for (const line of lines) parser.consume(line);
    parser.finish();
  }
  var ShapeSectionParser = class {
    constructor(seq) {
      __publicField(this, "seq", seq);
      __publicField(this, "shapeId", 0);
      __publicField(this, "numSamples", 0);
      __publicField(this, "raw", new Float64Array());
      __publicField(this, "rawCount", 0);
    }
    consume(line) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const shapeMatch = /^shape_id\s+(\d+)/.exec(trimmed);
      if (shapeMatch) {
        this.storeCurrent();
        this.shapeId = Number(shapeMatch[1]);
        return;
      }
      const countMatch = /^num_samples\s+(\d+)/.exec(trimmed);
      if (countMatch) {
        this.numSamples = Number(countMatch[1]);
        this.raw = new Float64Array(Math.min(this.numSamples, 1024));
        this.rawCount = 0;
        return;
      }
      if (this.shapeId <= 0 || this.numSamples <= 0 || this.rawCount >= this.numSamples) return;
      if (!/\s/.test(trimmed)) {
        this.appendRawValue(trimmed);
        return;
      }
      for (const field of trimmed.split(/\s+/)) {
        this.appendRawValue(field);
        if (this.rawCount >= this.numSamples) break;
      }
    }
    finish() {
      this.storeCurrent();
    }
    ensureRawCapacity() {
      if (this.rawCount < this.raw.length) return;
      const nextLength = Math.min(this.numSamples, Math.max(1, this.raw.length * 2));
      const expanded = new Float64Array(nextLength);
      expanded.set(this.raw);
      this.raw = expanded;
    }
    appendRawValue(field) {
      const value = Number(field);
      if (!Number.isFinite(value)) return;
      this.ensureRawCapacity();
      this.raw[this.rawCount++] = value;
    }
    storeCurrent() {
      if (this.shapeId > 0 && this.numSamples > 0 && this.rawCount > 0) {
        const samples = this.rawCount === this.numSamples ? this.raw : decompressShape(this.raw.subarray(0, this.rawCount), this.numSamples);
        this.seq.shapes.set(this.shapeId, { numSamples: this.numSamples, samples });
      }
      this.shapeId = 0;
      this.numSamples = 0;
      this.raw = new Float64Array();
      this.rawCount = 0;
    }
  };

  // src/pulseq/binaryReader.ts
  var PULSEQ_BINARY_VERSION = Object.freeze({ major: 1, minor: 5, revision: 2 });
  var MAGIC = new Uint8Array([1, 112, 117, 108, 115, 101, 113, 2]);
  var SECTION_PREFIX = 0xffffffff00000000n;
  var SECTION = Object.freeze({
    definitions: SECTION_PREFIX | 1n,
    blocks: SECTION_PREFIX | 2n,
    rf: SECTION_PREFIX | 3n,
    gradients: SECTION_PREFIX | 4n,
    trapezoids: SECTION_PREFIX | 5n,
    adc: SECTION_PREFIX | 6n,
    legacyDelays: SECTION_PREFIX | 7n,
    shapes: SECTION_PREFIX | 8n,
    extensions: SECTION_PREFIX | 9n,
    triggers: SECTION_PREFIX | 10n,
    labelSet: SECTION_PREFIX | 11n,
    labelInc: SECTION_PREFIX | 12n,
    softDelays: SECTION_PREFIX | 13n,
    rfShims: SECTION_PREFIX | 14n,
    rotations: SECTION_PREFIX | 15n,
    signature: SECTION_PREFIX | 0x00ffffffn
  });
  var MAX_RECORDS = 1e8;
  var MAX_STRING_BYTES = 16 * 1024 * 1024;
  var MAX_SHAPE_SAMPLES = 1e8;
  var BINARY_LABELS = Object.freeze([
    "SLC",
    "SEG",
    "REP",
    "AVG",
    "SET",
    "ECO",
    "PHS",
    "LIN",
    "PAR",
    "ACQ",
    "TRID",
    "NAV",
    "REV",
    "SMS",
    "REF",
    "IMA",
    "OFF",
    "NOISE",
    "PMC",
    "NOROT",
    "NOPOS",
    "NOSCL",
    "ONCE"
  ]);
  function hasPulseqBinaryMagic(bytes) {
    if (bytes.byteLength < MAGIC.byteLength) return false;
    for (let i = 0; i < MAGIC.byteLength; i++) {
      if (bytes[i] !== MAGIC[i]) return false;
    }
    return true;
  }
  function parseSequenceBinary(bytes) {
    const reader = new BinaryReader(bytes);
    const magic = reader.bytes(MAGIC.byteLength, "file header");
    if (!hasPulseqBinaryMagic(magic)) {
      reader.fail("not a Pulseq binary file", 0);
    }
    const seq = createEmptySequence();
    resetUnknownLabels();
    seq.version.major = reader.safeInt64("version major");
    seq.version.minor = reader.safeInt64("version minor");
    seq.version.revision = reader.safeInt64("version revision");
    seq.versionCombined = makeVersionCombined(
      seq.version.major,
      seq.version.minor,
      seq.version.revision
    );
    assertSupportedVersion(seq, reader);
    const seenSections = /* @__PURE__ */ new Set(["VERSION"]);
    while (!reader.eof()) {
      const sectionOffset = reader.position;
      const section = reader.uint64("section code");
      switch (section) {
        case SECTION.definitions:
          readDefinitions(reader, seq);
          seenSections.add("DEFINITIONS");
          break;
        case SECTION.blocks:
          readBlocks(reader, seq);
          seenSections.add("BLOCKS");
          break;
        case SECTION.rf:
          readRf(reader, seq);
          seenSections.add("RF");
          break;
        case SECTION.gradients:
          readGradients(reader, seq);
          seenSections.add("GRADIENTS");
          break;
        case SECTION.trapezoids:
          readTrapezoids(reader, seq);
          seenSections.add("TRAP");
          break;
        case SECTION.adc:
          readAdc(reader, seq);
          seenSections.add("ADC");
          break;
        case SECTION.legacyDelays:
          readLegacyDelays(reader);
          break;
        case SECTION.shapes:
          readShapes(reader, seq);
          seenSections.add("SHAPES");
          break;
        case SECTION.extensions:
          readExtensions(reader, seq);
          seenSections.add("EXTENSIONS");
          break;
        case SECTION.triggers:
          readTriggers(reader, seq);
          break;
        case SECTION.labelSet:
          readLabels(reader, seq, true);
          break;
        case SECTION.labelInc:
          readLabels(reader, seq, false);
          break;
        case SECTION.softDelays:
          readSoftDelays(reader, seq);
          break;
        case SECTION.rfShims:
          readRfShims(reader, seq);
          break;
        case SECTION.rotations:
          readRotations(reader, seq);
          break;
        case SECTION.signature:
          readSignature(reader, seq, sectionOffset);
          break;
        default:
          reader.fail(`unknown section code 0x${section.toString(16)}`, sectionOffset);
      }
    }
    extractRasterTimes(seq);
    validateSequence(seq, seenSections);
    return seq;
  }
  function assertSupportedVersion(seq, reader) {
    const expected = PULSEQ_BINARY_VERSION;
    if (seq.version.major !== expected.major || seq.version.minor !== expected.minor || seq.version.revision !== expected.revision) {
      reader.fail(
        `unsupported Pulseq binary version ${seq.version.major}.${seq.version.minor}.${seq.version.revision}; expected ${expected.major}.${expected.minor}.${expected.revision}`,
        MAGIC.byteLength
      );
    }
  }
  function readDefinitions(reader, seq) {
    const count = reader.count64("DEFINITIONS count", 9);
    for (let i = 0; i < count; i++) {
      const keyLength = reader.length32("DEFINITIONS key length");
      const key = reader.string(keyLength, "DEFINITIONS key");
      const valueCount = reader.length32("DEFINITIONS value count", MAX_RECORDS);
      const valueType = reader.char("DEFINITIONS value type");
      if (valueType === "f") {
        reader.requireArray(valueCount, 8, "DEFINITIONS float values");
        const values = new Array(valueCount);
        for (let j = 0; j < valueCount; j++) values[j] = reader.float64("DEFINITIONS float value");
        seq.definitions.set(key, values);
        seq.definitionsRaw.set(key, values.join(" "));
      } else if (valueType === "i") {
        reader.requireArray(valueCount, 4, "DEFINITIONS integer values");
        const values = new Array(valueCount);
        for (let j = 0; j < valueCount; j++) values[j] = reader.int32("DEFINITIONS integer value");
        seq.definitions.set(key, values);
        seq.definitionsRaw.set(key, values.join(" "));
      } else if (valueType === "c") {
        const raw = reader.string(valueCount, "DEFINITIONS character value");
        const value = raw.endsWith("\0") ? raw.slice(0, -1) : raw;
        seq.definitions.set(key, []);
        seq.definitionsRaw.set(key, value);
      } else {
        reader.fail(`unknown definition value type '${valueType}'`);
      }
    }
  }
  function readBlocks(reader, seq) {
    const count = reader.count64("BLOCKS count", 32);
    seq.blocks.length = 0;
    for (let i = 0; i < count; i++) {
      seq.blocks.push({
        num: i + 1,
        dur: reader.nonNegativeSafeInt64("BLOCKS duration"),
        rfId: reader.int32("BLOCKS RF id"),
        gxId: reader.int32("BLOCKS Gx id"),
        gyId: reader.int32("BLOCKS Gy id"),
        gzId: reader.int32("BLOCKS Gz id"),
        adcId: reader.int32("BLOCKS ADC id"),
        extId: reader.int32("BLOCKS extension id")
      });
    }
  }
  function readRf(reader, seq) {
    const count = reader.count64("RF count", 73);
    seq.rfs.clear();
    for (let i = 0; i < count; i++) {
      const id = reader.int32("RF id");
      const amplitude = reader.float64("RF amplitude");
      const magShapeId = reader.int32("RF magnitude shape id");
      const phaseShapeId = reader.int32("RF phase shape id");
      const timeShapeId = reader.int32("RF time shape id");
      const center = psToUs(reader.safeInt64("RF center"));
      const delay = psToUsRounded(reader.safeInt64("RF delay"));
      const freqPPM = reader.float64("RF frequency ppm");
      const phasePPM = reader.float64("RF phase ppm");
      const freqOffset = reader.float64("RF frequency offset");
      const phaseOffset = reader.float64("RF phase offset");
      const use = reader.char("RF use").toLowerCase();
      if (!/^[erisu]$/.test(use)) reader.fail(`invalid RF use flag '${use}'`);
      seq.rfs.set(id, {
        id,
        amplitude,
        magShapeId,
        phaseShapeId,
        timeShapeId,
        center,
        delay,
        freqPPM,
        phasePPM,
        freqOffset,
        phaseOffset,
        phaseModShapeId: 0,
        use
      });
    }
  }
  function readGradients(reader, seq) {
    const count = reader.count64("GRADIENTS count", 44);
    for (let i = 0; i < count; i++) {
      const id = reader.int32("GRADIENTS id");
      seq.arbitraryGrads.set(id, {
        id,
        amplitude: reader.float64("GRADIENTS amplitude"),
        first: reader.float64("GRADIENTS first"),
        last: reader.float64("GRADIENTS last"),
        shapeId: reader.int32("GRADIENTS shape id"),
        timeId: reader.int32("GRADIENTS time shape id"),
        delay: psToUsRounded(reader.safeInt64("GRADIENTS delay"))
      });
    }
  }
  function readTrapezoids(reader, seq) {
    const count = reader.count64("TRAP count", 44);
    for (let i = 0; i < count; i++) {
      const id = reader.int32("TRAP id");
      seq.trapGrads.set(id, {
        id,
        amplitude: reader.float64("TRAP amplitude"),
        rise: psToUsRounded(reader.safeInt64("TRAP rise")),
        flat: psToUsRounded(reader.safeInt64("TRAP flat")),
        fall: psToUsRounded(reader.safeInt64("TRAP fall")),
        delay: psToUsRounded(reader.safeInt64("TRAP delay"))
      });
    }
  }
  function readAdc(reader, seq) {
    const count = reader.count64("ADC count", 64);
    seq.adcs.clear();
    for (let i = 0; i < count; i++) {
      const id = reader.int32("ADC id");
      seq.adcs.set(id, {
        id,
        numSamples: reader.nonNegativeSafeInt64("ADC sample count"),
        dwell: psToNsRounded(reader.safeInt64("ADC dwell")),
        delay: psToUsRounded(reader.safeInt64("ADC delay")),
        freqPPM: reader.float64("ADC frequency ppm"),
        phasePPM: reader.float64("ADC phase ppm"),
        freqOffset: reader.float64("ADC frequency offset"),
        phaseOffset: reader.float64("ADC phase offset"),
        deadTime: 0,
        discardPre: 0,
        discardPost: 0,
        phaseModShapeId: reader.int32("ADC phase shape id")
      });
    }
  }
  function readLegacyDelays(reader) {
    const count = reader.count64("legacy DELAYS count", 12);
    for (let i = 0; i < count; i++) {
      reader.int32("legacy DELAYS id");
      reader.safeInt64("legacy DELAYS duration");
    }
  }
  function readShapes(reader, seq) {
    const count = reader.count64("SHAPES count", 20);
    seq.shapes.clear();
    for (let i = 0; i < count; i++) {
      const id = reader.int32("SHAPES id");
      const numSamples = reader.positiveSafeInt64("SHAPES uncompressed count", MAX_SHAPE_SAMPLES);
      const packedCount = reader.positiveSafeInt64("SHAPES compressed count", MAX_SHAPE_SAMPLES);
      reader.requireArray(packedCount, 4, "SHAPES compressed data");
      const packed = new Float64Array(packedCount);
      for (let j = 0; j < packedCount; j++) packed[j] = reader.float32("SHAPES sample");
      seq.shapes.set(id, { numSamples, samples: decompressShape(packed, numSamples) });
    }
  }
  function readExtensions(reader, seq) {
    const count = reader.count64("EXTENSIONS count", 16);
    seq.extensions.clear();
    for (let i = 0; i < count; i++) {
      const id = reader.int32("EXTENSIONS id");
      seq.extensions.set(id, {
        id,
        type: reader.int32("EXTENSIONS type"),
        ref: reader.int32("EXTENSIONS reference"),
        nextId: reader.int32("EXTENSIONS next id")
      });
    }
  }
  function registerExtension(seq, id, name) {
    seq.extensionNames.set(id, name);
    seq.extensionTypes.set(id, extensionNameToType(name));
  }
  function readTriggers(reader, seq) {
    const extensionId = reader.int32("TRIGGERS extension type id");
    registerExtension(seq, extensionId, "TRIGGERS");
    const count = reader.count64("TRIGGERS count", 28);
    seq.triggers.length = 0;
    for (let i = 0; i < count; i++) {
      seq.triggers.push({
        id: reader.int32("TRIGGERS id"),
        triggerType: reader.int32("TRIGGERS type"),
        channel: reader.int32("TRIGGERS channel"),
        delay: psToUsRounded(reader.safeInt64("TRIGGERS delay")),
        duration: psToUsRounded(reader.safeInt64("TRIGGERS duration"))
      });
    }
  }
  function readLabels(reader, seq, isSet) {
    const section = isSet ? "LABELSET" : "LABELINC";
    const extensionId = reader.int32(`${section} extension type id`);
    registerExtension(seq, extensionId, section);
    const count = reader.count64(`${section} count`, 12);
    const library = isSet ? seq.labelSets : seq.labelIncs;
    library.length = 0;
    for (let i = 0; i < count; i++) {
      const id = reader.int32(`${section} id`);
      const value = reader.int32(`${section} value`);
      const labelIndex = reader.int32(`${section} label index`);
      if (labelIndex < 1 || labelIndex > BINARY_LABELS.length) {
        reader.fail(`invalid binary label index ${labelIndex}`);
      }
      const { labelId, flagId } = decodeLabel(BINARY_LABELS[labelIndex - 1]);
      const spec = { id, value, labelId, flagId };
      library.push(spec);
    }
  }
  function readSoftDelays(reader, seq) {
    const extensionId = reader.int32("DELAYS extension type id");
    registerExtension(seq, extensionId, "DELAYS");
    const count = reader.count64("DELAYS count", 28);
    seq.softDelays.length = 0;
    for (let i = 0; i < count; i++) {
      const id = reader.int32("DELAYS id");
      const numId = reader.int32("DELAYS numeric id");
      const offset = psToUsRounded(reader.safeInt64("DELAYS offset"));
      const factor = reader.float64("DELAYS factor");
      const hintLength = reader.length32("DELAYS hint length");
      seq.softDelays.push({ id, numId, offset, factor, hint: reader.string(hintLength, "DELAYS hint") });
    }
  }
  function readRfShims(reader, seq) {
    const extensionId = reader.int32("RF_SHIMS extension type id");
    registerExtension(seq, extensionId, "RF_SHIMS");
    const count = reader.count64("RF_SHIMS count", 8);
    seq.rfShims.length = 0;
    for (let i = 0; i < count; i++) {
      const id = reader.int32("RF_SHIMS id");
      const nChannels = reader.length32("RF_SHIMS channel count", MAX_RECORDS / 2);
      reader.requireArray(nChannels * 2, 8, "RF_SHIMS channel data");
      const amplitudes = new Array(nChannels);
      const phases = new Array(nChannels);
      for (let channel = 0; channel < nChannels; channel++) {
        amplitudes[channel] = reader.float64("RF_SHIMS magnitude");
        phases[channel] = reader.float64("RF_SHIMS phase");
      }
      seq.rfShims.push({ id, nChannels, amplitudes, phases });
    }
  }
  function readRotations(reader, seq) {
    const extensionId = reader.int32("ROTATIONS extension type id");
    registerExtension(seq, extensionId, "ROTATIONS");
    const count = reader.count64("ROTATIONS count", 36);
    seq.rotations.length = 0;
    for (let i = 0; i < count; i++) {
      const id = reader.int32("ROTATIONS id");
      const values = [
        reader.float64("ROTATIONS q0"),
        reader.float64("ROTATIONS qx"),
        reader.float64("ROTATIONS qy"),
        reader.float64("ROTATIONS qz")
      ];
      const norm = Math.hypot(...values);
      if (!Number.isFinite(norm) || norm <= 0) reader.fail("invalid zero or non-finite rotation quaternion");
      seq.rotations.push({ id, values: values.map((value) => value / norm) });
    }
  }
  function readSignature(reader, seq, sectionOffset) {
    const typeLength = reader.length32("SIGNATURE type length");
    const type = reader.string(typeLength, "SIGNATURE type");
    const hashLength = reader.length32("SIGNATURE hash length");
    const hashBytes = reader.bytes(hashLength, "SIGNATURE hash");
    const originalSize = reader.nonNegativeSafeInt64("SIGNATURE original size");
    if (originalSize !== sectionOffset) {
      reader.fail(`SIGNATURE original size ${originalSize} does not match section offset ${sectionOffset}`);
    }
    let hash = "";
    for (const byte of hashBytes) hash += byte.toString(16).padStart(2, "0");
    seq.binarySignature = { type, hash, originalSize };
  }
  function psToUs(value) {
    return value / 1e6;
  }
  function psToUsRounded(value) {
    return value >= 0 ? Math.floor((value + 5e5) / 1e6) : Math.ceil((value - 5e5) / 1e6);
  }
  function psToNsRounded(value) {
    return value >= 0 ? Math.floor((value + 500) / 1e3) : Math.ceil((value - 500) / 1e3);
  }
  var BinaryReader = class {
    constructor(source) {
      __publicField(this, "source", source);
      __publicField(this, "view");
      __publicField(this, "offset", 0);
      this.view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    }
    get position() {
      return this.offset;
    }
    get remaining() {
      return this.view.byteLength - this.offset;
    }
    eof() {
      return this.remaining === 0;
    }
    requireArray(count, width, context) {
      if (!Number.isSafeInteger(count) || count < 0 || count > MAX_RECORDS) {
        this.fail(`${context} has invalid count ${count}`);
      }
      if (count > Math.floor(this.remaining / width)) {
        this.fail(`${context} exceeds remaining file data`);
      }
    }
    count64(context, minimumBytesPerEntry) {
      const count = this.nonNegativeSafeInt64(context);
      if (count > MAX_RECORDS) this.fail(`${context} exceeds limit ${MAX_RECORDS}`);
      if (minimumBytesPerEntry > 0 && count > Math.floor(this.remaining / minimumBytesPerEntry)) {
        this.fail(`${context} exceeds remaining file data`);
      }
      return count;
    }
    length32(context, limit = MAX_STRING_BYTES) {
      const value = this.int32(context);
      if (value < 0 || value > limit) this.fail(`${context} has invalid value ${value}`);
      if (value > this.remaining) this.fail(`${context} exceeds remaining file data`);
      return value;
    }
    positiveSafeInt64(context, limit) {
      const value = this.safeInt64(context);
      if (value <= 0 || value > limit) this.fail(`${context} has invalid value ${value}`);
      return value;
    }
    nonNegativeSafeInt64(context) {
      const value = this.safeInt64(context);
      if (value < 0) this.fail(`${context} must be non-negative`);
      return value;
    }
    safeInt64(context) {
      const value = this.int64(context);
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
        this.fail(`${context} exceeds JavaScript safe integer range`);
      }
      return Number(value);
    }
    int64(context) {
      this.require(8, context);
      const value = this.view.getBigInt64(this.offset, true);
      this.offset += 8;
      return value;
    }
    uint64(context) {
      this.require(8, context);
      const value = this.view.getBigUint64(this.offset, true);
      this.offset += 8;
      return value;
    }
    int32(context) {
      this.require(4, context);
      const value = this.view.getInt32(this.offset, true);
      this.offset += 4;
      return value;
    }
    float64(context) {
      this.require(8, context);
      const value = this.view.getFloat64(this.offset, true);
      this.offset += 8;
      if (!Number.isFinite(value)) this.fail(`${context} is not finite`, this.offset - 8);
      return value;
    }
    float32(context) {
      this.require(4, context);
      const value = this.view.getFloat32(this.offset, true);
      this.offset += 4;
      if (!Number.isFinite(value)) this.fail(`${context} is not finite`, this.offset - 4);
      return value;
    }
    char(context) {
      return this.string(1, context);
    }
    string(length, context) {
      const data = this.bytes(length, context);
      let result = "";
      const chunkSize = 8192;
      for (let start = 0; start < data.length; start += chunkSize) {
        const end = Math.min(data.length, start + chunkSize);
        result += String.fromCharCode(...data.subarray(start, end));
      }
      return result;
    }
    bytes(length, context) {
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_STRING_BYTES) {
        this.fail(`${context} has invalid byte length ${length}`);
      }
      this.require(length, context);
      const result = this.source.subarray(this.offset, this.offset + length);
      this.offset += length;
      return result;
    }
    fail(message, offset = this.offset) {
      throw new Error(`Pulseq binary parse error at byte ${offset}: ${message}`);
    }
    require(length, context) {
      if (length < 0 || length > this.remaining) {
        this.fail(`unexpected end of file while reading ${context}`);
      }
    }
  };

  // src/pulseq/sequenceReader.ts
  function parseSequenceBytes(bytes, fileName = "") {
    if (hasPulseqBinaryMagic(bytes)) return parseSequenceBinary(bytes);
    if (/\.bseq$/i.test(fileName)) {
      throw new Error("Pulseq binary parse error: .bseq file is missing the Pulseq binary header");
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Pulseq parse error: sequence text is not valid UTF-8");
    }
    return parseSequenceText(text);
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
      cumulative += blockDurationSeconds(seq, seq.blocks[i]);
    }
    const decoded = [];
    for (let i = s; i < e; i++) {
      const block = seq.blocks[i];
      const dur = blockDurationSeconds(seq, block);
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
      total += blockDurationSeconds(seq, block);
    }
    return total;
  }
  function blockDurationSeconds(seq, block) {
    if (seq.versionCombined < VER_PRE_14) return block.dur * 1e-6;
    return block.dur * seq.rasterTimes.blockDurationRaster;
  }
  function decodeRF(seq, rf, blockStart, _blockDur) {
    const raster = seq.rasterTimes.rfRaster;
    const rfDelay = rf.delay * 1e-6;
    const rfStart = blockStart + rfDelay;
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
    const centerTime = rf.center >= 0 ? blockStart + rfDelay + rf.center * 1e-6 : estimateRfPeakTime(t, amp, rfStart, duration);
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
      centerTime,
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
    const delay = arb.delay * 1e-6;
    const gradStart = blockStart + delay;
    const n = shape.numSamples;
    const oversampled = arb.timeId === -1;
    const timeShape = arb.timeId > 0 ? seq.shapes.get(arb.timeId)?.samples ?? null : null;
    if (timeShape) {
      const tp2 = new Float64Array(n);
      const wf2 = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        tp2[i] = gradStart + timeShape[i] * raster;
        wf2[i] = arb.amplitude * shape.samples[i];
      }
      const dur2 = n > 0 ? tp2[n - 1] - blockStart + raster : delay;
      return {
        blockIndex: arb.id,
        startTime: blockStart,
        duration: dur2,
        timePoints: tp2,
        waveform: wf2,
        amplitude: arb.amplitude,
        type: "arb",
        channel: ch
      };
    }
    const tp = new Float64Array(n + 2);
    const wf = new Float64Array(n + 2);
    tp[0] = gradStart;
    wf[0] = edgeAmplitude(arb.first, arb.amplitude, shape.samples, true);
    if (oversampled) {
      const dt = raster * 0.5;
      for (let i = 0; i < n; i++) {
        tp[i + 1] = gradStart + (i + 1) * dt;
        wf[i + 1] = arb.amplitude * shape.samples[i];
      }
      tp[n + 1] = gradStart + (n + 1) * dt;
    } else {
      for (let i = 0; i < n; i++) {
        tp[i + 1] = gradStart + (i + 0.5) * raster;
        wf[i + 1] = arb.amplitude * shape.samples[i];
      }
      tp[n + 1] = gradStart + n * raster;
    }
    wf[wf.length - 1] = edgeAmplitude(arb.last, arb.amplitude, shape.samples, false);
    const dur = tp[tp.length - 1] - blockStart;
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
  function edgeAmplitude(stored, amplitude, samples, first) {
    let value;
    if (Number.isFinite(stored)) {
      value = stored;
      if (Math.abs(value) > 1 + 1e-6 && Math.abs(amplitude) > 0) value /= amplitude;
    } else if (samples.length === 0) {
      value = 0;
    } else if (samples.length === 1) {
      value = samples[0];
    } else if (first) {
      value = 0.5 * (3 * samples[0] - samples[1]);
    } else {
      value = 0.5 * (3 * samples[samples.length - 1] - samples[samples.length - 2]);
    }
    return value * amplitude;
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
      const type = seq.extensionTypes.get(cur.type) ?? 999 /* EXT_UNKNOWN */;
      if (type === 1 /* EXT_TRIGGER */) {
        let cached = _trigCache.get(cur.id);
        if (!cached) {
          const trigger = findById(seq.triggers, cur.ref);
          if (trigger) {
            cached = {
              blockIndex: trigger.id,
              startTime: 0,
              channel: trigger.channel,
              delay: trigger.delay * 1e-6,
              duration: trigger.duration * 1e-6
            };
            _trigCache.set(cur.id, cached);
          }
        }
        if (cached) {
          if (!db.triggers) db.triggers = [];
          db.triggers.push({ ...cached, startTime: blockStart });
        }
      } else if (type === 100 /* EXT_NCO */) {
        let cached = _ncoCache.get(cur.id);
        if (!cached) {
          const nco = findById(seq.ncos, cur.ref);
          if (nco) {
            cached = {
              blockIndex: nco.id,
              startTime: 0,
              channel: nco.channel,
              frequency: nco.frequency,
              phase: nco.phase,
              delay: nco.delay * 1e-6,
              duration: nco.duration * 1e-6
            };
            _ncoCache.set(cur.id, cached);
          }
        }
        if (cached) {
          if (!db.nco) db.nco = [];
          db.nco.push({ ...cached, startTime: blockStart });
        }
      } else if (type === 2 /* EXT_ROTATION */) {
        const rotation = findById(seq.rotations, cur.ref);
        if (rotation) db.rotation = { id: rotation.id, values: [...rotation.values] };
      } else if (type === 3 /* EXT_LABELSET */) {
        const label = findById(seq.labelSets, cur.ref);
        if (label) {
          if (!db.labelSets) db.labelSets = [];
          db.labelSets.push({ ...label });
        }
      } else if (type === 4 /* EXT_LABELINC */) {
        const label = findById(seq.labelIncs, cur.ref);
        if (label) {
          if (!db.labelIncs) db.labelIncs = [];
          db.labelIncs.push({ ...label });
        }
      } else if (type === 5 /* EXT_DELAY */) {
        const delay = findById(seq.softDelays, cur.ref);
        if (delay) db.softDelay = { ...delay };
      } else if (type === 6 /* EXT_RF_SHIM */) {
        const shim = findById(seq.rfShims, cur.ref);
        if (shim) {
          db.rfShim = {
            id: shim.id,
            nChannels: shim.nChannels,
            amplitudes: [...shim.amplitudes],
            phases: [...shim.phases]
          };
        }
      }
      cur = cur.nextId > 0 ? seq.extensions.get(cur.nextId) : void 0;
    }
  }
  function makeConstant(n, value) {
    const a = new Float64Array(Math.max(n, 2));
    a.fill(value);
    return a;
  }
  function estimateRfPeakTime(timePoints, magnitude, startTime, duration) {
    if (!timePoints.length || !magnitude.length) return startTime + duration * 0.5;
    let peak = Math.abs(magnitude[0]);
    for (let i = 1; i < magnitude.length; i++) {
      const v = Math.abs(magnitude[i]);
      if (v > peak) peak = v;
    }
    const threshold = Math.abs(peak) * 0.99999;
    let firstPeak = -1;
    let lastPeak = -1;
    for (let i = 0; i < magnitude.length; i++) {
      if (Math.abs(magnitude[i]) >= threshold) {
        if (firstPeak < 0) firstPeak = i;
        lastPeak = i;
      }
    }
    if (firstPeak < 0 || lastPeak < 0) return startTime + duration * 0.5;
    return 0.5 * (timePoints[Math.min(firstPeak, timePoints.length - 1)] + timePoints[Math.min(lastPeak, timePoints.length - 1)]);
  }
  function findById(items, id) {
    return items.find((item) => item.id === id);
  }

  // src/pulseq/kspace.ts
  var TRAJECTORY_TIME_ACCURACY_SEC = 1e-10;
  var GRADIENT_ENDPOINT_TOLERANCE_SEC = 1e-12;
  function canonicalTrajectoryTime(timeSec) {
    return TRAJECTORY_TIME_ACCURACY_SEC * Math.round(timeSec / TRAJECTORY_TIME_ACCURACY_SEC);
  }
  function calculateKspace(blocks, gradientRaster, totalDuration, trajectoryDelay = 0, _options) {
    if (!blocks.length || !gradientRaster || gradientRaster <= 0) return null;
    const GR = gradientRaster;
    const RF = _options?.rfRaster && _options.rfRaster > 0 ? _options.rfRaster : 1e-6;
    const tacc = TRAJECTORY_TIME_ACCURACY_SEC;
    const gradientSupport = _options?.gradientSupport ?? "endpoints";
    const excT = [], refT = [];
    const gradTimes = [];
    let totalAdcSamples = 0;
    for (const b of blocks) {
      if (b.adc) totalAdcSamples += b.adc.numSamples;
    }
    if (_options?.maxAdcSamples && totalAdcSamples > _options.maxAdcSamples) return null;
    if (_options?.maxGridPoints && totalDuration > 0) {
      const rasterPointCount = Math.max(2, Math.round(totalDuration / GR) + 1);
      if (rasterPointCount + totalAdcSamples > _options.maxGridPoints) return null;
    }
    const adcT = new Float64Array(totalAdcSamples);
    let adcIdx = 0;
    for (const b of blocks) {
      collectGradientSupport(b.gx, gradTimes, gradientSupport);
      collectGradientSupport(b.gy, gradTimes, gradientSupport);
      collectGradientSupport(b.gz, gradTimes, gradientSupport);
      if (b.rf) {
        const iso = Number.isFinite(b.rf.centerTime) ? b.rf.centerTime : b.rf.startTime + b.rf.duration * 0.5;
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
    for (const t of gradTimes) pushC(t);
    for (const t of excT) {
      pushC(t);
      pushC(t - RF);
      pushC(t - 2 * RF);
    }
    for (const t of refT) {
      pushC(t);
      pushC(t - RF);
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
    if (_options?.maxGridPoints && N > _options.maxGridPoints) return null;
    const gx = new Float64Array(N), gy = new Float64Array(N), gz = new Float64Array(N);
    const edges = [0];
    let cum = 0;
    for (const b of blocks) {
      cum += b.duration;
      edges.push(canonicalTrajectoryTime(cum));
    }
    for (let i = 0; i < N; i++) {
      const t = grid[i];
      const bi = blockIdx(t, edges);
      if (bi >= 0 && bi < blocks.length) {
        const block = blocks[bi];
        const localX = gradVal(block.gx, t);
        const localY = gradVal(block.gy, t);
        const localZ = gradVal(block.gz, t);
        const rotated = rotateGradient(block, localX, localY, localZ);
        gx[i] = rotated[0];
        gy[i] = rotated[1];
        gz[i] = rotated[2];
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
  function collectGradientSupport(g, support, mode) {
    if (!g || g.type === "none" || !g.timePoints || g.timePoints.length < 2) return;
    if (mode === "all") {
      for (let i = 0; i < g.timePoints.length; i++) support.push(g.timePoints[i]);
      return;
    }
    support.push(g.timePoints[0], g.timePoints[g.timePoints.length - 1]);
  }
  function gradVal(g, t) {
    if (!g || g.type === "none") return 0;
    const tp = g.timePoints, wf = g.waveform;
    if (!tp || tp.length < 2) return 0;
    const first = tp[0], last = tp[tp.length - 1];
    if (t < first - GRADIENT_ENDPOINT_TOLERANCE_SEC || t > last + GRADIENT_ENDPOINT_TOLERANCE_SEC) return 0;
    if (t <= first + GRADIENT_ENDPOINT_TOLERANCE_SEC) return wf[0];
    if (t >= last - GRADIENT_ENDPOINT_TOLERANCE_SEC) return wf[wf.length - 1];
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
  function rotateGradient(block, gx, gy, gz) {
    const values = block.rotation?.values;
    if (!values) return [gx, gy, gz];
    if (values.length === 4) {
      const [w, x, y, z] = values;
      const r00 = 1 - 2 * y * y - 2 * z * z;
      const r01 = 2 * x * y - 2 * w * z;
      const r02 = 2 * x * z + 2 * w * y;
      const r10 = 2 * x * y + 2 * w * z;
      const r11 = 1 - 2 * x * x - 2 * z * z;
      const r12 = 2 * y * z - 2 * w * x;
      const r20 = 2 * x * z - 2 * w * y;
      const r21 = 2 * y * z + 2 * w * x;
      const r22 = 1 - 2 * x * x - 2 * y * y;
      return [
        r00 * gx + r01 * gy + r02 * gz,
        r10 * gx + r11 * gy + r12 * gz,
        r20 * gx + r21 * gy + r22 * gz
      ];
    }
    if (values.length === 9) {
      return [
        values[0] * gx + values[1] * gy + values[2] * gz,
        values[3] * gx + values[4] * gy + values[5] * gz,
        values[6] * gx + values[7] * gy + values[8] * gz
      ];
    }
    return [gx, gy, gz];
  }

  // src/pulseq/boundedSeries.ts
  var BoundedSeriesBuilder = class {
    constructor(startSec, endSec, maxPoints) {
      __publicField(this, "startSec", startSec);
      __publicField(this, "endSec", endSec);
      __publicField(this, "buckets");
      __publicField(this, "bucketCount");
      __publicField(this, "span");
      this.bucketCount = Math.max(1, Math.floor(Math.max(4, maxPoints) / 4));
      this.buckets = new Array(this.bucketCount);
      this.span = Math.max(0, endSec - startSec);
    }
    add(tSec, value) {
      if (!Number.isFinite(tSec) || !Number.isFinite(value)) return;
      this.addToBucket(this.bucketIndex(tSec), tSec, value);
    }
    /** Fill a known constant interval without visiting every source-raster sample. */
    addConstantRange(startSec, endSec, value) {
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || !Number.isFinite(value)) return;
      const start = Math.max(this.startSec, Math.min(startSec, endSec));
      const end = Math.min(this.endSec, Math.max(startSec, endSec));
      if (end < start) return;
      const firstIndex = this.bucketIndex(start);
      const lastIndex = this.bucketIndex(end);
      for (let index = firstIndex; index <= lastIndex; index++) {
        const bucketStart = this.span > 0 ? this.startSec + this.span * index / this.bucketCount : start;
        const bucketEnd = this.span > 0 ? this.startSec + this.span * (index + 1) / this.bucketCount : end;
        const left = Math.max(start, bucketStart);
        const right = Math.min(end, bucketEnd);
        if (right < left) continue;
        this.addToBucket(index, left, value);
        this.addToBucket(index, right, value);
      }
    }
    bucketIndex(tSec) {
      const normalized = this.span > 0 ? (tSec - this.startSec) / this.span : 0;
      return Math.max(0, Math.min(
        this.bucketCount - 1,
        Math.floor(normalized * this.bucketCount)
      ));
    }
    addToBucket(index, tSec, value) {
      const bucket = this.buckets[index];
      if (!bucket) {
        this.buckets[index] = {
          firstT: tSec,
          firstV: value,
          minV: value,
          maxV: value,
          lastT: tSec,
          lastV: value
        };
        return;
      }
      if (value < bucket.minV) {
        bucket.minV = value;
      }
      if (value > bucket.maxV) {
        bucket.maxV = value;
      }
      bucket.lastT = tSec;
      bucket.lastV = value;
    }
    finish() {
      const startTime = [];
      const endTime = [];
      const min = [];
      const max = [];
      const first = [];
      const last = [];
      for (const bucket of this.buckets) {
        if (!bucket) continue;
        startTime.push(bucket.firstT);
        endTime.push(bucket.lastT);
        min.push(bucket.minV);
        max.push(bucket.maxV);
        first.push(bucket.firstV);
        last.push(bucket.lastV);
      }
      return {
        startTime: new Float64Array(startTime),
        endTime: new Float64Array(endTime),
        min: new Float64Array(min),
        max: new Float64Array(max),
        first: new Float64Array(first),
        last: new Float64Array(last)
      };
    }
  };

  // src/pulseq/gradientSampler.ts
  var TIME_EPS = 1e-15;
  function decodedGradientTimeRange(blocks) {
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const block of blocks) {
      for (const gradient of [block.gx, block.gy, block.gz]) {
        if (!gradient?.timePoints.length) continue;
        const gradientFirst = gradient.timePoints[0];
        const gradientLast = gradient.timePoints[gradient.timePoints.length - 1];
        if (Number.isFinite(gradientFirst)) first = Math.min(first, gradientFirst);
        if (Number.isFinite(gradientLast)) last = Math.max(last, gradientLast);
      }
    }
    return Number.isFinite(first) && Number.isFinite(last) && last >= first ? { first, last } : void 0;
  }
  function createDecodedGradientSampler(blocks, channel) {
    const events = [];
    for (const block of blocks) {
      const gradient = block[channel];
      if (!gradient?.timePoints.length || !gradient.waveform.length) continue;
      const n = Math.min(gradient.timePoints.length, gradient.waveform.length);
      if (n < 1) continue;
      events.push({
        gradient,
        first: gradient.timePoints[0],
        last: gradient.timePoints[n - 1]
      });
    }
    events.sort((a, b) => a.first - b.first);
    let eventIndex = 0;
    let pointIndex = 0;
    let previousTime = Number.NEGATIVE_INFINITY;
    return (timeSec) => {
      if (timeSec < previousTime - TIME_EPS) {
        eventIndex = 0;
        pointIndex = 0;
      }
      previousTime = timeSec;
      while (eventIndex < events.length && events[eventIndex].last < timeSec - TIME_EPS) {
        eventIndex++;
        pointIndex = 0;
      }
      if (eventIndex >= events.length) return 0;
      const event = events[eventIndex];
      if (timeSec < event.first - TIME_EPS || timeSec > event.last + TIME_EPS) return 0;
      const times = event.gradient.timePoints;
      const values = event.gradient.waveform;
      const n = Math.min(times.length, values.length);
      if (Math.abs(timeSec - event.last) <= TIME_EPS && eventIndex + 1 < events.length) {
        const next = events[eventIndex + 1];
        if (Math.abs(next.first - timeSec) <= TIME_EPS && next.gradient.waveform.length) {
          return 0.5 * (values[n - 1] + next.gradient.waveform[0]);
        }
      }
      while (pointIndex + 1 < n && times[pointIndex + 1] <= timeSec + TIME_EPS) pointIndex++;
      if (pointIndex >= n - 1 || timeSec <= times[pointIndex] + TIME_EPS) return values[pointIndex];
      const t0 = times[pointIndex];
      const t1 = times[pointIndex + 1];
      if (!(t1 > t0)) return values[pointIndex];
      const alpha = (timeSec - t0) / (t1 - t0);
      return values[pointIndex] + alpha * (values[pointIndex + 1] - values[pointIndex]);
    };
  }

  // src/pulseq/m1.ts
  var TIME_EPS2 = 1e-15;
  function calculateM1(blocks, gradientRaster, options = {}) {
    const referenceMode = normalizeReferenceMode(options.referenceMode);
    if (!blocks.length) {
      return invalidM1("Empty or invalid block list.", referenceMode);
    }
    const gx = collectGradientSeries(blocks, "gx");
    const gy = collectGradientSeries(blocks, "gy");
    const gz = collectGradientSeries(blocks, "gz");
    const ranges = [gx, gy, gz].filter((series) => series.time.length > 0).map((series) => [series.time[0], series.time[series.time.length - 1]]);
    if (!ranges.length) {
      return invalidM1("No gradient waveform available for M1.", referenceMode);
    }
    const tMin = Math.min(...ranges.map((range) => range[0]));
    const tMax = Math.max(...ranges.map((range) => range[1]));
    if (!Number.isFinite(tMin) || !Number.isFinite(tMax) || tMax < tMin) {
      return invalidM1("Invalid gradient time range for M1.", referenceMode);
    }
    const warnings = [];
    const rfEvents = collectRfEvents(blocks, warnings);
    const excitationTimes = rfEvents.filter((rf) => rf.use === "e").map((rf) => rf.tSec);
    const refocusingTimes = rfEvents.filter((rf) => rf.use === "r").map((rf) => rf.tSec);
    const events = buildWalkerEvents(rfEvents);
    appendM1AdvisoryWarnings(rfEvents, tMin, warnings);
    const rasterSec = gradientRaster > 0 ? gradientRaster : 1e-5;
    if (rasterSec <= 0) {
      return invalidM1("gradientRaster must be positive.", referenceMode);
    }
    const samples = buildSampleTimes(tMin, tMax, rasterSec);
    const x = walkM1(gx, samples, events, excitationTimes, tMin, referenceMode);
    const y = walkM1(gy, samples, events, excitationTimes, tMin, referenceMode);
    const z = walkM1(gz, samples, events, excitationTimes, tMin, referenceMode);
    if (x.t.length !== y.t.length || x.t.length !== z.t.length) {
      warnings.push(`Internal warning: per-axis M1 output sizes disagree (${x.t.length}, ${y.t.length}, ${z.t.length}). Plot may be inconsistent.`);
    }
    const output = referenceMode === "rfCenter" ? compactRfCenteredSamples(x.t, x.m1, y.m1, z.m1) : { t: x.t, x: x.m1, y: y.m1, z: z.m1 };
    return {
      valid: true,
      ok: true,
      referenceMode,
      tSec: new Float64Array(output.t),
      m1x: new Float64Array(output.x),
      m1y: new Float64Array(output.y),
      m1z: new Float64Array(output.z),
      warnings,
      excitationTimesSec: new Float64Array(excitationTimes),
      refocusingTimesSec: new Float64Array(refocusingTimes)
    };
  }
  function compactRfCenteredSamples(time, x, y, z) {
    const count = Math.min(time.length, x.length, y.length, z.length);
    if (count <= 2) return {
      t: time.slice(0, count),
      x: x.slice(0, count),
      y: y.slice(0, count),
      z: z.slice(0, count)
    };
    const out = { t: [time[0]], x: [x[0]], y: [y[0]], z: [z[0]] };
    const sameVector = (left, right) => x[left] === x[right] && y[left] === y[right] && z[left] === z[right];
    for (let index = 1; index < count - 1; index++) {
      const duplicateTime = time[index] <= time[index - 1] + TIME_EPS2 || time[index + 1] <= time[index] + TIME_EPS2;
      const insidePlateau = sameVector(index - 1, index) && sameVector(index, index + 1);
      if (!duplicateTime && insidePlateau) continue;
      out.t.push(time[index]);
      out.x.push(x[index]);
      out.y.push(y[index]);
      out.z.push(z[index]);
    }
    out.t.push(time[count - 1]);
    out.x.push(x[count - 1]);
    out.y.push(y[count - 1]);
    out.z.push(z[count - 1]);
    return out;
  }
  function appendM1AdvisoryWarnings(rfEvents, tMin, warnings) {
    let recentExcCount = 0;
    let lastExcT = -1e9;
    let excitationCount = 0;
    for (const rf of rfEvents) {
      if (rf.use === "e") {
        excitationCount++;
        if (rf.tSec - lastExcT < 0.1) recentExcCount++;
        lastExcT = rf.tSec;
      }
    }
    if (recentExcCount > 8) {
      warnings.push(
        `Sequence shows ${recentExcCount} closely-spaced (<100 ms) excitation events. This pattern is consistent with a steady-state sequence for which the simplified reset/flip bookkeeping does NOT model coherent pathway interference. Treat the M1 curve as advisory only.`
      );
    }
    if (!excitationCount) {
      warnings.push(`No excitation RF events found in sequence. M1 will be integrated from t=${tMin.toFixed(6)} s with no signal basis.`);
    }
  }
  function calculateM1Coarse(blocks, gradientRaster, options = {}) {
    const referenceMode = normalizeReferenceMode(options.referenceMode);
    const emptySeries = () => ({
      startTime: new Float64Array(),
      endTime: new Float64Array(),
      min: new Float64Array(),
      max: new Float64Array(),
      first: new Float64Array(),
      last: new Float64Array()
    });
    const invalid = (error) => ({
      valid: false,
      ok: false,
      coarse: true,
      referenceMode,
      error,
      startSec: 0,
      endSec: 0,
      x: emptySeries(),
      y: emptySeries(),
      z: emptySeries(),
      warnings: [],
      excitationTimesSec: new Float64Array(),
      refocusingTimesSec: new Float64Array()
    });
    if (!blocks.length) return invalid("Empty or invalid block list.");
    if (!(gradientRaster > 0)) return invalid("gradientRaster must be positive.");
    const range = decodedGradientTimeRange(blocks);
    if (!range) return invalid("No gradient waveform available for M1.");
    const warnings = [];
    const rfEvents = collectRfEvents(blocks, warnings);
    appendM1AdvisoryWarnings(rfEvents, range.first, warnings);
    const excitationTimes = rfEvents.filter((rf) => rf.use === "e").map((rf) => rf.tSec);
    const refocusingTimes = rfEvents.filter((rf) => rf.use === "r").map((rf) => rf.tSec);
    const events = buildWalkerEvents(rfEvents);
    const startSec = Math.min(range.first, events[0]?.tSec ?? range.first);
    const endSec = Math.max(range.last, events[events.length - 1]?.tSec ?? range.last);
    const maxPoints = Math.max(1024, Math.min(12e4, options.maxPoints ?? 3e4));
    const maxBuckets = Math.floor(maxPoints / 4);
    const builders = [
      new BoundedSeriesBuilder(startSec, endSec, maxPoints),
      new BoundedSeriesBuilder(startSec, endSec, maxPoints),
      new BoundedSeriesBuilder(startSec, endSec, maxPoints)
    ];
    const samplers = [
      createDecodedGradientSampler(blocks, "gx"),
      createDecodedGradientSampler(blocks, "gy"),
      createDecodedGradientSampler(blocks, "gz")
    ];
    const effectiveM0 = [0, 0, 0];
    const effectiveM1 = [0, 0, 0];
    let sign = 1;
    let tReset = excitationTimes.length ? excitationTimes[0] : range.first;
    if (range.first < tReset) tReset = range.first;
    let currentT = tReset;
    const reported = (axis, tSec) => referenceMode === "observationTime" ? effectiveM1[axis] - (tSec - tReset) * effectiveM0[axis] : effectiveM1[axis];
    const advanceTo = (targetT) => {
      if (!(targetT > currentT + TIME_EPS2)) return;
      for (let axis = 0; axis < 3; axis++) {
        const ga = samplers[axis](currentT);
        const gb = samplers[axis](targetT);
        const integrated = integrateLinearSegment(currentT, targetT, tReset, ga, gb);
        effectiveM0[axis] += sign * integrated[0];
        effectiveM1[axis] += sign * integrated[1];
      }
      currentT = targetT;
    };
    const addReported = (tSec) => {
      for (let axis = 0; axis < 3; axis++) builders[axis].add(tSec, reported(axis, tSec));
    };
    const regularCount = Math.floor((range.last - range.first) / gradientRaster) + 1;
    const regularLast = range.first + Math.max(0, regularCount - 1) * gradientRaster;
    const hasFinalSample = regularLast < range.last - TIME_EPS2;
    const totalSamples = regularCount + (hasFinalSample ? 1 : 0);
    const sampleTimeAt = (index) => index < regularCount ? range.first + index * gradientRaster : range.last;
    const gradientFreeIntervals = referenceMode === "rfCenter" ? collectGradientFreeIntervals(blocks) : [];
    let gradientFreeIndex = 0;
    let eventIndex = 0;
    let sampleIndex = 0;
    while (eventIndex < events.length || sampleIndex < totalSamples) {
      const eventTime = eventIndex < events.length ? events[eventIndex].tSec : Number.POSITIVE_INFINITY;
      const sampleTime = sampleIndex < totalSamples ? sampleTimeAt(sampleIndex) : Number.POSITIVE_INFINITY;
      while (gradientFreeIndex < gradientFreeIntervals.length && gradientFreeIntervals[gradientFreeIndex].end <= currentT + TIME_EPS2) {
        gradientFreeIndex++;
      }
      const gap = gradientFreeIntervals[gradientFreeIndex];
      const ordinaryTarget = Math.min(eventTime, sampleTime);
      if (gap && currentT < gap.start - TIME_EPS2 && gap.start < ordinaryTarget - TIME_EPS2) {
        advanceTo(gap.start);
        addReported(gap.start);
        continue;
      }
      if (gap && currentT >= gap.start - TIME_EPS2 && currentT < gap.end - TIME_EPS2) {
        const jumpTarget = Math.min(gap.end, eventTime, endSec);
        if (jumpTarget > currentT + TIME_EPS2) {
          for (let axis = 0; axis < 3; axis++) {
            builders[axis].addConstantRange(currentT, jumpTarget, effectiveM1[axis]);
          }
          currentT = jumpTarget;
          while (sampleIndex < totalSamples && sampleTimeAt(sampleIndex) <= currentT + TIME_EPS2) {
            sampleIndex++;
          }
          continue;
        }
      }
      if (eventTime <= sampleTime) {
        advanceTo(eventTime);
        if (events[eventIndex].kind === "reset") {
          sign = 1;
          tReset = eventTime;
          currentT = eventTime;
          effectiveM0.fill(0);
          effectiveM1.fill(0);
          for (const builder of builders) builder.add(eventTime, 0);
        } else {
          addReported(eventTime);
          sign = -sign;
        }
        eventIndex++;
      } else {
        advanceTo(sampleTime);
        addReported(sampleTime);
        sampleIndex++;
      }
    }
    warnings.push(
      `Showing a bounded full-sequence M1 envelope (at most ${maxBuckets.toLocaleString()} buckets per axis). Zoom to 100 TRs or fewer for an automatic detailed calculation.`
    );
    return {
      valid: true,
      ok: true,
      coarse: true,
      referenceMode,
      startSec,
      endSec,
      x: builders[0].finish(),
      y: builders[1].finish(),
      z: builders[2].finish(),
      warnings,
      excitationTimesSec: new Float64Array(excitationTimes),
      refocusingTimesSec: new Float64Array(refocusingTimes)
    };
  }
  function invalidM1(error, referenceMode = "rfCenter") {
    return {
      valid: false,
      ok: false,
      referenceMode,
      error,
      tSec: new Float64Array(),
      m1x: new Float64Array(),
      m1y: new Float64Array(),
      m1z: new Float64Array(),
      warnings: [],
      excitationTimesSec: new Float64Array(),
      refocusingTimesSec: new Float64Array()
    };
  }
  function normalizeReferenceMode(mode) {
    return mode === "observationTime" ? "observationTime" : "rfCenter";
  }
  function collectGradientSeries(blocks, channel) {
    const series = { time: [], value: [] };
    for (const block of blocks) {
      const grad = block[channel];
      if (!grad?.timePoints || !grad.waveform) continue;
      const n = Math.min(grad.timePoints.length, grad.waveform.length);
      for (let i = 0; i < n; i++) {
        appendGradientPoint(series, grad.timePoints[i], grad.waveform[i]);
      }
    }
    return series;
  }
  function collectGradientFreeIntervals(blocks) {
    const gaps = [];
    const appendGap = (start, end) => {
      if (!(end > start + TIME_EPS2)) return;
      const previous = gaps[gaps.length - 1];
      if (previous && start <= previous.end + TIME_EPS2) {
        previous.end = Math.max(previous.end, end);
      } else {
        gaps.push({ start, end });
      }
    };
    for (const block of blocks) {
      const blockStart = block.startTime;
      const blockEnd = block.startTime + block.duration;
      if (!(blockEnd > blockStart + TIME_EPS2)) continue;
      const active = [];
      for (const gradient of [block.gx, block.gy, block.gz]) {
        if (!gradient?.timePoints.length || !gradient.waveform.length || gradient.type === "none") continue;
        let nonzero = false;
        for (const value of gradient.waveform) {
          if (value !== 0) {
            nonzero = true;
            break;
          }
        }
        if (!nonzero) continue;
        const first = Math.max(blockStart, gradient.timePoints[0]);
        const last = Math.min(blockEnd, gradient.timePoints[gradient.timePoints.length - 1]);
        if (last > first + TIME_EPS2) active.push({ start: first, end: last });
      }
      active.sort((left, right) => left.start - right.start);
      let cursor = blockStart;
      for (const interval of active) {
        if (interval.start > cursor + TIME_EPS2) appendGap(cursor, interval.start);
        cursor = Math.max(cursor, interval.end);
      }
      if (cursor < blockEnd - TIME_EPS2) appendGap(cursor, blockEnd);
    }
    return gaps;
  }
  function appendGradientPoint(series, t, value) {
    if (!Number.isFinite(t) || !Number.isFinite(value)) return;
    const last = series.time.length - 1;
    if (last >= 0 && Math.abs(t - series.time[last]) <= TIME_EPS2) {
      series.value[last] = 0.5 * (series.value[last] + value);
    } else if (last < 0 || t > series.time[last]) {
      series.time.push(t);
      series.value.push(value);
    }
  }
  function collectRfEvents(blocks, warnings) {
    const events = [];
    for (const block of blocks) {
      if (!block.rf) continue;
      const use = classifyRfUse(block.rf.use);
      if (!use) continue;
      const rec = { tSec: block.rf.centerTime, use };
      events.push(rec);
      if (use === "u") {
        warnings.push(`Unknown RF use 'u' at t=${rec.tSec.toFixed(6)} s; M1 bookkeeping treats it as no-op.`);
      } else if (use === "p") {
        warnings.push(
          `Preparation module 'p' at t=${rec.tSec.toFixed(6)} s; treated as M1 reset (simplified handling; prep modules that preserve phase encoding will give wrong results).`
        );
      }
    }
    events.sort((a, b) => a.tSec - b.tSec);
    return events;
  }
  function classifyRfUse(raw) {
    const c = (raw || "u").toLowerCase();
    if (c === "e" || c === "r" || c === "s" || c === "i" || c === "p") return c;
    return "u";
  }
  function buildWalkerEvents(rfs) {
    const events = [];
    for (const rf of rfs) {
      if (rf.use === "i" || rf.use === "u") continue;
      events.push({
        tSec: rf.tSec,
        kind: rf.use === "r" ? "flip" : "reset"
      });
    }
    events.sort((a, b) => {
      if (a.tSec !== b.tSec) return a.tSec - b.tSec;
      return a.kind === "reset" && b.kind === "flip" ? -1 : 1;
    });
    return events;
  }
  function buildSampleTimes(tMin, tMax, rasterSec) {
    const samples = [];
    const nSamples = Math.floor((tMax - tMin) / rasterSec) + 1;
    for (let i = 0; i < nSamples; i++) samples.push(tMin + i * rasterSec);
    if (!samples.length || samples[samples.length - 1] < tMax - TIME_EPS2) samples.push(tMax);
    return samples;
  }
  function walkM1(gradient, samples, events, excitationTimes, tMin, referenceMode) {
    const outT = [];
    const outM1 = [];
    let sign = 1;
    let tReset = excitationTimes.length ? excitationTimes[0] : tMin;
    if (samples.length && samples[0] < tReset) tReset = samples[0];
    let currentT = tReset;
    let effectiveM0 = 0;
    let effectiveM1 = 0;
    let gradientIndex = -1;
    const seekGradient = (t) => {
      while (gradientIndex + 1 < gradient.time.length && gradient.time[gradientIndex + 1] <= t + TIME_EPS2) {
        gradientIndex++;
      }
    };
    const sampleGradient = (t) => {
      const n = gradient.time.length;
      if (n === 0 || t < gradient.time[0] - TIME_EPS2 || t > gradient.time[n - 1] + TIME_EPS2) return 0;
      seekGradient(t);
      if (gradientIndex < 0) return 0;
      if (gradientIndex >= n - 1 || Math.abs(t - gradient.time[gradientIndex]) <= TIME_EPS2) {
        return gradient.value[gradientIndex];
      }
      const t0 = gradient.time[gradientIndex];
      const t1 = gradient.time[gradientIndex + 1];
      if (!(t1 > t0)) return gradient.value[gradientIndex];
      const alpha = (t - t0) / (t1 - t0);
      return gradient.value[gradientIndex] + alpha * (gradient.value[gradientIndex + 1] - gradient.value[gradientIndex]);
    };
    const reportedM1At = (t) => {
      if (referenceMode === "observationTime") return effectiveM1 - (t - tReset) * effectiveM0;
      return effectiveM1;
    };
    const advanceTo = (targetT) => {
      if (!(targetT > currentT + TIME_EPS2)) return;
      while (currentT < targetT - TIME_EPS2) {
        seekGradient(currentT);
        let nextT = gradientIndex + 1 < gradient.time.length ? Math.min(targetT, gradient.time[gradientIndex + 1]) : targetT;
        if (!(nextT > currentT)) nextT = targetT;
        const ga = sampleGradient(currentT);
        const gb = sampleGradient(nextT);
        const [m0Seg, m1Seg] = integrateLinearSegment(currentT, nextT, tReset, ga, gb);
        effectiveM0 += sign * m0Seg;
        effectiveM1 += sign * m1Seg;
        currentT = nextT;
      }
    };
    let ei = 0;
    let si = 0;
    while (ei < events.length || si < samples.length) {
      const nextEvtT = ei < events.length ? events[ei].tSec : Number.POSITIVE_INFINITY;
      const nextSampT = si < samples.length ? samples[si] : Number.POSITIVE_INFINITY;
      if (nextEvtT <= nextSampT) {
        advanceTo(nextEvtT);
        if (events[ei].kind === "reset") {
          if (!outT.length || outT[outT.length - 1] < nextEvtT - TIME_EPS2) {
            outT.push(nextEvtT);
            outM1.push(0);
          } else {
            outT[outT.length - 1] = nextEvtT;
            outM1[outM1.length - 1] = 0;
          }
          sign = 1;
          tReset = nextEvtT;
          currentT = nextEvtT;
          effectiveM0 = 0;
          effectiveM1 = 0;
        } else {
          outT.push(nextEvtT);
          outM1.push(reportedM1At(nextEvtT));
          sign = -sign;
        }
        ei++;
      } else {
        advanceTo(nextSampT);
        outT.push(nextSampT);
        outM1.push(reportedM1At(nextSampT));
        si++;
      }
    }
    return { t: outT, m1: outM1 };
  }
  function integrateLinearSegment(a, b, tRef, ga, gb) {
    const h = b - a;
    if (!(h > 0)) return [0, 0];
    const slope = (gb - ga) / h;
    const aRel = a - tRef;
    const m0 = ga * h + 0.5 * slope * h * h;
    const m1 = ga * (aRel * h + 0.5 * h * h) + slope * (0.5 * aRel * h * h + h * h * h / 3);
    return [m0, m1];
  }

  // src/pulseq/pns.ts
  var GAMMA_HZ_PER_T = 42576e3;
  var TIME_EPS3 = 1e-15;
  function parsePnsHardwareAsc(text) {
    const asc = parseAscText(text);
    const prefix = resolvePnsPrefix(asc);
    const x = getAxisHardware(
      asc,
      `${prefix}flGSWDTauX`,
      `${prefix}flGSWDAX`,
      `${prefix}flGSWDStimulationLimitX`,
      `${prefix}flGSWDStimulationThresholdX`,
      [
        "asGPAParameters[0].sGCParameters.flGScaleFactorX",
        "asGPAParameters.sGCParameters.flGScaleFactorX",
        "flGScaleFactorX",
        "flGCGScaleFactorX",
        "GScaleFactorX"
      ]
    );
    const y = getAxisHardware(
      asc,
      `${prefix}flGSWDTauY`,
      `${prefix}flGSWDAY`,
      `${prefix}flGSWDStimulationLimitY`,
      `${prefix}flGSWDStimulationThresholdY`,
      [
        "asGPAParameters[0].sGCParameters.flGScaleFactorY",
        "asGPAParameters.sGCParameters.flGScaleFactorY",
        "flGScaleFactorY",
        "flGCGScaleFactorY",
        "GScaleFactorY"
      ]
    );
    const z = getAxisHardware(
      asc,
      `${prefix}flGSWDTauZ`,
      `${prefix}flGSWDAZ`,
      `${prefix}flGSWDStimulationLimitZ`,
      `${prefix}flGSWDStimulationThresholdZ`,
      [
        "asGPAParameters[0].sGCParameters.flGScaleFactorZ",
        "asGPAParameters.sGCParameters.flGScaleFactorZ",
        "flGScaleFactorZ",
        "flGCGScaleFactorZ",
        "GScaleFactorZ"
      ]
    );
    if (!hasValidWeights(x) || !hasValidWeights(y) || !hasValidWeights(z)) {
      throw new Error("ASC hardware coefficients are invalid (a1+a2+a3 or stim limit).");
    }
    return { x, y, z, valid: true };
  }
  function calculatePns(blocks, gradientRaster, hardware, gammaHzPerT = GAMMA_HZ_PER_T) {
    if (!hardware.valid) return invalidPns("PNS hardware is not initialized.");
    if (!blocks.length) return invalidPns("No sequence loaded.");
    if (gradientRaster <= 0 || gammaHzPerT <= 0) return invalidPns("Missing GradientRasterTime or gamma.");
    const dtSec = gradientRaster;
    const waves = [
      collectGradientSeries2(blocks, "gx"),
      collectGradientSeries2(blocks, "gy"),
      collectGradientSeries2(blocks, "gz")
    ];
    const nonEmpty = waves.filter((wave) => wave.time.length > 0);
    if (!nonEmpty.length) return invalidPns("No gradient waveform available for PNS.");
    const tFirst = Math.min(...nonEmpty.map((wave) => wave.time[0]));
    const tLast = Math.max(...nonEmpty.map((wave) => wave.time[wave.time.length - 1]));
    if (!Number.isFinite(tFirst) || !Number.isFinite(tLast) || tLast <= tFirst) {
      return invalidPns("No gradient waveform available for PNS.");
    }
    let ntMin = Math.floor(tFirst / dtSec + Number.EPSILON) + 0.5;
    const ntMax = Math.ceil(tLast / dtSec - Number.EPSILON) - 0.5;
    if (ntMin < 0.5) ntMin = 0.5;
    if (ntMax < ntMin) return invalidPns("Unable to build regular PNS raster.");
    const nSamples = Math.floor(ntMax - ntMin + 1);
    if (nSamples < 2) return invalidPns("Too few samples for PNS computation.");
    const longestTauMs = Math.max(
      hardware.x.tau1Ms,
      hardware.x.tau2Ms,
      hardware.x.tau3Ms,
      hardware.y.tau1Ms,
      hardware.y.tau2Ms,
      hardware.y.tau3Ms,
      hardware.z.tau1Ms,
      hardware.z.tau2Ms,
      hardware.z.tau3Ms
    );
    const zptSec = longestTauMs * 4 / 1e3;
    const preCount = Math.max(0, Math.round(zptSec / (4 * dtSec)));
    const postCount = Math.max(0, Math.round(zptSec / dtSec));
    const stimX = calculatePnsAxis(waves[0], ntMin, nSamples, preCount, postCount, dtSec, gammaHzPerT, hardware.x);
    const stimY = calculatePnsAxis(waves[1], ntMin, nSamples, preCount, postCount, dtSec, gammaHzPerT, hardware.y);
    const stimZ = calculatePnsAxis(waves[2], ntMin, nSamples, preCount, postCount, dtSec, gammaHzPerT, hardware.z);
    const hasAnyNonTrap = blocks.some((block) => block.gx?.type === "arb" || block.gy?.type === "arb" || block.gz?.type === "arb");
    const hasAnyLabelExt = blocks.some((block) => !!(block.labelSets?.length || block.labelIncs?.length));
    const shift = hasAnyNonTrap || hasAnyLabelExt ? 1 : 0;
    let selectedCount = 0;
    for (let origIdx = 0; origIdx < nSamples; origIdx++) {
      const paddedIdx = preCount + origIdx;
      let stimIdx = paddedIdx - shift;
      if (shift > 0 && hasAnyLabelExt && origIdx === nSamples - 1) {
        stimIdx = Math.min(paddedIdx, stimX.length - 1);
      }
      if (stimIdx < 0 || stimIdx >= stimX.length || stimIdx >= stimY.length || stimIdx >= stimZ.length) continue;
      selectedCount++;
    }
    const timeSec = new Float64Array(selectedCount);
    const pnsX = new Float64Array(selectedCount);
    const pnsY = new Float64Array(selectedCount);
    const pnsZ = new Float64Array(selectedCount);
    const pnsNorm = new Float64Array(selectedCount);
    let ok = true;
    let selectedIndex = 0;
    for (let origIdx = 0; origIdx < nSamples; origIdx++) {
      const paddedIdx = preCount + origIdx;
      let stimIdx = paddedIdx - shift;
      if (shift > 0 && hasAnyLabelExt && origIdx === nSamples - 1) {
        stimIdx = Math.min(paddedIdx, stimX.length - 1);
      }
      if (stimIdx < 0 || stimIdx >= stimX.length || stimIdx >= stimY.length || stimIdx >= stimZ.length) continue;
      const xNorm = 0.01 * stimX[stimIdx];
      const yNorm = 0.01 * stimY[stimIdx];
      const zNorm = 0.01 * stimZ[stimIdx];
      const norm = Math.sqrt(xNorm * xNorm + yNorm * yNorm + zNorm * zNorm);
      timeSec[selectedIndex] = (ntMin + origIdx) * dtSec;
      pnsX[selectedIndex] = xNorm;
      pnsY[selectedIndex] = yNorm;
      pnsZ[selectedIndex] = zNorm;
      pnsNorm[selectedIndex] = norm;
      if (norm >= 1) ok = false;
      selectedIndex++;
    }
    return { valid: true, ok, timeSec, pnsX, pnsY, pnsZ, pnsNorm };
  }
  function calculatePnsCoarse(blocks, gradientRaster, hardware, options = {}) {
    const emptySeries = () => ({
      startTime: new Float64Array(),
      endTime: new Float64Array(),
      min: new Float64Array(),
      max: new Float64Array(),
      first: new Float64Array(),
      last: new Float64Array()
    });
    const invalid = (error) => ({
      valid: false,
      ok: false,
      coarse: true,
      error,
      startSec: 0,
      endSec: 0,
      x: emptySeries(),
      y: emptySeries(),
      z: emptySeries(),
      norm: emptySeries(),
      warnings: []
    });
    const gammaHzPerT = options.gammaHzPerT ?? GAMMA_HZ_PER_T;
    if (!hardware.valid) return invalid("PNS hardware is not initialized.");
    if (!blocks.length) return invalid("No sequence loaded.");
    if (!(gradientRaster > 0) || !(gammaHzPerT > 0)) return invalid("Missing GradientRasterTime or gamma.");
    const range = decodedGradientTimeRange(blocks);
    if (!range || !(range.last > range.first)) return invalid("No gradient waveform available for PNS.");
    const dtSec = gradientRaster;
    let ntMin = Math.floor(range.first / dtSec + Number.EPSILON) + 0.5;
    const ntMax = Math.ceil(range.last / dtSec - Number.EPSILON) - 0.5;
    if (ntMin < 0.5) ntMin = 0.5;
    if (ntMax < ntMin) return invalid("Unable to build regular PNS raster.");
    const nSamples = Math.floor(ntMax - ntMin + 1);
    if (nSamples < 2) return invalid("Too few samples for PNS computation.");
    const longestTauMs = Math.max(
      hardware.x.tau1Ms,
      hardware.x.tau2Ms,
      hardware.x.tau3Ms,
      hardware.y.tau1Ms,
      hardware.y.tau2Ms,
      hardware.y.tau3Ms,
      hardware.z.tau1Ms,
      hardware.z.tau2Ms,
      hardware.z.tau3Ms
    );
    const zptSec = longestTauMs * 4 / 1e3;
    const preCount = Math.max(0, Math.round(zptSec / (4 * dtSec)));
    const postCount = Math.max(0, Math.round(zptSec / dtSec));
    const totalSamples = preCount + nSamples + postCount;
    const hasAnyNonTrap = blocks.some((block) => block.gx?.type === "arb" || block.gy?.type === "arb" || block.gz?.type === "arb");
    const hasAnyLabelExt = blocks.some((block) => !!(block.labelSets?.length || block.labelIncs?.length));
    const shift = hasAnyNonTrap || hasAnyLabelExt ? 1 : 0;
    const stimLength = Math.max(0, totalSamples - 1);
    const desiredStimIndex = (origIndex) => {
      const paddedIndex = preCount + origIndex;
      if (shift > 0 && hasAnyLabelExt && origIndex === nSamples - 1) {
        return Math.min(paddedIndex, stimLength - 1);
      }
      return paddedIndex - shift;
    };
    const startSec = ntMin * dtSec;
    const endSec = (ntMin + nSamples - 1) * dtSec;
    const maxPoints = Math.max(1024, Math.min(12e4, options.maxPoints ?? 3e4));
    const maxBuckets = Math.floor(maxPoints / 4);
    const builders = [
      new BoundedSeriesBuilder(startSec, endSec, maxPoints),
      new BoundedSeriesBuilder(startSec, endSec, maxPoints),
      new BoundedSeriesBuilder(startSec, endSec, maxPoints),
      new BoundedSeriesBuilder(startSec, endSec, maxPoints)
    ];
    const samplers = [
      createDecodedGradientSampler(blocks, "gx"),
      createDecodedGradientSampler(blocks, "gy"),
      createDecodedGradientSampler(blocks, "gz")
    ];
    const hardwareAxes = [hardware.x, hardware.y, hardware.z];
    const filterStates = hardwareAxes.map((axis) => createPnsFilterState(axis, dtSec));
    const paddedValue = (axis, index) => {
      if (index < preCount || index >= preCount + nSamples) return 0;
      const rasterIndex = index - preCount;
      return samplers[axis]((ntMin + rasterIndex) * dtSec) / gammaHzPerT;
    };
    const previous = [paddedValue(0, 0), paddedValue(1, 0), paddedValue(2, 0)];
    let outputIndex = 0;
    let ok = true;
    for (let stimIndex = 0; stimIndex < stimLength; stimIndex++) {
      const normalized = [0, 0, 0];
      for (let axis = 0; axis < 3; axis++) {
        const current = paddedValue(axis, stimIndex + 1);
        const derivative = (current - previous[axis]) / dtSec;
        previous[axis] = current;
        normalized[axis] = updatePnsFilter(filterStates[axis], derivative);
      }
      while (outputIndex < nSamples && desiredStimIndex(outputIndex) < stimIndex) outputIndex++;
      if (outputIndex < nSamples && desiredStimIndex(outputIndex) === stimIndex) {
        const timeSec = (ntMin + outputIndex) * dtSec;
        const norm = Math.hypot(normalized[0], normalized[1], normalized[2]);
        builders[0].add(timeSec, normalized[0]);
        builders[1].add(timeSec, normalized[1]);
        builders[2].add(timeSec, normalized[2]);
        builders[3].add(timeSec, norm);
        if (norm >= 1) ok = false;
        outputIndex++;
      }
    }
    const warnings = [
      `Showing a bounded full-sequence PNS envelope (at most ${maxBuckets.toLocaleString()} buckets per curve). Zoom to 100 TRs or fewer for an automatic detailed calculation.`
    ];
    return {
      valid: true,
      ok,
      coarse: true,
      startSec,
      endSec,
      x: builders[0].finish(),
      y: builders[1].finish(),
      z: builders[2].finish(),
      norm: builders[3].finish(),
      warnings
    };
  }
  function createPnsFilterState(hardware, dtSec) {
    const dtMs = dtSec * 1e3;
    return {
      alpha1: lowpassAlpha(hardware.tau1Ms, dtMs),
      alpha2: lowpassAlpha(hardware.tau2Ms, dtMs),
      alpha3: lowpassAlpha(hardware.tau3Ms, dtMs),
      lp1: 0,
      lp2: 0,
      lp3: 0,
      hardware
    };
  }
  function updatePnsFilter(state, derivative) {
    state.lp1 = state.alpha1 * derivative + (1 - state.alpha1) * state.lp1;
    state.lp2 = state.alpha2 * Math.abs(derivative) + (1 - state.alpha2) * state.lp2;
    state.lp3 = state.alpha3 * derivative + (1 - state.alpha3) * state.lp3;
    const hw = state.hardware;
    const numerator = hw.a1 * Math.abs(state.lp1) + hw.a2 * state.lp2 + hw.a3 * Math.abs(state.lp3);
    return numerator / (hw.stimLimit > 0 ? hw.stimLimit : 1) * hw.gScale;
  }
  function safePnsModel(dgdt, dtSec, hw) {
    return runPnsModel(dgdt.length, (index) => dgdt[index], dtSec, hw);
  }
  function runPnsModel(length, derivativeAt, dtSec, hw) {
    const dtMs = dtSec * 1e3;
    const alpha1 = lowpassAlpha(hw.tau1Ms, dtMs);
    const alpha2 = lowpassAlpha(hw.tau2Ms, dtMs);
    const alpha3 = lowpassAlpha(hw.tau3Ms, dtMs);
    const stim = new Float64Array(length);
    const denom = hw.stimLimit > 0 ? hw.stimLimit : 1;
    let lp1 = 0;
    let lp2 = 0;
    let lp3 = 0;
    for (let i = 0; i < length; i++) {
      const derivative = derivativeAt(i);
      lp1 = alpha1 * derivative + (1 - alpha1) * lp1;
      lp2 = alpha2 * Math.abs(derivative) + (1 - alpha2) * lp2;
      lp3 = alpha3 * derivative + (1 - alpha3) * lp3;
      const s1 = hw.a1 * Math.abs(lp1);
      const s2 = hw.a2 * lp2;
      const s3 = hw.a3 * Math.abs(lp3);
      stim[i] = (s1 + s2 + s3) / denom * hw.gScale * 100;
    }
    return stim;
  }
  function lowpassAlpha(tauMs, dtMs) {
    return tauMs <= 0 || dtMs <= 0 ? 1 : dtMs / (tauMs + dtMs);
  }
  function invalidPns(error) {
    return {
      valid: false,
      ok: false,
      error,
      timeSec: new Float64Array(),
      pnsX: new Float64Array(),
      pnsY: new Float64Array(),
      pnsZ: new Float64Array(),
      pnsNorm: new Float64Array()
    };
  }
  function parseAscText(text) {
    const scalar = /* @__PURE__ */ new Map();
    const array = /* @__PURE__ */ new Map();
    const re = /^\s*([A-Za-z0-9_.[\]]+?)(?:\[(\d+)])?\s*=\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*$/;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith("###")) continue;
      if (/^\$include\b/i.test(line)) {
        throw new Error("ASC contains $include directives. Use a combined ASC profile in the web viewer, or open it through the VS Code extension so companion ASC files can be resolved.");
      }
      const match = re.exec(line);
      if (!match) continue;
      const key = match[1].trim();
      const index = match[2] === void 0 ? -1 : Number.parseInt(match[2], 10);
      const value = Number(match[3]);
      if (!Number.isFinite(value)) continue;
      if (index >= 0) {
        const values = array.get(key) ?? [];
        values[index] = value;
        array.set(key, values);
      } else {
        scalar.set(key, value);
      }
    }
    return { scalar, array };
  }
  function resolvePnsPrefix(asc) {
    if (asc.array.has("flGSWDTauX")) return "";
    if (asc.array.has("GradPatSup.Phys.PNS.flGSWDTauX")) return "GradPatSup.Phys.PNS.";
    const candidates = [...asc.array.keys()].filter((key) => key.endsWith("flGSWDTauX") && !key.toLowerCase().includes(".carns.")).sort();
    if (candidates.length) return candidates[0].slice(0, -"flGSWDTauX".length);
    return "GradPatSup.Phys.PNS.";
  }
  function getAxisHardware(asc, tauKey, aKey, stimLimitKey, stimThreshKey, gScaleKeys) {
    const tau = findArray(asc, tauKey);
    const weights = findArray(asc, aKey);
    if (!tau || !weights) throw new Error(`Missing ASC arrays for ${tauKey} or ${aKey}`);
    if (tau.length < 3 || weights.length < 3) throw new Error(`ASC arrays ${tauKey}/${aKey} require at least 3 values`);
    const stimLimit = findScalar(asc, stimLimitKey);
    const stimThreshold = findScalar(asc, stimThreshKey);
    if (stimLimit === void 0 || stimThreshold === void 0) {
      throw new Error(`Missing ASC scalar ${stimLimitKey} or ${stimThreshKey}`);
    }
    let gScale;
    for (const key of gScaleKeys) {
      gScale = findScalar(asc, key);
      if (gScale !== void 0) break;
    }
    if (gScale === void 0) {
      throw new Error("ASC is missing g_scale factors (X/Y/Z). Select a full ASC (e.g. *_twoFilesCombined.asc).");
    }
    return {
      tau1Ms: tau[0],
      tau2Ms: tau[1],
      tau3Ms: tau[2],
      a1: weights[0],
      a2: weights[1],
      a3: weights[2],
      stimLimit,
      stimThreshold,
      gScale
    };
  }
  function findArray(asc, key) {
    const exact = asc.array.get(key);
    if (exact) return exact;
    const keyNorm = normalizeAscKey(key);
    const chosen = [...asc.array.keys()].filter((candidate) => normalizeAscKey(candidate) === keyNorm && !candidate.toLowerCase().includes(".carns.")).sort()[0];
    return chosen ? asc.array.get(chosen) : void 0;
  }
  function findScalar(asc, key) {
    const exact = asc.scalar.get(key);
    if (exact !== void 0) return exact;
    const keyNorm = normalizeAscKey(key);
    const chosen = [...asc.scalar.keys()].filter((candidate) => normalizeAscKey(candidate) === keyNorm && !candidate.toLowerCase().includes(".carns.")).sort()[0];
    return chosen ? asc.scalar.get(chosen) : void 0;
  }
  function normalizeAscKey(key) {
    return key.trim().replace(/\[\d+]/g, "");
  }
  function hasValidWeights(hw) {
    return Math.abs(hw.a1 + hw.a2 + hw.a3 - 1) <= 0.01 && hw.stimLimit > 0;
  }
  function collectGradientSeries2(blocks, channel) {
    const series = { time: [], value: [] };
    for (const block of blocks) {
      const grad = block[channel];
      if (!grad?.timePoints || !grad.waveform) continue;
      const n = Math.min(grad.timePoints.length, grad.waveform.length);
      for (let i = 0; i < n; i++) {
        appendGradientPoint2(series, grad.timePoints[i], grad.waveform[i]);
      }
    }
    return series;
  }
  function appendGradientPoint2(series, t, value) {
    if (!Number.isFinite(t) || !Number.isFinite(value)) return;
    const last = series.time.length - 1;
    if (last >= 0 && Math.abs(t - series.time[last]) <= TIME_EPS3) {
      series.value[last] = 0.5 * (series.value[last] + value);
    } else if (last < 0 || t > series.time[last]) {
      series.time.push(t);
      series.value.push(value);
    }
  }
  function calculatePnsAxis(series, ntMin, nSamples, preCount, postCount, dtSec, gammaHzPerT, hardware) {
    const sampleGradient = createGradientSampler(series);
    const totalSamples = preCount + nSamples + postCount;
    const paddedValue = (index) => {
      if (index < preCount || index >= preCount + nSamples) return 0;
      const rasterIndex = index - preCount;
      return sampleGradient((ntMin + rasterIndex) * dtSec) / gammaHzPerT;
    };
    let previous = paddedValue(0);
    return runPnsModel(Math.max(0, totalSamples - 1), (index) => {
      const current = paddedValue(index + 1);
      const derivative = (current - previous) / dtSec;
      previous = current;
      return derivative;
    }, dtSec, hardware);
  }
  function createGradientSampler(series) {
    let index = -1;
    return (t) => {
      const n = series.time.length;
      if (n === 0 || t < series.time[0] || t > series.time[n - 1]) return 0;
      while (index + 1 < n && series.time[index + 1] <= t + TIME_EPS3) index++;
      if (index < 0) return 0;
      if (index >= n - 1 || t <= series.time[index] + TIME_EPS3) return series.value[index];
      const t0 = series.time[index];
      const t1 = series.time[index + 1];
      if (!(t1 > t0)) return series.value[index];
      const alpha = (t - t0) / (t1 - t0);
      return series.value[index] + alpha * (series.value[index + 1] - series.value[index]);
    };
  }

  // src/pulseq/derivedWindow.ts
  function selectM1WindowBlocks(blocks, startSec, endSec) {
    const displayStartSec = finiteMin(startSec, endSec);
    const displayEndSec = finiteMax(startSec, endSec, displayStartSec);
    let calculationStartSec = displayStartSec;
    for (const block of blocks) {
      const center = block.rf?.centerTime;
      if (center === void 0 || center > displayStartSec) continue;
      const use = (block.rf?.use || "").toLowerCase();
      if (use === "e") calculationStartSec = Math.min(center, block.startTime);
    }
    return {
      blocks: overlappingBlocks(blocks, calculationStartSec, displayEndSec),
      calculationStartSec,
      displayStartSec,
      displayEndSec
    };
  }
  function selectPnsWindowBlocks(blocks, startSec, endSec, hardware) {
    const displayStartSec = finiteMin(startSec, endSec);
    const displayEndSec = finiteMax(startSec, endSec, displayStartSec);
    const longestTauMs = Math.max(
      hardware.x.tau1Ms,
      hardware.x.tau2Ms,
      hardware.x.tau3Ms,
      hardware.y.tau1Ms,
      hardware.y.tau2Ms,
      hardware.y.tau3Ms,
      hardware.z.tau1Ms,
      hardware.z.tau2Ms,
      hardware.z.tau3Ms
    );
    const calculationStartSec = Math.max(0, displayStartSec - longestTauMs * 4 / 1e3);
    return {
      blocks: overlappingBlocks(blocks, calculationStartSec, displayEndSec),
      calculationStartSec,
      displayStartSec,
      displayEndSec
    };
  }
  function overlappingBlocks(blocks, startSec, endSec) {
    return blocks.filter((block) => block.startTime + block.duration > startSec && block.startTime <= endSec);
  }
  function finiteMin(a, b) {
    const aa = Number.isFinite(a) ? a : 0;
    const bb = Number.isFinite(b) ? b : aa;
    return Math.max(0, Math.min(aa, bb));
  }
  function finiteMax(a, b, fallback) {
    const aa = Number.isFinite(a) ? a : fallback;
    const bb = Number.isFinite(b) ? b : aa;
    return Math.max(fallback, Math.max(aa, bb));
  }

  // src/pulseq/computeBudget.ts
  var INTERACTIVE_COMPUTE_LIMITS = Object.freeze({
    kspaceRasterSamples: 12e6,
    kspaceAdcSamples: 8e6,
    kspaceGridCandidates: 18e6,
    derivedRasterSamples: 2e6
  });
  function estimateKspaceCost(blocks, gradientRaster, totalDuration) {
    let adcSamples = 0;
    let gradientSupportPoints = 0;
    let rfSupportPoints = 0;
    for (const block of blocks) {
      if (block.adc?.numSamples && block.adc.numSamples > 0) {
        adcSamples += block.adc.numSamples;
      }
      for (const gradient of [block.gx, block.gy, block.gz]) {
        if (gradient && gradient.type !== "none" && gradient.timePoints.length >= 2) {
          gradientSupportPoints += 2;
        }
      }
      if (block.rf) rfSupportPoints += block.rf.use === "r" ? 2 : 3;
    }
    const rasterSamples = gradientRaster > 0 && totalDuration > 0 ? Math.max(2, Math.round(totalDuration / gradientRaster) + 1) : 0;
    const gridCandidatePoints = rasterSamples + adcSamples + gradientSupportPoints + rfSupportPoints + 2;
    return { rasterSamples, adcSamples, gridCandidatePoints };
  }
  function estimateKspacePeakMemoryBytes(estimate) {
    const gridBytes = Math.max(0, estimate.gridCandidatePoints) * 96;
    const adcAndTransferBytes = Math.max(0, estimate.adcSamples) * 104;
    return Math.ceil(Math.min(Number.MAX_SAFE_INTEGER, (gridBytes + adcAndTransferBytes) * 1.25));
  }
  function estimateDerivedCost(blocks, gradientRaster) {
    let firstGradientTime = Infinity;
    let lastGradientTime = -Infinity;
    for (const block of blocks) {
      for (const gradient of [block.gx, block.gy, block.gz]) {
        const times = gradient?.timePoints;
        if (!times?.length) continue;
        const first = times[0];
        const last = times[times.length - 1];
        if (Number.isFinite(first) && first < firstGradientTime) firstGradientTime = first;
        if (Number.isFinite(last) && last > lastGradientTime) lastGradientTime = last;
      }
    }
    if (!Number.isFinite(firstGradientTime) || !Number.isFinite(lastGradientTime) || lastGradientTime < firstGradientTime || gradientRaster <= 0) {
      return { rasterSamples: 0, firstGradientTime: null, lastGradientTime: null };
    }
    const span = lastGradientTime - firstGradientTime;
    let rasterSamples = Math.max(1, Math.floor(span / gradientRaster) + 1);
    const finalRasterTime = firstGradientTime + (rasterSamples - 1) * gradientRaster;
    if (finalRasterTime < lastGradientTime - 1e-15) rasterSamples++;
    return { rasterSamples, firstGradientTime, lastGradientTime };
  }
  function formatSampleCount(value) {
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)} million`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(1)} thousand`;
    return String(value);
  }
  function formatMemorySize(bytes) {
    const safeBytes = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
    const kib = 1024;
    const mib = kib * 1024;
    const gib = mib * 1024;
    if (safeBytes >= gib) {
      const value = safeBytes / gib;
      return `${value.toFixed(value >= 10 ? 0 : 1)} GiB`;
    }
    if (safeBytes >= mib) {
      const value = safeBytes / mib;
      return `${value.toFixed(value >= 10 ? 0 : 1)} MiB`;
    }
    if (safeBytes >= kib) return `${(safeBytes / kib).toFixed(1)} KiB`;
    return `${Math.round(safeBytes)} bytes`;
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
      const useChar = classifyRfUse2(rf, seq, supportsRfUse, b0);
      const useCode = useChar.charCodeAt(0);
      rfUsePerBlock.push(useCode);
      if (useChar === "e") {
        const center = rf.center >= 0 ? rf.center * 1e-6 : estimateRfCenter(rf, seq);
        const excTime = blockStartTimes[i] + rf.delay * 1e-6 + center;
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
      const totalDuration = blockStartTimes.length > 0 ? blockStartTimes[blockStartTimes.length - 1] + blockDurationSeconds2(seq, seq.blocks[seq.blocks.length - 1]) : 0;
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
      cum += blockDurationSeconds2(seq, blk);
    }
    return times;
  }
  function blockDurationSeconds2(seq, block) {
    if (seq.versionCombined < VER_PRE_14) return block.dur * 1e-6;
    return block.dur * seq.rasterTimes.blockDurationRaster;
  }
  function classifyRfUse2(rf, seq, supportsMetadata, b0Tesla) {
    if (supportsMetadata && rf.use && rf.use !== "u" && rf.use !== "U") {
      return rf.use.toLowerCase();
    }
    const faDeg = estimateFlipAngleDeg(rf, seq);
    if (faDeg < 90.01) return "e";
    const freqPPM = rf.freqPPM !== 0 ? rf.freqPPM : b0Tesla > 0 ? 1e6 * rf.freqOffset / (GAMMA_HZ_T2 * b0Tesla) : 0;
    const durEst = estimateRfDuration(rf, seq);
    if (durEst > 6e-3 && freqPPM >= -4.5 && freqPPM <= -3) return "s";
    return "r";
  }
  function estimateFlipAngleDeg(rf, seq) {
    const magShape = seq.shapes.get(rf.magShapeId);
    if (magShape && magShape.numSamples > 0) {
      const raster = seq.rasterTimes.rfRaster;
      const timeShape = rf.timeShapeId > 0 ? seq.shapes.get(rf.timeShapeId)?.samples : void 0;
      let area = 0;
      let prevT = timeShape ? timeShape[0] * raster : 0.5 * raster;
      let prevAmp = Math.abs(rf.amplitude * magShape.samples[0]);
      for (let i = 1; i < magShape.numSamples; i++) {
        const t = timeShape ? timeShape[i] * raster : (i + 0.5) * raster;
        const amp = Math.abs(rf.amplitude * magShape.samples[i]);
        const dt = t - prevT;
        if (dt > 0) area += 0.5 * (prevAmp + amp) * dt;
        prevT = t;
        prevAmp = amp;
      }
      return 360 * area;
    }
    const absAmp = Math.abs(rf.amplitude);
    if (absAmp > 3e3) return 180;
    if (absAmp > 1500) return 120;
    return 90;
  }
  function estimateRfCenter(rf, _seq) {
    const magShape = _seq.shapes.get(rf.magShapeId);
    if (!magShape || magShape.numSamples <= 0) return 0;
    let peakIdx = 0;
    let peak = Math.abs(magShape.samples[0]);
    for (let i = 1; i < magShape.numSamples; i++) {
      const v = Math.abs(magShape.samples[i]);
      if (v > peak) {
        peak = v;
        peakIdx = i;
      }
    }
    const raster = _seq.rasterTimes.rfRaster;
    const timeShape = rf.timeShapeId > 0 ? _seq.shapes.get(rf.timeShapeId)?.samples : void 0;
    return timeShape ? (timeShape[peakIdx] ?? 0) * raster : (peakIdx + 0.5) * raster;
  }
  function estimateRfDuration(rf, seq) {
    const magShape = seq.shapes.get(rf.magShapeId);
    if (!magShape || magShape.numSamples <= 0) return 0;
    const raster = seq.rasterTimes.rfRaster;
    const timeShape = rf.timeShapeId > 0 ? seq.shapes.get(rf.timeShapeId)?.samples : void 0;
    if (timeShape && timeShape.length > 0) {
      return timeShape[timeShape.length - 1] * raster + raster;
    }
    return magShape.numSamples * raster;
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
    return Math.round(median * 1e6) / 1e6;
  }

  // src/pulseq/kspaceExportArtifacts.ts
  function exportKspaceArtifacts(sequenceText, sequenceName, options = {}) {
    const seq = parseSequenceText(sequenceText);
    return exportKspaceArtifactsFromSequence(seq, sequenceName, options);
  }
  function exportKspaceArtifactsFromBytes(sequenceBytes, sequenceName, options = {}) {
    const seq = parseSequenceBytes(sequenceBytes, sequenceName);
    return exportKspaceArtifactsFromSequence(seq, sequenceName, options);
  }
  function exportKspaceArtifactsFromSequence(seq, sequenceName, options = {}) {
    const decoded = decodeAllBlocks(seq);
    const totalDuration = getTotalDuration(seq);
    const gradientSupport = options.gradientSupport ?? "all";
    const kspace = calculateKspace(
      decoded,
      seq.rasterTimes.gradientRaster,
      totalDuration,
      0,
      { maxGridPoints: options.maxGridPoints, rfRaster: seq.rasterTimes.rfRaster, gradientSupport }
    );
    if (!kspace) {
      throw new Error("Unable to calculate k-space trajectory for sequence");
    }
    const metadata = createMetadata(
      seq,
      kspace,
      sequenceName,
      options.sequenceSha256 ?? "unknown",
      options.packageVersion ?? "unknown",
      !!options.includeFullTrajectory,
      totalDuration,
      gradientSupport
    );
    return {
      ktrajAdcText: formatTrajectoryText(kspace.ktraj_adc),
      ktrajText: options.includeFullTrajectory ? formatTrajectoryText(kspace.ktraj) : void 0,
      metadata
    };
  }
  function formatTrajectoryText(series) {
    assertThreeEqualLengthSeries(series);
    const n = series[0].length;
    if (n === 0) return "";
    const rows = [];
    for (let i = 0; i < n; i++) {
      rows.push(`${formatFloat(series[0][i])} ${formatFloat(series[1][i])} ${formatFloat(series[2][i])}`);
    }
    return `${rows.join("\n")}
`;
  }
  function formatFloat(value) {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
    const normalized = Object.is(value, -0) ? 0 : value;
    return normalized.toExponential(12).replace(/e([+-])(\d+)$/, (_match, sign, exponent) => `e${sign}${exponent.padStart(2, "0")}`);
  }
  function createMetadata(seq, kspace, sequenceName, sequenceSha256, packageVersion, includeFullTrajectory, totalDurationSec, gradientSupport) {
    return {
      schemaVersion: 1,
      sequenceName,
      sequenceSha256,
      packageVersion,
      pulseqVersion: {
        major: seq.version.major,
        minor: seq.version.minor,
        revision: seq.version.revision,
        combined: seq.versionCombined
      },
      blockCount: seq.blocks.length,
      rasterTimes: {
        blockDuration: seq.rasterTimes.blockDurationRaster,
        gradient: seq.rasterTimes.gradientRaster,
        rf: seq.rasterTimes.rfRaster,
        adc: seq.rasterTimes.adcRaster
      },
      totalDurationSec,
      adcSampleCount: kspace.t_adc.length,
      trajectorySampleCount: kspace.t_ktraj.length,
      units: {
        trajectory: "1/m",
        time: "s",
        gradient: "Hz/m",
        convention: "Pulseq gradient integral without 2*pi factor"
      },
      calculation: {
        gradientSupport
      },
      files: includeFullTrajectory ? { ktrajAdc: "ktraj_adc.txt", ktraj: "ktraj.txt" } : { ktrajAdc: "ktraj_adc.txt" }
    };
  }
  function assertThreeEqualLengthSeries(series) {
    if (series.length !== 3) {
      throw new Error(`Expected three trajectory axes, received ${series.length}`);
    }
    const n = series[0].length;
    if (series[1].length !== n || series[2].length !== n) {
      throw new Error("Trajectory axes have mismatched sample counts");
    }
  }

  // web/pulseq-browser.ts
  var PACKAGE_VERSION = version;
  return __toCommonJS(pulseq_browser_exports);
})();
