"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

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
    "TRID": { labelId: 11, flagId: 0 },
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
    const version = seq.versionCombined > 0 ? seq.versionCombined : makeVersionCombined(seq.version.major, seq.version.minor, seq.version.revision);
    if (version >= VER_PRE_14) {
      requireNumericDefinition(seq, "AdcRasterTime");
      requireNumericDefinition(seq, "GradientRasterTime");
      requireNumericDefinition(seq, "RadiofrequencyRasterTime");
      requireNumericDefinition(seq, "BlockDurationRaster");
    }
    if (version >= VER_V15001) {
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
      if (!/^[erispou]$/.test(use)) reader.fail(`invalid RF use flag '${use}'`);
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
      const name = BINARY_LABELS[labelIndex - 1];
      const { labelId, flagId } = decodeLabel(name);
      const spec = { id, value, labelId, flagId, name };
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
      const norm2 = Math.hypot(...values);
      if (!Number.isFinite(norm2) || norm2 <= 0) reader.fail("invalid zero or non-finite rotation quaternion");
      seq.rotations.push({ id, values: values.map((value) => value / norm2) });
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
        if (!/^[erispou]$/.test(use)) parseError(`RF row has invalid use flag '${parts[11]}': ${line}`);
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
        const norm2 = Math.sqrt(q0 * q0 + q1 * q1 + q2 * q2 + q3 * q3);
        if (Math.abs(norm2 - 1) > 1e-3 || norm2 === 0) {
          parseError(`ROTATIONS row has a non-normalized quaternion: ${line}`);
        }
        seq.rotations.push({
          id: toInt(p[0], "ROTATIONS", line),
          values: [q0 / norm2, q1 / norm2, q2 / norm2, q3 / norm2]
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
        flagId,
        name: p[2]
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

  // src/pulseq/rfWaveform.ts
  function rasterCellCount(shapes) {
    if (!shapes.timeShape) {
      return Math.min(shapes.magnitude.length, shapes.phaseCycles?.length ?? shapes.magnitude.length);
    }
    const count = breakpointCount(shapes);
    if (count < 2) return count;
    const span = (shapes.timeShape[count - 1] - shapes.timeShape[0]) * shapes.raster;
    return Math.max(1, Math.round(span / shapes.raster));
  }
  function forEachRasterCell(shapes, visit) {
    const { raster, magnitude, phaseCycles, timeShape } = shapes;
    if (!timeShape) {
      const count2 = rasterCellCount(shapes);
      for (let i = 0; i < count2; i++) visit(i * raster, raster, magnitude[i], phaseCycles ? phaseCycles[i] : 0);
      return;
    }
    const points = breakpointCount(shapes);
    if (points < 2) return;
    const first = timeShape[0] * raster;
    const last = timeShape[points - 1] * raster;
    const count = Math.max(1, Math.round((last - first) / raster));
    const width = (last - first) / count;
    let k = 0;
    for (let i = 0; i < count; i++) {
      const start = first + i * width;
      const mid = start + 0.5 * width;
      while (k + 1 < points - 1 && timeShape[k + 1] * raster <= mid) k++;
      const t0 = timeShape[k] * raster;
      const t1 = timeShape[k + 1] * raster;
      const u = t1 > t0 ? (mid - t0) / (t1 - t0) : 0;
      const p0 = phaseCycles ? phaseCycles[k] : 0;
      const p1 = phaseCycles ? phaseCycles[k + 1] : 0;
      visit(start, width, magnitude[k] + u * (magnitude[k + 1] - magnitude[k]), p0 + u * (p1 - p0));
    }
  }
  function rasterCellsFromShapes(shapes) {
    const cells = allocate(rasterCellCount(shapes), !shapes.timeShape);
    let i = 0;
    forEachRasterCell(shapes, (start, width, magnitude, phase) => {
      cells.start[i] = start;
      cells.width[i] = width;
      cells.magnitude[i] = magnitude;
      cells.phaseCycles[i] = phase;
      i++;
    });
    return cells;
  }
  function detectPtxTimeShapeChannels(timeShape) {
    const n = timeShape.length;
    if (n < 2) return 0;
    const first = timeShape[0];
    let repeats = 0;
    for (let i = 0; i < n; i++) {
      if (timeShape[i] === first) repeats++;
    }
    if (repeats < 2 || n % repeats !== 0) return 0;
    const perChannel = n / repeats;
    for (let channel = 1; channel < repeats; channel++) {
      const offset = channel * perChannel;
      for (let i = 0; i < perChannel; i++) {
        if (timeShape[offset + i] !== timeShape[i]) return 0;
      }
    }
    return repeats;
  }
  function rfShapeArrays(rf, seq) {
    const magnitude = seq.shapes.get(rf.magShapeId)?.samples;
    if (!magnitude || magnitude.length < 1) return null;
    const phase = rf.phaseShapeId > 0 ? seq.shapes.get(rf.phaseShapeId)?.samples ?? null : null;
    let time = rf.timeShapeId > 0 ? seq.shapes.get(rf.timeShapeId)?.samples ?? null : null;
    if (time) {
      const channels = detectPtxTimeShapeChannels(time);
      if (channels > 1) time = time.subarray(0, time.length / channels);
    }
    return { raster: seq.rasterTimes.rfRaster, magnitude, phaseCycles: phase, timeShape: time };
  }
  function rfShapeDuration(shapes) {
    if (!shapes.timeShape) return rasterCellCount(shapes) * shapes.raster;
    const points = breakpointCount(shapes);
    return points > 0 ? shapes.timeShape[points - 1] * shapes.raster : 0;
  }
  function breakpointCount(shapes) {
    return Math.min(
      shapes.magnitude.length,
      shapes.phaseCycles?.length ?? shapes.magnitude.length,
      shapes.timeShape?.length ?? shapes.magnitude.length
    );
  }
  function allocate(count, uniform) {
    return {
      count,
      start: new Float64Array(count),
      width: new Float64Array(count),
      magnitude: new Float64Array(count),
      phaseCycles: new Float64Array(count),
      uniform
    };
  }

  // src/sim/conventions.ts
  var PULSEQ_GAMMA_HZ_PER_T = 42576e3;
  var DEFAULT_B0_T = 3;
  function demodulationPhase(phaseOffset, freqOffset, dwell, s, phaseModulation) {
    const t = (s + 0.5) * dwell;
    return phaseOffset + 2 * Math.PI * freqOffset * t + (phaseModulation ? phaseModulation[s] : 0);
  }

  // src/pulseq/rfClassification.ts
  var GAMMA_HZ_T = 42576e3;
  var DEFAULT_B0_T2 = 3;
  var sequenceUseCache = /* @__PURE__ */ new WeakMap();
  function classifyRfUse(rf, seq) {
    if (seq.versionCombined >= VER_V15 && rf.use && rf.use.toLowerCase() !== "u") {
      return rf.use.toLowerCase();
    }
    const flipAngleDeg = estimateRfFlipAngleDeg(rf, seq);
    if (isLegacyFatSaturation(rf, seq)) return "s";
    return flipAngleDeg >= 120 ? "r" : "e";
  }
  function classifyRfUses(seq) {
    const cachedUses = sequenceUseCache.get(seq);
    if (cachedUses) return cachedUses;
    const libraryUses = /* @__PURE__ */ new Map();
    const uses = seq.blocks.map((block) => {
      if (block.rfId <= 0) return "";
      const cached = libraryUses.get(block.rfId);
      if (cached !== void 0) return cached;
      const rf = seq.rfs.get(block.rfId);
      const use = rf ? classifyRfUse(rf, seq) : "";
      libraryUses.set(block.rfId, use);
      return use;
    });
    if (seq.versionCombined >= VER_V15 || uses.includes("e")) {
      sequenceUseCache.set(seq, uses);
      return uses;
    }
    const saturationBlocks = uses.map((use, index) => use === "s" ? index : -1).filter((index) => index >= 0);
    if (saturationBlocks.length < 2) {
      sequenceUseCache.set(seq, uses);
      return uses;
    }
    for (let anchor = 0; anchor < saturationBlocks.length; anchor++) {
      const start = saturationBlocks[anchor] + 1;
      const end = saturationBlocks[anchor + 1] ?? uses.length;
      for (let index = start; index < end; index++) {
        if (!uses[index] || uses[index] === "s") continue;
        uses[index] = "e";
        break;
      }
    }
    sequenceUseCache.set(seq, uses);
    return uses;
  }
  function estimateRfFlipAngleDeg(rf, seq) {
    const magShape = seq.shapes.get(rf.magShapeId);
    if (magShape && magShape.numSamples > 0) {
      const raster = seq.rasterTimes.rfRaster;
      const timeShape = rf.timeShapeId > 0 ? seq.shapes.get(rf.timeShapeId)?.samples : void 0;
      let area = 0;
      let previousTime = timeShape ? timeShape[0] * raster : 0.5 * raster;
      let previousAmplitude = Math.abs(rf.amplitude * magShape.samples[0]);
      for (let index = 1; index < magShape.numSamples; index++) {
        const time = timeShape ? timeShape[index] * raster : (index + 0.5) * raster;
        const amplitude = Math.abs(rf.amplitude * magShape.samples[index]);
        const duration = time - previousTime;
        if (duration > 0) area += 0.5 * (previousAmplitude + amplitude) * duration;
        previousTime = time;
        previousAmplitude = amplitude;
      }
      return 360 * area;
    }
    const absoluteAmplitude = Math.abs(rf.amplitude);
    if (absoluteAmplitude > 3e3) return 180;
    if (absoluteAmplitude > 1500) return 120;
    return 90;
  }
  function isLegacyFatSaturation(rf, seq) {
    const b0Tesla = getB0(seq);
    const frequencyPpm = rf.freqPPM !== 0 ? rf.freqPPM : b0Tesla > 0 ? 1e6 * rf.freqOffset / (GAMMA_HZ_T * b0Tesla) : 0;
    const durationSec = estimateRfDuration(rf, seq);
    return durationSec > 6e-3 && frequencyPpm >= -4.5 && frequencyPpm <= -3;
  }
  function estimateRfDuration(rf, seq) {
    const magShape = seq.shapes.get(rf.magShapeId);
    if (!magShape || magShape.numSamples <= 0) return 0;
    const raster = seq.rasterTimes.rfRaster;
    const timeShape = rf.timeShapeId > 0 ? seq.shapes.get(rf.timeShapeId)?.samples : void 0;
    if (timeShape && timeShape.length > 0) {
      return timeShape[timeShape.length - 1] * raster;
    }
    return magShape.numSamples * raster;
  }
  function getB0(seq) {
    const raw = seq.definitions.get("B0") ?? seq.definitions.get("b0") ?? seq.definitions.get("b_0");
    if (raw && raw.length > 0) return +raw[0];
    return DEFAULT_B0_T2;
  }

  // src/pulseq/fft.ts
  var twiddleCache = /* @__PURE__ */ new Map();
  function isPowerOfTwo(n) {
    return n > 0 && (n & n - 1) === 0;
  }
  function nextPowerOfTwo(n) {
    if (n <= 1) return 1;
    let p = 1;
    while (p < n) p *= 2;
    return p;
  }
  function getTwiddles(n) {
    const cached = twiddleCache.get(n);
    if (cached) return cached;
    if (!isPowerOfTwo(n)) throw new Error(`FFT size must be a power of two, got ${n}`);
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      const angle = -2 * Math.PI * i / n;
      cos[i] = Math.cos(angle);
      sin[i] = Math.sin(angle);
    }
    const bits = Math.round(Math.log2(n));
    const reverse = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & 1 << b) r |= 1 << bits - 1 - b;
      reverse[i] = r;
    }
    const table = { cos, sin, reverse };
    twiddleCache.set(n, table);
    return table;
  }
  function fftInPlace(re, im, n) {
    const { cos, sin, reverse } = getTwiddles(n);
    for (let i = 0; i < n; i++) {
      const j = reverse[i];
      if (j > i) {
        let tmp = re[i];
        re[i] = re[j];
        re[j] = tmp;
        tmp = im[i];
        im[i] = im[j];
        im[j] = tmp;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const twiddleIndex = k * step;
          const wr = cos[twiddleIndex];
          const wi = sin[twiddleIndex];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }

  // src/pulseq/rfResponse.ts
  var MAX_RF_RESPONSE_FFT_POINTS = 131072;
  var MAX_RF_RESPONSE_SAMPLES = 131072;
  var MAX_RF_RESPONSE_BANDS = 8;
  var MIN_FFT_POINTS = 64;
  var ZERO_PAD_FACTOR = 4;
  var DOMINANT_BAND_FRACTION = 0.5;
  var MIN_DOMINANT_AREA_DEG = 0.01;
  var DEG_PER_CYCLE = 360;
  var TAU = 2 * Math.PI;
  function analyzeRfResponse(rf, seq, classifiedUse = rf.use) {
    if (rfSampleCount(rf, seq) > MAX_RF_RESPONSE_SAMPLES) {
      return {
        carrierAreaDeg: estimateRfCarrierAreaDeg(rf, seq),
        bands: [],
        spectrumAnalyzed: false,
        limited: true
      };
    }
    const samples = buildComplexRfSamples(rf, seq);
    const carrierAreaDeg = frequencyResolvedAreaDeg(samples, 0);
    const normalizedUse = classifiedUse.toLowerCase();
    const inversion = normalizedUse === "i" || normalizedUse === "inversion";
    let offsets;
    let spectrumAnalyzed = false;
    let limited = false;
    if (inversion) {
      offsets = [0];
    } else if (samples.uniform && samples.real.length <= MAX_RF_RESPONSE_FFT_POINTS) {
      offsets = dominantBandOffsets(samples);
      spectrumAnalyzed = true;
    } else {
      offsets = [0];
      limited = true;
    }
    const bands = offsets.map((frequencyOffsetHz) => {
      const spectralAreaDeg = frequencyResolvedAreaDeg(samples, frequencyOffsetHz);
      const spinor = propagateSpinor(samples, frequencyOffsetHz);
      return {
        frequencyOffsetHz,
        spectralAreaDeg,
        polarFlipDeg: spinor.polarFlipDeg,
        mz: spinor.mz
      };
    });
    return { carrierAreaDeg, bands, spectrumAnalyzed, limited };
  }
  function estimateRfCarrierAreaDeg(rf, seq) {
    const shapes = rfShapeArrays(rf, seq);
    if (!shapes) return 0;
    let realArea = 0;
    let imaginaryArea = 0;
    forEachRasterCell(shapes, (_start, width, magnitude, phaseCycles) => {
      const amplitude = rf.amplitude * magnitude;
      const phaseRad = TAU * phaseCycles;
      if (!Number.isFinite(amplitude) || !Number.isFinite(phaseRad)) return;
      realArea += amplitude * Math.cos(phaseRad) * width;
      imaginaryArea += amplitude * Math.sin(phaseRad) * width;
    });
    return DEG_PER_CYCLE * Math.hypot(realArea, imaginaryArea);
  }
  function rfSampleCount(rf, seq) {
    const shapes = rfShapeArrays(rf, seq);
    return shapes ? rasterCellCount(shapes) : 0;
  }
  function buildComplexRfSamples(rf, seq) {
    const raster = seq.rasterTimes.rfRaster;
    const shapes = rfShapeArrays(rf, seq);
    if (!shapes) return emptySamples(raster);
    const cells = rasterCellsFromShapes(shapes);
    if (cells.count < 1) return emptySamples(raster);
    const real = new Float64Array(cells.count);
    const imaginary = new Float64Array(cells.count);
    const times = new Float64Array(cells.count);
    const widths = new Float64Array(cells.count);
    let uniform = true;
    for (let index = 0; index < cells.count; index++) {
      const amplitude = rf.amplitude * cells.magnitude[index];
      const phaseRad = TAU * cells.phaseCycles[index];
      const width = cells.width[index];
      times[index] = cells.start[index] + 0.5 * width;
      widths[index] = Number.isFinite(width) && width > 0 ? width : 0;
      const finite = Number.isFinite(amplitude) && Number.isFinite(phaseRad);
      real[index] = finite ? amplitude * Math.cos(phaseRad) : 0;
      imaginary[index] = finite ? amplitude * Math.sin(phaseRad) : 0;
      if (Math.abs(widths[index] - raster) > Math.max(1e-12, raster * 1e-6)) uniform = false;
    }
    return { real, imaginary, times, widths, uniform, dwell: uniform ? raster : widths[0] };
  }
  function emptySamples(raster) {
    return {
      real: new Float64Array(0),
      imaginary: new Float64Array(0),
      times: new Float64Array(0),
      widths: new Float64Array(0),
      uniform: true,
      dwell: raster
    };
  }
  function frequencyResolvedAreaDeg(samples, frequencyOffsetHz) {
    let realArea = 0;
    let imaginaryArea = 0;
    for (let index = 0; index < samples.real.length; index++) {
      const angle = -TAU * frequencyOffsetHz * samples.times[index];
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const width = samples.widths[index];
      realArea += (samples.real[index] * cosine - samples.imaginary[index] * sine) * width;
      imaginaryArea += (samples.real[index] * sine + samples.imaginary[index] * cosine) * width;
    }
    return DEG_PER_CYCLE * Math.hypot(realArea, imaginaryArea);
  }
  function dominantBandOffsets(samples) {
    const sampleCount = samples.real.length;
    if (sampleCount === 0 || !Number.isFinite(samples.dwell) || samples.dwell <= 0) return [0];
    const paddedTarget = sampleCount <= Math.floor(MAX_RF_RESPONSE_FFT_POINTS / ZERO_PAD_FACTOR) ? sampleCount * ZERO_PAD_FACTOR : sampleCount;
    const fftPoints = nextPowerOfTwo(Math.max(MIN_FFT_POINTS, paddedTarget));
    if (fftPoints > MAX_RF_RESPONSE_FFT_POINTS) return [0];
    const real = new Float64Array(fftPoints);
    const imaginary = new Float64Array(fftPoints);
    real.set(samples.real);
    imaginary.set(samples.imaginary);
    fftInPlace(real, imaginary, fftPoints);
    let peakAreaDeg = 0;
    for (let bin = 0; bin < fftPoints; bin++) {
      peakAreaDeg = Math.max(
        peakAreaDeg,
        DEG_PER_CYCLE * samples.dwell * Math.hypot(real[bin], imaginary[bin])
      );
    }
    if (!Number.isFinite(peakAreaDeg) || peakAreaDeg < MIN_DOMINANT_AREA_DEG) return [0];
    const threshold = Math.max(MIN_DOMINANT_AREA_DEG, peakAreaDeg * DOMINANT_BAND_FRACTION);
    const clusters = [];
    let active = null;
    const half = fftPoints / 2;
    const frequencyStep = 1 / (fftPoints * samples.dwell);
    for (let signedBin = -half; signedBin < half; signedBin++) {
      const bin = signedBin < 0 ? signedBin + fftPoints : signedBin;
      const areaDeg = DEG_PER_CYCLE * samples.dwell * Math.hypot(real[bin], imaginary[bin]);
      if (areaDeg >= threshold) {
        const weight = areaDeg * areaDeg;
        if (!active) active = { frequencySum: 0, weightSum: 0, peakAreaDeg: 0 };
        active.frequencySum += signedBin * frequencyStep * weight;
        active.weightSum += weight;
        active.peakAreaDeg = Math.max(active.peakAreaDeg, areaDeg);
      } else if (active) {
        clusters.push(active);
        active = null;
      }
    }
    if (active) clusters.push(active);
    const offsets = clusters.filter((cluster) => cluster.weightSum > 0).sort((left, right) => right.peakAreaDeg - left.peakAreaDeg).slice(0, MAX_RF_RESPONSE_BANDS).map((cluster) => cluster.frequencySum / cluster.weightSum).sort((left, right) => left - right);
    return offsets.length > 0 ? offsets : [0];
  }
  function propagateSpinor(samples, frequencyOffsetHz) {
    let stateAReal = 1;
    let stateAImaginary = 0;
    let stateBReal = 0;
    let stateBImaginary = 0;
    for (let index = 0; index < samples.real.length; index++) {
      const bx = samples.real[index];
      const by = samples.imaginary[index];
      const norm2 = Math.hypot(bx, by, frequencyOffsetHz);
      const width = samples.widths[index];
      if (!(norm2 > 0) || !(width > 0)) continue;
      const sine = Math.sin(Math.PI * norm2 * width);
      const localAReal = Math.cos(Math.PI * norm2 * width);
      const localAImaginary = -frequencyOffsetHz / norm2 * sine;
      const localBReal = by / norm2 * sine;
      const localBImaginary = -bx / norm2 * sine;
      const nextAReal = localAReal * stateAReal - localAImaginary * stateAImaginary - localBReal * stateBReal - localBImaginary * stateBImaginary;
      const nextAImaginary = localAReal * stateAImaginary + localAImaginary * stateAReal - localBReal * stateBImaginary + localBImaginary * stateBReal;
      const nextBReal = localBReal * stateAReal - localBImaginary * stateAImaginary + localAReal * stateBReal + localAImaginary * stateBImaginary;
      const nextBImaginary = localBReal * stateAImaginary + localBImaginary * stateAReal + localAReal * stateBImaginary - localAImaginary * stateBReal;
      stateAReal = nextAReal;
      stateAImaginary = nextAImaginary;
      stateBReal = nextBReal;
      stateBImaginary = nextBImaginary;
    }
    const aMagnitudeSquared = stateAReal * stateAReal + stateAImaginary * stateAImaginary;
    const bMagnitudeSquared = stateBReal * stateBReal + stateBImaginary * stateBImaginary;
    const normalization = aMagnitudeSquared + bMagnitudeSquared;
    const mz = normalization > 0 ? clamp((aMagnitudeSquared - bMagnitudeSquared) / normalization, -1, 1) : 1;
    return { mz, polarFlipDeg: Math.acos(mz) * 180 / Math.PI };
  }
  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  // src/pulseq/decoder.ts
  var GAMMA_HZ_T2 = 42576e3;
  var DEFAULT_B0_T3 = 3;
  function getB02(seq) {
    const raw = seq.definitions.get("B0");
    if (raw && Array.isArray(raw) && raw.length > 0) return +raw[0];
    const raw2 = seq.definitions.get("b0") ?? seq.definitions.get("b_0");
    if (raw2 && Array.isArray(raw2) && raw2.length > 0) return +raw2[0];
    return DEFAULT_B0_T3;
  }
  function effFreqOff(freqOffset, freqPPM, b0) {
    return freqOffset + freqPPM * 1e-6 * GAMMA_HZ_T2 * b0;
  }
  function effPhaseOff(phaseOffset, phasePPM, b0) {
    return phaseOffset + phasePPM * 1e-6 * GAMMA_HZ_T2 * b0;
  }
  function createSequenceDecodeContext(seq) {
    const blockStartTimes = new Float64Array(seq.blocks.length + 1);
    for (let index = 0; index < seq.blocks.length; index++) {
      blockStartTimes[index + 1] = blockStartTimes[index] + blockDurationSeconds(seq, seq.blocks[index]);
    }
    return {
      sequence: seq,
      blockStartTimes,
      classifiedRfUses: classifyRfUses(seq),
      rfResponseCache: /* @__PURE__ */ new Map(),
      triggerCache: /* @__PURE__ */ new Map(),
      ncoCache: /* @__PURE__ */ new Map()
    };
  }
  function decodeBlockRange(seq, startBlockIdx, endBlockIdx, context = createSequenceDecodeContext(seq)) {
    if (context.sequence !== seq) throw new Error("The decode context belongs to a different sequence.");
    const totalBlocks = seq.blocks.length;
    const s = Math.max(0, Math.min(startBlockIdx, totalBlocks));
    const e = Math.max(s, Math.min(endBlockIdx, totalBlocks));
    if (s >= e) return [];
    let cumulative = context.blockStartTimes[s];
    const decoded = [];
    for (let i = s; i < e; i++) {
      const block = seq.blocks[i];
      const dur = blockDurationSeconds(seq, block);
      const db = { index: block.num, duration: dur, startTime: cumulative };
      if (block.rfId > 0) {
        const rf = seq.rfs.get(block.rfId);
        if (rf) {
          const use = context.classifiedRfUses[i];
          let response = context.rfResponseCache.get(rf.id);
          if (!response) {
            response = analyzeRfResponse(rf, seq, use);
            context.rfResponseCache.set(rf.id, response);
          }
          db.rf = decodeRF(seq, rf, cumulative, dur, use, response);
        }
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
        if (ext) decodeExtensions(seq, ext, db, cumulative, context);
      }
      decoded.push(db);
      cumulative += dur;
    }
    return decoded;
  }
  function blockDurationSeconds(seq, block) {
    if (seq.versionCombined < VER_PRE_14) return block.dur * 1e-6;
    return block.dur * seq.rasterTimes.blockDurationRaster;
  }
  function decodeRF(seq, rf, blockStart, _blockDur, classifiedUse, response) {
    const raster = seq.rasterTimes.rfRaster;
    const rfDelay = rf.delay * 1e-6;
    const rfStart = blockStart + rfDelay;
    const b0 = getB02(seq);
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
    const duration = n > 0 ? timeShape ? t[n - 1] - rfStart : n * raster : 0;
    const centerTime = rf.center >= 0 ? blockStart + rfDelay + rf.center * 1e-6 : estimateRfPeakTime(t, amp, rfStart, duration);
    const use = classifiedUse || "u";
    const ptxChannels = timeShape ? detectPtxTimeShapeChannels(timeShape) : 0;
    return {
      ...ptxChannels > 1 ? { ptxChannels } : {},
      blockIndex: rf.id,
      startTime: rfStart,
      centerTime,
      duration,
      timePoints: t,
      magnitude: amp,
      phase,
      amplitude: rf.amplitude,
      response,
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
    const b0 = getB02(seq);
    const freqFull = effFreqOff(adc.freqOffset, adc.freqPPM, b0);
    const phaseFull = effPhaseOff(adc.phaseOffset, adc.phasePPM, b0);
    const decoded = {
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
    const modulation = adc.phaseModShapeId > 0 ? seq.shapes.get(adc.phaseModShapeId) : void 0;
    if (modulation) decoded.phaseModulation = modulation.samples;
    return decoded;
  }
  function decodeExtensions(seq, ext, db, blockStart, context) {
    const visited = /* @__PURE__ */ new Set();
    let cur = ext;
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id);
      const type = seq.extensionTypes.get(cur.type) ?? 999 /* EXT_UNKNOWN */;
      if (type === 1 /* EXT_TRIGGER */) {
        let cached = context.triggerCache.get(cur.id);
        if (!cached) {
          const trigger = findById(seq.triggers, cur.ref);
          if (trigger) {
            cached = {
              blockIndex: trigger.id,
              startTime: 0,
              triggerType: trigger.triggerType,
              channel: trigger.channel,
              delay: trigger.delay * 1e-6,
              duration: trigger.duration * 1e-6
            };
            context.triggerCache.set(cur.id, cached);
          }
        }
        if (cached) {
          if (!db.triggers) db.triggers = [];
          db.triggers.push({ ...cached, startTime: blockStart });
        }
      } else if (type === 100 /* EXT_NCO */) {
        let cached = context.ncoCache.get(cur.id);
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
            context.ncoCache.set(cur.id, cached);
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

  // src/pulseq/physicalGradients.ts
  var GRADIENT_ENDPOINT_TOLERANCE_SEC = 1e-12;
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
  function gradientValueAt(g, t) {
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
  function physicalGradientPiece(block, axis) {
    const gradients = [block.gx, block.gy, block.gz];
    const hasGradient = gradients.some((g) => g && g.type !== "none" && g.timePoints.length >= 2);
    if (!hasGradient) return { times: [], values: [], requiredSupport: [] };
    if (!block.rotation?.values) {
      const gradient = gradients[axis];
      if (!gradient || gradient.type === "none" || gradient.timePoints.length < 2) {
        return { times: [], values: [], requiredSupport: [] };
      }
      return {
        times: Array.from(gradient.timePoints),
        values: Array.from(gradient.waveform),
        requiredSupport: []
      };
    }
    const times = [];
    for (const gradient of gradients) {
      if (!gradient || gradient.type === "none") continue;
      for (const time of gradient.timePoints) times.push(time);
    }
    times.sort((a, b) => a - b);
    const uniqueTimes = [];
    for (const time of times) {
      if (!uniqueTimes.length || time - uniqueTimes[uniqueTimes.length - 1] > GRADIENT_ENDPOINT_TOLERANCE_SEC) {
        uniqueTimes.push(time);
      }
    }
    return {
      times: uniqueTimes,
      values: uniqueTimes.map((time) => {
        const rotated = rotateGradient(
          block,
          gradientValueAt(block.gx, time),
          gradientValueAt(block.gy, time),
          gradientValueAt(block.gz, time)
        );
        return rotated[axis];
      }),
      requiredSupport: []
    };
  }

  // src/pulseq/gradientTimeline.ts
  var SERIES_PADDING_EPSILON_SEC = 1e-12;
  var GAP_EDGE_SNAP_HZ_PER_M = 1e-6;
  var CHUNK_BITS = 16;
  var CHUNK_SIZE = 1 << CHUNK_BITS;
  var CHUNK_MASK = CHUNK_SIZE - 1;
  var Float64Chunks = class {
    constructor() {
      __publicField(this, "chunks", []);
      __publicField(this, "count", 0);
    }
    get length() {
      return this.count;
    }
    push(value) {
      const chunkIndex = this.count >>> CHUNK_BITS;
      let chunk = this.chunks[chunkIndex];
      if (!chunk) {
        chunk = new Float64Array(CHUNK_SIZE);
        this.chunks[chunkIndex] = chunk;
      }
      chunk[this.count & CHUNK_MASK] = value;
      this.count++;
    }
    /** Value at an absolute index; throws if that chunk was released. */
    get(index) {
      if (index < 0 || index >= this.count) throw new RangeError(`index ${index} out of range [0, ${this.count})`);
      const chunk = this.chunks[index >>> CHUNK_BITS];
      if (!chunk) throw new RangeError(`index ${index} was released`);
      return chunk[index & CHUNK_MASK];
    }
    /** Release every chunk that lies entirely before `index`. */
    releaseBefore(index) {
      const lastReleasable = Math.min(index, this.count) >>> CHUNK_BITS;
      for (let i = 0; i < lastReleasable; i++) this.chunks[i] = null;
    }
    /** Exact-size copy of every value (none may have been released). */
    toArray() {
      const out = new Float64Array(this.count);
      for (let i = 0, offset = 0; offset < this.count; i++, offset += CHUNK_SIZE) {
        const chunk = this.chunks[i];
        if (!chunk) throw new RangeError("cannot copy a series whose chunks were released");
        const n = Math.min(CHUNK_SIZE, this.count - offset);
        out.set(n === CHUNK_SIZE ? chunk : chunk.subarray(0, n), offset);
      }
      return out;
    }
    clear() {
      this.chunks.length = 0;
      this.count = 0;
    }
  };
  var GradientAxisAssembler = class {
    /**
     * @param collectSupport  Record the support points the k-space `endpoints`
     *   grid needs. Streaming consumers pass false: the list would otherwise
     *   grow with the whole sequence.
     */
    constructor(gradientRaster, carry, collectSupport = true) {
      __publicField(this, "gradientRaster", gradientRaster);
      __publicField(this, "collectSupport", collectSupport);
      __publicField(this, "times", new Float64Chunks());
      __publicField(this, "values", new Float64Chunks());
      __publicField(this, "requiredSupport", new Float64Chunks());
      __publicField(this, "started", false);
      __publicField(this, "pendingTime", 0);
      __publicField(this, "pendingValue", 0);
      __publicField(this, "finished", false);
      if (carry?.started) {
        this.started = true;
        this.pendingTime = carry.pendingTime;
        this.pendingValue = carry.pendingValue;
      }
    }
    /** Whether any piece has been appended to this axis. */
    get hasSupport() {
      return this.started;
    }
    /** True while the last appended point is still held back (not yet final). */
    get hasPending() {
      return this.started && !this.finished;
    }
    get heldTime() {
      return this.pendingTime;
    }
    get heldValue() {
      return this.pendingValue;
    }
    /**
     * Latest time through which the waveform of this axis can no longer change,
     * given that no piece still to be appended can start before `nextPieceTime`
     * (+∞ when no further piece will arrive on this axis).
     *
     * Emitted points are final. The held-back point is final unless it is a tiny
     * nonzero value the gap rule may still snap to zero. Past it, a nonzero
     * value's continuation depends on the next piece (continuation, ramp or
     * padding), while a zero value stays zero until within one raster of the
     * next piece.
     */
    finalThrough(nextPieceTime) {
      if (this.finished) return Number.POSITIVE_INFINITY;
      if (!this.started) return nextPieceTime - this.gradientRaster;
      if (this.pendingValue !== 0) {
        if (Math.abs(this.pendingValue) <= GAP_EDGE_SNAP_HZ_PER_M) {
          return this.times.length ? this.times.get(this.times.length - 1) : Number.NEGATIVE_INFINITY;
        }
        return this.pendingTime;
      }
      return Math.max(this.pendingTime, nextPieceTime - this.gradientRaster);
    }
    carry() {
      return { started: this.started, pendingTime: this.pendingTime, pendingValue: this.pendingValue };
    }
    /** Append one block's piece of this axis (times ascending, absolute [s]). */
    appendPiece(times, values) {
      if (this.finished) throw new Error("cannot append to a finished gradient series");
      const n = times.length;
      if (!n) return;
      const firstTime = times[0];
      this.support(firstTime);
      this.support(times[n - 1]);
      if (!this.started) {
        if (firstTime > 0) {
          this.pushPoint(-SERIES_PADDING_EPSILON_SEC, 0);
          this.pushPoint(firstTime - SERIES_PADDING_EPSILON_SEC, 0);
          this.support(-SERIES_PADDING_EPSILON_SEC);
          this.support(firstTime - SERIES_PADDING_EPSILON_SEC);
        }
        for (let i = 0; i < n; i++) this.pushPoint(times[i], values[i]);
        return;
      }
      const raster = this.gradientRaster;
      const previousTime = this.pendingTime;
      let firstValue = values[0];
      if (previousTime + raster < firstTime) {
        if (this.pendingValue !== 0) {
          if (Math.abs(this.pendingValue) > GAP_EDGE_SNAP_HZ_PER_M) {
            this.pushPoint(previousTime + raster * 0.5, 0);
            this.support(previousTime + raster * 0.5);
          } else {
            this.pendingValue = 0;
          }
        }
        if (firstValue !== 0) {
          if (Math.abs(firstValue) > GAP_EDGE_SNAP_HZ_PER_M) {
            this.pushPoint(firstTime - raster * 0.5, 0);
            this.support(firstTime - raster * 0.5);
          } else {
            firstValue = 0;
          }
        }
      }
      const currentLast = this.pendingTime;
      let start = 0;
      while (start < n && times[start] <= currentLast) start++;
      for (let i = start; i < n; i++) this.pushPoint(times[i], i === 0 ? firstValue : values[i]);
    }
    /** Emit the held-back point and the trailing zero padding. */
    finish(totalDuration) {
      if (this.finished) return;
      this.finished = true;
      if (!this.started) return;
      const last = this.pendingTime;
      this.emit(this.pendingTime, this.pendingValue);
      if (last < totalDuration) {
        this.emit(last + SERIES_PADDING_EPSILON_SEC, 0);
        this.emit(totalDuration + SERIES_PADDING_EPSILON_SEC, 0);
        this.support(last + SERIES_PADDING_EPSILON_SEC);
        this.support(totalDuration + SERIES_PADDING_EPSILON_SEC);
      }
    }
    /** Copy out the finished series and drop the chunked storage. */
    freeze() {
      if (!this.finished) throw new Error("finish() the series before freezing it");
      const frozen = {
        times: this.times.toArray(),
        values: this.values.toArray(),
        requiredSupport: this.requiredSupport.toArray()
      };
      this.times.clear();
      this.values.clear();
      this.requiredSupport.clear();
      return frozen;
    }
    support(time) {
      if (this.collectSupport) this.requiredSupport.push(time);
    }
    pushPoint(time, value) {
      if (this.started) this.emit(this.pendingTime, this.pendingValue);
      this.started = true;
      this.pendingTime = time;
      this.pendingValue = value;
    }
    emit(time, value) {
      this.times.push(time);
      this.values.push(value);
    }
  };
  var GradientTimelineBuilder = class {
    constructor(gradientRaster, carry, collectSupport = true) {
      __publicField(this, "gradientRaster", gradientRaster);
      __publicField(this, "axes");
      if (!(gradientRaster > 0)) throw new Error("gradientRaster must be positive");
      if (carry && carry.gradientRaster !== gradientRaster) {
        throw new Error("carry was captured with a different gradient raster");
      }
      this.axes = [
        new GradientAxisAssembler(gradientRaster, carry?.axes[0], collectSupport),
        new GradientAxisAssembler(gradientRaster, carry?.axes[1], collectSupport),
        new GradientAxisAssembler(gradientRaster, carry?.axes[2], collectSupport)
      ];
    }
    /** Append the next block (blocks must arrive in time order). */
    append(block) {
      for (let axis = 0; axis < 3; axis++) {
        const piece = physicalGradientPiece(block, axis);
        if (piece.times.length) this.axes[axis].appendPiece(piece.times, piece.values);
      }
    }
    /** State at the current block boundary; restore with the constructor. */
    snapshotCarry() {
      return {
        gradientRaster: this.gradientRaster,
        axes: [this.axes[0].carry(), this.axes[1].carry(), this.axes[2].carry()]
      };
    }
    finish(totalDuration) {
      for (const axis of this.axes) axis.finish(totalDuration);
    }
    /**
     * Latest time through which all three axes are final, given per axis the
     * earliest time a not-yet-appended piece can start (see the axis method).
     */
    finalThrough(nextPieceTimes) {
      return Math.min(
        this.axes[0].finalThrough(nextPieceTimes[0]),
        this.axes[1].finalThrough(nextPieceTimes[1]),
        this.axes[2].finalThrough(nextPieceTimes[2])
      );
    }
  };

  // src/sim/program/hash.ts
  var ContentHasher = class {
    constructor() {
      __publicField(this, "h1a", 3735928559 ^ 42);
      __publicField(this, "h2a", 1103547991 ^ 42);
      __publicField(this, "h1b", 3735928559 ^ 2135587861);
      __publicField(this, "h2b", 1103547991 ^ 2135587861);
      __publicField(this, "scratch", new Float64Array(1));
      __publicField(this, "scratchWords", new Uint32Array(this.scratch.buffer));
    }
    /** Mix one unsigned 32-bit word. */
    word(value) {
      const w = value >>> 0;
      this.h1a = Math.imul(this.h1a ^ w, 2654435761);
      this.h2a = Math.imul(this.h2a ^ w, 1597334677);
      this.h1b = Math.imul(this.h1b ^ w, 2246822507);
      this.h2b = Math.imul(this.h2b ^ w, 3266489909);
      return this;
    }
    /** Mix one double by its bit pattern (−0 and +0 hash differently). */
    number(value) {
      this.scratch[0] = value;
      return this.word(this.scratchWords[0]).word(this.scratchWords[1]);
    }
    numbers(values) {
      this.word(values.length);
      for (let i = 0; i < values.length; i++) this.number(values[i]);
      return this;
    }
    text(value) {
      this.word(value.length);
      for (let i = 0; i < value.length; i++) this.word(value.charCodeAt(i));
      return this;
    }
    /** Hex digest; the hasher can keep absorbing afterwards. */
    digest() {
      return lane(this.h1a, this.h2a) + lane(this.h1b, this.h2b);
    }
  };
  function lane(h1in, h2in) {
    let h1 = Math.imul(h1in ^ h1in >>> 16, 2246822507);
    h1 ^= Math.imul(h2in ^ h2in >>> 13, 3266489909);
    let h2 = Math.imul(h2in ^ h2in >>> 16, 2246822507);
    h2 ^= Math.imul(h1 ^ h1 >>> 13, 3266489909);
    const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return value.toString(16).padStart(14, "0");
  }

  // src/sim/program/pwl.ts
  function pieceCount(pieces) {
    return pieces.t.length - 1;
  }
  function mergeAxes(axes, ta, tb) {
    if (!(tb > ta)) {
      return { t: Float64Array.of(ta, ta), ga: new Float64Array(3), gb: new Float64Array(3) };
    }
    const cuts = [ta];
    for (const axis of axes) {
      for (let i = 0; i < axis.times.length; i++) {
        const time = axis.times[i];
        if (time > ta && time < tb) cuts.push(time);
      }
    }
    cuts.push(tb);
    cuts.sort((a, b) => a - b);
    const boundaries = [];
    for (const time of cuts) {
      if (!boundaries.length || time > boundaries[boundaries.length - 1]) boundaries.push(time);
    }
    const n = boundaries.length - 1;
    const t = Float64Array.from(boundaries);
    const ga = new Float64Array(3 * n);
    const gb = new Float64Array(3 * n);
    for (let axis = 0; axis < 3; axis++) {
      const { times, values } = axes[axis];
      let segment = 0;
      for (let piece = 0; piece < n; piece++) {
        const u = t[piece], v = t[piece + 1];
        while (segment + 1 < times.length - 1 && times[segment + 1] <= u) segment++;
        ga[3 * piece + axis] = interpolateWithin(times, values, segment, u);
        gb[3 * piece + axis] = interpolateWithin(times, values, segment, v);
      }
    }
    return { t, ga, gb };
  }
  function interpolateWithin(times, values, segment, time) {
    if (times.length === 0) return 0;
    if (times.length === 1) return values[0];
    const t0 = times[segment], t1 = times[segment + 1];
    const v0 = values[segment], v1 = values[segment + 1];
    if (!(t1 > t0)) return v1;
    return v0 + (v1 - v0) * (time - t0) / (t1 - t0);
  }
  function piecesMoments(pieces) {
    const dk = new Float64Array(3);
    const kIntegral = new Float64Array(3);
    const kSecond = new Float64Array(6);
    const n = pieceCount(pieces);
    for (let piece = 0; piece < n; piece++) {
      const h = pieces.t[piece + 1] - pieces.t[piece];
      if (!(h > 0)) continue;
      const o = 3 * piece;
      const ax = dk[0], ay = dk[1], az = dk[2];
      const bx = pieces.ga[o], by = pieces.ga[o + 1], bz = pieces.ga[o + 2];
      const cx = 0.5 * (pieces.gb[o] - bx) / h;
      const cy = 0.5 * (pieces.gb[o + 1] - by) / h;
      const cz = 0.5 * (pieces.gb[o + 2] - bz) / h;
      kIntegral[0] += quadInt(ax, bx, cx, h);
      kIntegral[1] += quadInt(ay, by, cy, h);
      kIntegral[2] += quadInt(az, bz, cz, h);
      kSecond[0] += quadProd(ax, bx, cx, ax, bx, cx, h);
      kSecond[1] += quadProd(ay, by, cy, ay, by, cy, h);
      kSecond[2] += quadProd(az, bz, cz, az, bz, cz, h);
      kSecond[3] += quadProd(ax, bx, cx, ay, by, cy, h);
      kSecond[4] += quadProd(ax, bx, cx, az, bz, cz, h);
      kSecond[5] += quadProd(ay, by, cy, az, bz, cz, h);
      dk[0] += h * (bx + cx * h);
      dk[1] += h * (by + cy * h);
      dk[2] += h * (bz + cz * h);
    }
    return { dk, kIntegral, kSecond };
  }
  function piecesKAt(pieces, times, out) {
    const n = pieceCount(pieces);
    let piece = 0;
    let kx = 0, ky = 0, kz = 0;
    for (let s = 0; s < times.length; s++) {
      const time = times[s];
      while (piece < n - 1 && pieces.t[piece + 1] <= time) {
        const h2 = pieces.t[piece + 1] - pieces.t[piece];
        const o2 = 3 * piece;
        kx += 0.5 * h2 * (pieces.ga[o2] + pieces.gb[o2]);
        ky += 0.5 * h2 * (pieces.ga[o2 + 1] + pieces.gb[o2 + 1]);
        kz += 0.5 * h2 * (pieces.ga[o2 + 2] + pieces.gb[o2 + 2]);
        piece++;
      }
      const h = pieces.t[piece + 1] - pieces.t[piece];
      const tau = Math.min(Math.max(time - pieces.t[piece], 0), h);
      const o = 3 * piece;
      if (h > 0) {
        const fx = (pieces.gb[o] - pieces.ga[o]) / h;
        const fy = (pieces.gb[o + 1] - pieces.ga[o + 1]) / h;
        const fz = (pieces.gb[o + 2] - pieces.ga[o + 2]) / h;
        out[3 * s] = kx + tau * (pieces.ga[o] + 0.5 * fx * tau);
        out[3 * s + 1] = ky + tau * (pieces.ga[o + 1] + 0.5 * fy * tau);
        out[3 * s + 2] = kz + tau * (pieces.ga[o + 2] + 0.5 * fz * tau);
      } else {
        out[3 * s] = kx;
        out[3 * s + 1] = ky;
        out[3 * s + 2] = kz;
      }
    }
  }
  function addPiecesIntegral(pieces, a, b, out) {
    const n = pieceCount(pieces);
    for (let piece = 0; piece < n; piece++) {
      const u = Math.max(a, pieces.t[piece]);
      const v = Math.min(b, pieces.t[piece + 1]);
      if (!(v > u)) continue;
      const h = pieces.t[piece + 1] - pieces.t[piece];
      const o = 3 * piece;
      for (let axis = 0; axis < 3; axis++) {
        const g0 = pieces.ga[o + axis];
        const slope = (pieces.gb[o + axis] - g0) / h;
        const gu = g0 + slope * (u - pieces.t[piece]);
        const gv = g0 + slope * (v - pieces.t[piece]);
        out[axis] += 0.5 * (gu + gv) * (v - u);
      }
    }
  }
  function quadInt(a, b, c, h) {
    return h * (a + h * (b / 2 + h * c / 3));
  }
  function quadProd(a1, b1, c1, a2, b2, c2, h) {
    const p0 = a1 * a2;
    const p1 = a1 * b2 + b1 * a2;
    const p2 = a1 * c2 + c1 * a2 + b1 * b2;
    const p3 = b1 * c2 + c1 * b2;
    const p4 = c1 * c2;
    return h * (p0 + h * (p1 / 2 + h * (p2 / 3 + h * (p3 / 4 + h * p4 / 5))));
  }
  var RELATIVE_TIME_QUANTUM_SEC = 1e-12;
  function relativePieces(pieces, t0) {
    const t = new Float64Array(pieces.t.length);
    for (let i = 0; i < t.length; i++) {
      t[i] = Math.round((pieces.t[i] - t0) / RELATIVE_TIME_QUANTUM_SEC) * RELATIVE_TIME_QUANTUM_SEC;
    }
    return { t, ga: pieces.ga.slice(), gb: pieces.gb.slice() };
  }

  // src/sim/program/compile.ts
  var EVENT_TIME_TOLERANCE_SEC = 1e-9;
  var KEY_TIME_QUANTUM_SEC = 1e-10;
  var KEY_GRADIENT_QUANTUM = 1e6;
  function compileProgram(seq, options = {}) {
    const b0 = options.b0 ?? fileB0(seq) ?? DEFAULT_B0_T;
    const gamma = options.gamma ?? PULSEQ_GAMMA_HZ_PER_T;
    const blockStartTimes = computeBlockStartTimes(seq, options);
    const blockCount = seq.blocks.length;
    const totalDuration = blockStartTimes[blockCount];
    const rfOperators = /* @__PURE__ */ new Map();
    const ignoredFeatures = /* @__PURE__ */ new Set();
    return {
      sequence: seq,
      blockCount,
      blockStartTimes,
      totalDuration,
      b0,
      gamma,
      rfOperators,
      ignoredFeatures,
      segments: () => streamSegments(seq, {
        b0,
        gamma,
        blockStartTimes,
        totalDuration,
        rfOperators,
        ignoredFeatures
      })
    };
  }
  function* streamSegments(seq, ctx) {
    const n = seq.blocks.length;
    const raster = seq.rasterTimes.gradientRaster;
    const decodeContext = programDecodeContext(seq, ctx.blockStartTimes);
    const nextPieceBlock = computeNextPieceBlocks(seq);
    const builder = new GradientTimelineBuilder(raster, void 0, false);
    const readers = builder.axes.map((axis) => new AxisWindowReader(axis));
    const queue = [];
    let next = 0;
    let finished = false;
    let adcIndex = 0;
    const nextPieceTimes = new Float64Array(3);
    for (let emit = 0; emit < n; emit++) {
      const blockEnd = ctx.blockStartTimes[emit + 1];
      for (; ; ) {
        if (next >= n) {
          if (!finished) {
            builder.finish(ctx.totalDuration);
            finished = true;
          }
          break;
        }
        if (next > emit) {
          for (let axis = 0; axis < 3; axis++) {
            const block = nextPieceBlock[axis][next];
            nextPieceTimes[axis] = block < n ? ctx.blockStartTimes[block] : Number.POSITIVE_INFINITY;
          }
          if (builder.finalThrough(nextPieceTimes) >= blockEnd) break;
        }
        const [decoded2] = decodeBlockRange(seq, next, next + 1, decodeContext);
        builder.append(decoded2);
        queue.push(decoded2);
        next++;
      }
      const decoded = queue.shift();
      const blockStart = ctx.blockStartTimes[emit];
      noteIgnoredFeatures(decoded, ctx.ignoredFeatures);
      const events = [];
      if (decoded.rf) {
        const rfEntry = seq.rfs.get(seq.blocks[emit].rfId);
        const timing = rfTiming(seq, rfEntry, blockStart);
        events.push({
          start: timing.start,
          end: timing.end,
          build: () => buildRfSegment(seq, ctx, readers, decoded, rfEntry, timing, emit)
        });
      }
      const adcEntry = seq.blocks[emit].adcId > 0 ? seq.adcs.get(seq.blocks[emit].adcId) : void 0;
      if (decoded.adc && adcEntry) {
        const start = blockStart + adcEntry.delay * 1e-6;
        const end = start + adcEntry.numSamples * adcEntry.dwell * 1e-9;
        const ordinal = adcIndex++;
        events.push({
          start,
          end,
          build: () => buildAdcSegment(seq, ctx, readers, adcEntry, start, end, emit, ordinal)
        });
      }
      events.sort((a, b) => a.start - b.start);
      for (const event of events) {
        if (event.start < blockStart - EVENT_TIME_TOLERANCE_SEC || event.end > blockEnd + EVENT_TIME_TOLERANCE_SEC) {
          throw new Error(`Block ${emit + 1}: an event extends outside the block.`);
        }
        event.start = Math.max(event.start, blockStart);
        event.end = Math.min(event.end, blockEnd);
      }
      if (events.length === 2 && events[1].start < events[0].end - EVENT_TIME_TOLERANCE_SEC) {
        throw new Error(`Block ${emit + 1}: RF and ADC overlap, which the simulator does not support yet.`);
      }
      let cursor = blockStart;
      for (const event of events) {
        if (event.start > cursor) yield buildFreeSegment(readers, cursor, event.start, emit);
        yield event.build();
        cursor = Math.max(cursor, event.end);
      }
      if (blockEnd > cursor) yield buildFreeSegment(readers, cursor, blockEnd, emit);
      for (const reader of readers) reader.release();
    }
  }
  function windowPieces(readers, t0, t1) {
    return mergeAxes(
      [readers[0].points(t0, t1), readers[1].points(t0, t1), readers[2].points(t0, t1)],
      t0,
      t1
    );
  }
  function buildFreeSegment(readers, t0, t1, blockIndex) {
    return { kind: "free", blockIndex, t0, t1, moments: piecesMoments(windowPieces(readers, t0, t1)) };
  }
  function rfTiming(seq, rf, blockStart) {
    const raster = seq.rasterTimes.rfRaster;
    const pulseStart = blockStart + rf.delay * 1e-6;
    const waveform = rfShapeArrays(rf, seq) ?? { raster, magnitude: Float64Array.of(1), phaseCycles: null, timeShape: null };
    const rawTime = rf.timeShapeId > 0 ? seq.shapes.get(rf.timeShapeId)?.samples : void 0;
    const ptxChannels = rawTime ? detectPtxTimeShapeChannels(rawTime) : 0;
    const first = waveform.timeShape?.length ? waveform.timeShape[0] * raster : 0;
    return {
      start: pulseStart + first,
      end: pulseStart + rfShapeDuration(waveform),
      waveform,
      ptxChannels
    };
  }
  function buildRfSegment(seq, ctx, readers, decoded, rf, timing, blockIndex) {
    const t0 = timing.start;
    const t1 = timing.end;
    const gradient = windowPieces(readers, t0, t1);
    const freqOffset = rf.freqOffset + rf.freqPPM * 1e-6 * ctx.gamma * ctx.b0;
    const phaseOffset = rf.phaseOffset + rf.phasePPM * 1e-6 * ctx.gamma * ctx.b0;
    const shim = decoded.rfShim ? { amplitudes: [...decoded.rfShim.amplitudes], phases: [...decoded.rfShim.phases] } : null;
    let key = rfBaseKey(seq, rf, freqOffset, shim, blockIndex);
    let operator = ctx.rfOperators.get(key);
    if (operator && !sameGradient(operator.gradient, gradient, t0)) {
      key = `${key}:${gradientContentHash(gradient, t0)}`;
      operator = ctx.rfOperators.get(key);
    }
    if (!operator) {
      operator = {
        key,
        rf,
        amplitude: rf.amplitude,
        waveform: timing.waveform,
        freqOffset,
        duration: t1 - t0,
        gradient: relativePieces(gradient, t0),
        shim,
        ptxChannels: timing.ptxChannels
      };
      ctx.rfOperators.set(key, operator);
    }
    if (timing.ptxChannels > 1) ctx.ignoredFeatures.add("dynamic-ptx-rf");
    const centerTime = decoded.rf.centerTime;
    const kToCenter = new Float64Array(3);
    addPiecesIntegral(gradient, t0, Math.min(Math.max(centerTime, t0), t1), kToCenter);
    return {
      kind: "rf",
      blockIndex,
      t0,
      t1,
      moments: piecesMoments(gradient),
      key,
      operator,
      phaseOffset,
      use: decoded.rf.use,
      centerTime,
      kToCenter,
      gradient
    };
  }
  function buildAdcSegment(seq, ctx, readers, adc, t0, t1, blockIndex, adcIndex) {
    const gradient = windowPieces(readers, t0, t1);
    let activeAxes = 0;
    for (let i = 0; i < gradient.ga.length; i++) {
      if (gradient.ga[i] !== 0 || gradient.gb[i] !== 0) activeAxes |= 1 << i % 3;
    }
    const modulation = adc.phaseModShapeId > 0 ? seq.shapes.get(adc.phaseModShapeId)?.samples ?? null : null;
    return {
      kind: "adc",
      blockIndex,
      t0,
      t1,
      moments: piecesMoments(gradient),
      adcIndex,
      numSamples: adc.numSamples,
      dwell: adc.dwell * 1e-9,
      phaseOffset: adc.phaseOffset + adc.phasePPM * 1e-6 * ctx.gamma * ctx.b0,
      freqOffset: adc.freqOffset + adc.freqPPM * 1e-6 * ctx.gamma * ctx.b0,
      phaseModulation: modulation,
      gradient,
      activeAxes
    };
  }
  function adcSampleTimes(segment) {
    const times = new Float64Array(segment.numSamples);
    for (let s = 0; s < segment.numSamples; s++) times[s] = segment.t0 + (s + 0.5) * segment.dwell;
    return times;
  }
  function rfBaseKey(seq, rf, freqOffset, shim, blockIndex) {
    const hasher = new ContentHasher().number(rf.magShapeId).number(rf.phaseShapeId).number(rf.timeShapeId).number(rf.amplitude).number(rf.delay).number(freqOffset).number(seq.rasterTimes.rfRaster);
    if (shim) hasher.word(1).numbers(shim.amplitudes).numbers(shim.phases);
    else hasher.word(0);
    const block = seq.blocks[blockIndex];
    for (const id of [block.gxId, block.gyId, block.gzId]) {
      const trap = id > 0 ? seq.trapGrads.get(id) : void 0;
      const arb = id > 0 && !trap ? seq.arbitraryGrads.get(id) : void 0;
      if (trap) {
        hasher.word(1).number(trap.amplitude).number(trap.rise).number(trap.flat).number(trap.fall).number(trap.delay);
      } else if (arb) {
        hasher.word(2).number(arb.amplitude).number(arb.shapeId).number(arb.timeId).number(arb.delay).number(arb.first).number(arb.last);
      } else {
        hasher.word(0);
      }
    }
    const rotation = blockRotation(seq, block.extId);
    if (rotation) hasher.word(1).numbers(rotation);
    else hasher.word(0);
    return hasher.digest();
  }
  function sameGradient(stored, event, t0) {
    const storedEnd = stored.t[stored.t.length - 1];
    const eventEnd = event.t[event.t.length - 1] - t0;
    if (Math.abs(storedEnd - eventEnd) > KEY_TIME_QUANTUM_SEC) return false;
    const cuts = [];
    for (let i = 0; i < stored.t.length; i++) cuts.push(stored.t[i]);
    for (let i = 0; i < event.t.length; i++) cuts.push(event.t[i] - t0);
    cuts.sort((a2, b2) => a2 - b2);
    let peak = 0;
    for (const values of [stored.ga, stored.gb, event.ga, event.gb]) {
      for (let i = 0; i < values.length; i++) peak = Math.max(peak, Math.abs(values[i]));
    }
    const tolerance = 1e-6 + 1e-9 * peak;
    const a = new Float64Array(3), b = new Float64Array(3);
    for (let i = 1; i < cuts.length; i++) {
      const span = cuts[i] - cuts[i - 1];
      if (!(span > KEY_TIME_QUANTUM_SEC)) continue;
      for (const fraction of [1 / 3, 2 / 3]) {
        const time = cuts[i - 1] + fraction * span;
        evaluatePieces(stored, time, a);
        evaluatePieces(event, time + t0, b);
        for (let axis = 0; axis < 3; axis++) {
          if (Math.abs(a[axis] - b[axis]) > tolerance) return false;
        }
      }
    }
    return true;
  }
  function evaluatePieces(pieces, time, out) {
    const n = pieceCount(pieces);
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (pieces.t[mid] <= time) lo = mid;
      else hi = mid - 1;
    }
    const h = pieces.t[lo + 1] - pieces.t[lo];
    const fraction = h > 0 ? Math.min(Math.max((time - pieces.t[lo]) / h, 0), 1) : 0;
    for (let axis = 0; axis < 3; axis++) {
      const ga = pieces.ga[3 * lo + axis];
      out[axis] = ga + (pieces.gb[3 * lo + axis] - ga) * fraction;
    }
  }
  function gradientContentHash(gradient, t0) {
    const hasher = new ContentHasher();
    const n = pieceCount(gradient);
    for (let i = 0; i < n; i++) {
      if (!(gradient.t[i + 1] - gradient.t[i] > KEY_TIME_QUANTUM_SEC)) continue;
      hasher.number(Math.round((gradient.t[i] - t0) / KEY_TIME_QUANTUM_SEC));
      hasher.number(Math.round((gradient.t[i + 1] - t0) / KEY_TIME_QUANTUM_SEC));
      for (let axis = 0; axis < 3; axis++) {
        hasher.number(Math.round(gradient.ga[3 * i + axis] * KEY_GRADIENT_QUANTUM));
        hasher.number(Math.round(gradient.gb[3 * i + axis] * KEY_GRADIENT_QUANTUM));
      }
    }
    return hasher.digest();
  }
  function blockRotation(seq, extId) {
    for (const ext of extensionChain(seq, extId)) {
      if (seq.extensionTypes.get(ext.type) !== 2 /* EXT_ROTATION */) continue;
      return seq.rotations.find((rotation) => rotation.id === ext.ref)?.values;
    }
    return void 0;
  }
  function noteIgnoredFeatures(block, ignored) {
    if (block.triggers?.length) ignored.add("trigger");
    if (block.nco?.length) ignored.add("nco");
  }
  function fileB0(seq) {
    for (const name of ["B0", "b0", "b_0"]) {
      const value = seq.definitions.get(name);
      if (value?.length && Number.isFinite(value[0])) return +value[0];
    }
    return void 0;
  }
  function computeBlockStartTimes(seq, options) {
    const legacy = seq.versionCombined < VER_PRE_14;
    const tick = legacy ? 1e-6 : seq.rasterTimes.blockDurationRaster;
    const softDelays = options.softDelayInputs ? softDelayDurations(seq, options, tick) : null;
    const starts = new Float64Array(seq.blocks.length + 1);
    let ticks = 0;
    for (let i = 0; i < seq.blocks.length; i++) {
      starts[i] = ticks * tick;
      ticks += softDelays?.get(i) ?? seq.blocks[i].dur;
    }
    starts[seq.blocks.length] = ticks * tick;
    return starts;
  }
  function softDelayDurations(seq, options, tick) {
    const inputs = options.softDelayInputs ?? {};
    const round = options.roundSoftDelays ?? true;
    const specs = new Map(seq.softDelays.map((spec) => [spec.id, spec]));
    const durations = /* @__PURE__ */ new Map();
    seq.blocks.forEach((block, index) => {
      for (const ext of extensionChain(seq, block.extId)) {
        if (seq.extensionTypes.get(ext.type) !== 5 /* EXT_DELAY */) continue;
        const spec = specs.get(ext.ref);
        if (!spec || !Object.prototype.hasOwnProperty.call(inputs, spec.numId)) continue;
        const seconds = inputs[spec.numId] / spec.factor + spec.offset * 1e-6;
        if (!(seconds >= 0)) {
          throw new Error(`Soft delay ${spec.numId} (${spec.hint}) gives a negative block duration.`);
        }
        durations.set(index, round ? Math.round(seconds / tick) : seconds / tick);
      }
    });
    return durations;
  }
  function* extensionChain(seq, extId) {
    const visited = /* @__PURE__ */ new Set();
    let current = extId > 0 ? seq.extensions.get(extId) : void 0;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      yield current;
      current = current.nextId > 0 ? seq.extensions.get(current.nextId) : void 0;
    }
  }
  function programDecodeContext(seq, blockStartTimes) {
    return { ...createSequenceDecodeContext(seq), blockStartTimes };
  }
  function computeNextPieceBlocks(seq) {
    const n = seq.blocks.length;
    const next = [new Int32Array(n + 1), new Int32Array(n + 1), new Int32Array(n + 1)];
    for (let axis = 0; axis < 3; axis++) next[axis][n] = n;
    const exists = (id) => id > 0 && (seq.trapGrads.has(id) || seq.arbitraryGrads.has(id));
    for (let i = n - 1; i >= 0; i--) {
      const block = seq.blocks[i];
      const logical = [exists(block.gxId), exists(block.gyId), exists(block.gzId)];
      const rotated = logical.some(Boolean) && hasRotation(seq, block.extId);
      for (let axis = 0; axis < 3; axis++) {
        next[axis][i] = rotated || logical[axis] ? i : next[axis][i + 1];
      }
    }
    return next;
  }
  function hasRotation(seq, extId) {
    return blockRotation(seq, extId) !== void 0;
  }
  var AxisWindowReader = class {
    // last emitted point at or before the latest window start
    constructor(axis) {
      __publicField(this, "axis", axis);
      __publicField(this, "index", 0);
    }
    points(ta, tb) {
      const { times, values } = this.axis;
      const n = times.length;
      const outTimes = [];
      const outValues = [];
      if (n === 0) {
        outTimes.push(ta, tb);
        outValues.push(0, 0);
        return { times: outTimes, values: outValues };
      }
      while (this.index + 1 < n && times.get(this.index + 1) <= ta) this.index++;
      if (times.get(this.index) > ta) {
        outTimes.push(ta);
        outValues.push(0);
      }
      let j = this.index;
      for (; j < n; j++) {
        const time = times.get(j);
        outTimes.push(time);
        outValues.push(values.get(j));
        if (time >= tb) break;
      }
      if (j >= n) {
        if (this.axis.hasPending) {
          const heldTime = this.axis.heldTime;
          if (heldTime > outTimes[outTimes.length - 1]) {
            outTimes.push(heldTime);
            outValues.push(this.axis.heldValue);
          }
          if (heldTime < tb) {
            if (this.axis.heldValue !== 0) throw new Error("internal: gradient tail is not final");
            outTimes.push(tb);
            outValues.push(0);
          }
        } else if (outTimes[outTimes.length - 1] < tb) {
          outTimes.push(tb);
          outValues.push(0);
        }
      }
      return { times: outTimes, values: outValues };
    }
    /** Drop storage behind the current position. */
    release() {
      this.axis.times.releaseBefore(this.index);
      this.axis.values.releaseBefore(this.index);
    }
  };

  // src/sim/engine/spins.ts
  function equilibriumState(count) {
    const mz = new Float64Array(count);
    mz.fill(1);
    return { mx: new Float64Array(count), my: new Float64Array(count), mz };
  }

  // src/sim/engine/reference.ts
  function countAdcSamples(seq) {
    let total = 0;
    for (const block of seq.blocks) {
      const adc = block.adcId > 0 ? seq.adcs.get(block.adcId) : void 0;
      if (adc) total += adc.numSamples;
    }
    return total;
  }
  var SimulationCancelledError = class extends Error {
    constructor() {
      super("The simulation was cancelled.");
      this.name = "SimulationCancelledError";
    }
  };
  function simulateReference(program, spins, options = {}) {
    const state = options.initial ?? equilibriumState(spins.count);
    const sampleCount = countAdcSamples(program.sequence);
    const members = options.members ?? null;
    if (members) checkMembers(members, spins.count);
    const coils = members ? members.coils : spins.coils;
    const signal = new Float64Array(sampleCount * coils * 2);
    const area = new Float64Array(3);
    const cache = (options.rfMode ?? "cached") === "cached" ? new RfOperatorCache(spins) : null;
    const grouper = new ReadoutGrouper(spins, (options.readout ?? "grouped") === "grouped");
    const interval = Math.max(1, options.progressInterval ?? 64);
    const free = new PendingFree();
    let sampleOffset = 0;
    let processed = 0;
    const until = options.until ?? Infinity;
    for (const segment of program.segments()) {
      if (segment.t0 >= until) break;
      if (segment.kind === "free") {
        free.add(segment.moments.dk, segment.t1 - segment.t0);
      } else if (segment.kind === "rf") {
        free.flush(spins, state);
        if (cache) cache.apply(segment, state);
        else applyRf(segment, spins, state);
      } else {
        free.flush(spins, state);
        sampleAdc(segment, spins, state, signal, sampleOffset, grouper, members, area);
        sampleOffset += segment.numSamples;
        free.add(segment.moments.dk, segment.t1 - segment.t0);
      }
      for (let a = 0; a < 3; a++) area[a] += segment.moments.dk[a];
      if (++processed % interval === 0) {
        if (options.isCancelled?.()) throw new SimulationCancelledError();
        options.onProgress?.(program.totalDuration > 0 ? segment.t1 / program.totalDuration : 1);
      }
    }
    free.flush(spins, state);
    options.onProgress?.(1);
    return { signal, sampleCount, coils, state };
  }
  function checkMembers(members, classes) {
    const points = members.foldPoints.length / 3;
    for (let m = 0; m < members.count; m++) {
      const c = members.classOf[m], p = members.foldOf[m];
      if (!(c >= 0 && c < classes)) throw new Error(`Member ${m} names class ${c} of ${classes}.`);
      if (!(p >= 0 && p < points)) throw new Error(`Member ${m} names fold point ${p} of ${points}.`);
    }
  }
  var PendingFree = class {
    constructor() {
      __publicField(this, "dk", new Float64Array(3));
      __publicField(this, "dt", 0);
      __publicField(this, "empty", true);
    }
    add(dk, dt) {
      this.dk[0] += dk[0];
      this.dk[1] += dk[1];
      this.dk[2] += dk[2];
      this.dt += dt;
      this.empty = false;
    }
    flush(spins, state) {
      if (this.empty) return;
      applyFreeInterval(this.dk, this.dt, spins, state);
      this.dk.fill(0);
      this.dt = 0;
      this.empty = true;
    }
  };
  function applyFreeInterval(dk, dt, spins, state) {
    const { mx, my, mz } = state;
    const twoPi = 2 * Math.PI;
    for (let i = 0; i < spins.count; i++) {
      const cycles = dk[0] * spins.x[i] + dk[1] * spins.y[i] + dk[2] * spins.z[i] + spins.df[i] * dt;
      const angle = twoPi * (cycles - Math.round(cycles));
      const e2 = Math.exp(-dt * spins.r2[i]);
      const e1 = Math.exp(-dt * spins.r1[i]);
      const c = Math.cos(angle) * e2, s = Math.sin(angle) * e2;
      const x = mx[i], y = my[i];
      mx[i] = x * c - y * s;
      my[i] = x * s + y * c;
      mz[i] = mz[i] * e1 + (1 - e1);
    }
  }
  function rfCells(segment, phaseOffset = segment.phaseOffset) {
    const op = segment.operator;
    if (op.ptxChannels > 1) throw new Error("Dynamic pTx RF (pTx-Pulseq layout) is not supported yet.");
    const cells = rasterCellsFromShapes(op.waveform);
    if (cells.count < 1) throw new Error("RF event without samples.");
    const starts = cells.start;
    const widths = cells.width;
    const magnitude = cells.magnitude;
    const phase = cells.phaseCycles;
    const gradient = relativePieces(segment.gradient, segment.t0);
    const count = starts.length;
    const b1Re = new Float64Array(count);
    const b1Im = new Float64Array(count);
    const grad = new Float64Array(3 * count);
    const area = new Float64Array(3);
    for (let j = 0; j < count; j++) {
      const angle = 2 * Math.PI * phase[j] + phaseOffset;
      const amplitude = op.amplitude * magnitude[j];
      b1Re[j] = amplitude * Math.cos(angle);
      b1Im[j] = amplitude * Math.sin(angle);
      area.fill(0);
      const a = starts[j] - starts[0], b = a + widths[j];
      addPiecesIntegral(gradient, a, b, area);
      for (let axis = 0; axis < 3; axis++) grad[3 * j + axis] = area[axis] / widths[j];
    }
    const freq = op.freqOffset;
    const firstStart = starts[0];
    const lastEnd = starts[count - 1] + widths[count - 1];
    return {
      count,
      width: widths,
      b1Re,
      b1Im,
      grad,
      freq,
      phaseIn: 2 * Math.PI * freq * firstStart,
      phaseOut: 2 * Math.PI * freq * lastEnd
    };
  }
  function applyRf(segment, spins, state) {
    const cells = rfCells(segment);
    for (let i = 0; i < spins.count; i++) stepRfSpin(cells, spins, i, state);
  }
  function stepRfSpin(cells, spins, i, state) {
    const out = stepRfVector(cells, spins, i, state.mx[i], state.my[i], state.mz[i]);
    state.mx[i] = out[0];
    state.my[i] = out[1];
    state.mz[i] = out[2];
  }
  function stepRfVector(cells, spins, i, x, y, z) {
    {
      const c2 = Math.cos(cells.phaseIn), s2 = Math.sin(cells.phaseIn);
      const nx = x * c2 + y * s2, ny = -x * s2 + y * c2;
      x = nx;
      y = ny;
    }
    const sx = spins.x[i], sy = spins.y[i], sz = spins.z[i];
    const offset = spins.df[i] - cells.freq;
    const r1 = spins.r1[i], r2 = spins.r2[i];
    const bRe = spins.b1Re[i], bIm = spins.b1Im[i];
    for (let j = 0; j < cells.count; j++) {
      const w = cells.width[j];
      const half = 0.5 * w;
      const e2h = Math.exp(-half * r2), e1h = Math.exp(-half * r1);
      x *= e2h;
      y *= e2h;
      z = z * e1h + (1 - e1h);
      const bx = cells.b1Re[j] * bRe - cells.b1Im[j] * bIm;
      const by = cells.b1Re[j] * bIm + cells.b1Im[j] * bRe;
      const bz = cells.grad[3 * j] * sx + cells.grad[3 * j + 1] * sy + cells.grad[3 * j + 2] * sz + offset;
      [x, y, z] = rotateCayleyKlein(x, y, z, bx, by, bz, w);
      x *= e2h;
      y *= e2h;
      z = z * e1h + (1 - e1h);
    }
    const c = Math.cos(cells.phaseOut), s = Math.sin(cells.phaseOut);
    return [x * c - y * s, x * s + y * c, z];
  }
  var RfOperatorCache = class {
    constructor(spins) {
      __publicField(this, "spins", spins);
      __publicField(this, "maps", /* @__PURE__ */ new Map());
    }
    get size() {
      return this.maps.size;
    }
    /** Bytes held by the cached maps. */
    get bytes() {
      let total = 0;
      for (const map of this.maps.values()) total += map.byteLength;
      return total;
    }
    apply(segment, state) {
      const map = this.maps.get(segment.key) ?? this.build(segment);
      const phi = segment.phaseOffset;
      const cp = Math.cos(phi), sp = Math.sin(phi);
      const { mx, my, mz } = state;
      for (let i = 0; i < this.spins.count; i++) {
        const o = 12 * i;
        const vx = mx[i] * cp + my[i] * sp;
        const vy = -mx[i] * sp + my[i] * cp;
        const vz = mz[i];
        const wx = map[o] * vx + map[o + 1] * vy + map[o + 2] * vz + map[o + 9];
        const wy = map[o + 3] * vx + map[o + 4] * vy + map[o + 5] * vz + map[o + 10];
        const wz = map[o + 6] * vx + map[o + 7] * vy + map[o + 8] * vz + map[o + 11];
        mx[i] = wx * cp - wy * sp;
        my[i] = wx * sp + wy * cp;
        mz[i] = wz;
      }
    }
    build(segment) {
      const cells = rfCells(segment, 0);
      const spins = this.spins;
      const map = new Float64Array(12 * spins.count);
      const active = [false, false, false];
      for (let j = 0; j < cells.count; j++) {
        for (let axis = 0; axis < 3; axis++) if (cells.grad[3 * j + axis] !== 0) active[axis] = true;
      }
      const coordinates = [spins.x, spins.y, spins.z];
      const built = /* @__PURE__ */ new Map();
      for (let i = 0; i < spins.count; i++) {
        let signature = `${spins.df[i]}|${spins.r1[i]}|${spins.r2[i]}|${spins.b1Re[i]}|${spins.b1Im[i]}`;
        for (let axis = 0; axis < 3; axis++) if (active[axis]) signature += `|${coordinates[axis][i]}`;
        const twin = built.get(signature);
        if (twin !== void 0) {
          map.copyWithin(12 * i, 12 * twin, 12 * twin + 12);
          continue;
        }
        built.set(signature, i);
        const c = stepRfVector(cells, spins, i, 0, 0, 0);
        const ex = stepRfVector(cells, spins, i, 1, 0, 0);
        const ey = stepRfVector(cells, spins, i, 0, 1, 0);
        const ez = stepRfVector(cells, spins, i, 0, 0, 1);
        const o = 12 * i;
        for (let row = 0; row < 3; row++) {
          map[o + 3 * row] = ex[row] - c[row];
          map[o + 3 * row + 1] = ey[row] - c[row];
          map[o + 3 * row + 2] = ez[row] - c[row];
          map[o + 9 + row] = c[row];
        }
      }
      this.maps.set(segment.key, map);
      return map;
    }
  };
  function sinc(x) {
    const px = Math.PI * x;
    if (Math.abs(px) < 1e-4) return 1 - px * px / 6;
    return Math.sin(px) / px;
  }
  function rotateCayleyKlein(x, y, z, bx, by, bz, w) {
    const magnitude = Math.sqrt(bx * bx + by * by + bz * bz);
    const sc = Math.PI * w * sinc(magnitude * w);
    const aRe = Math.cos(Math.PI * magnitude * w);
    const aIm = -bz * sc;
    const bRe = sc * by;
    const bIm = -sc * bx;
    const a2Re = aRe * aRe - aIm * aIm;
    const a2Im = -2 * aRe * aIm;
    const b2Re = bRe * bRe - bIm * bIm;
    const b2Im = 2 * bRe * bIm;
    const abRe = aRe * bRe + aIm * bIm;
    const abIm = aRe * bIm - aIm * bRe;
    const nx = a2Re * x - a2Im * y - (b2Re * x + b2Im * y) + 2 * abRe * z;
    const ny = a2Re * y + a2Im * x - (b2Im * x - b2Re * y) + 2 * abIm * z;
    const pRe = aRe * bRe - aIm * bIm;
    const pIm = aRe * bIm + aIm * bRe;
    const nz = -2 * (pRe * x + pIm * y) + (aRe * aRe + aIm * aIm - bRe * bRe - bIm * bIm) * z;
    return [nx, ny, nz];
  }
  var ReadoutGrouper = class {
    constructor(spins, enabled = true) {
      __publicField(this, "spins", spins);
      __publicField(this, "enabled", enabled);
      __publicField(this, "byMask", /* @__PURE__ */ new Map());
    }
    groups(activeAxes) {
      const mask = this.enabled ? activeAxes & 7 : -1;
      let groups = this.byMask.get(mask);
      if (!groups) {
        groups = this.build(mask);
        this.byMask.set(mask, groups);
      }
      return groups;
    }
    build(mask) {
      const spins = this.spins;
      const groupOf = new Int32Array(spins.count);
      const index = /* @__PURE__ */ new Map();
      const x = [], y = [], z = [], df = [], r2 = [];
      for (let i = 0; i < spins.count; i++) {
        const gx = mask < 0 || mask & 1 ? spins.x[i] : 0;
        const gy = mask < 0 || mask & 2 ? spins.y[i] : 0;
        const gz = mask < 0 || mask & 4 ? spins.z[i] : 0;
        let group;
        if (mask >= 0) {
          const signature = `${gx}|${gy}|${gz}|${spins.df[i]}|${spins.r2[i]}`;
          group = index.get(signature);
          if (group === void 0) {
            group = x.length;
            index.set(signature, group);
          }
        } else {
          group = x.length;
        }
        if (group === x.length) {
          x.push(gx);
          y.push(gy);
          z.push(gz);
          df.push(spins.df[i]);
          r2.push(spins.r2[i]);
        }
        groupOf[i] = group;
      }
      return {
        count: x.length,
        groupOf,
        x: Float64Array.from(x),
        y: Float64Array.from(y),
        z: Float64Array.from(z),
        df: Float64Array.from(df),
        r2: Float64Array.from(r2)
      };
    }
  };
  function sumSpins(spins, groups, state, gRe, gIm) {
    const coils = spins.coils;
    let any = false;
    for (let i = 0; i < spins.count; i++) {
      const mx = state.mx[i], my = state.my[i];
      if (mx === 0 && my === 0) continue;
      any = true;
      const w = spins.weight[i];
      const g = groups.groupOf[i];
      for (let c = 0; c < coils; c++) {
        const rr = spins.rxRe[c * spins.count + i];
        const ri = -spins.rxIm[c * spins.count + i];
        gRe[g * coils + c] += w * (rr * mx - ri * my);
        gIm[g * coils + c] += w * (rr * my + ri * mx);
      }
    }
    return any;
  }
  function sumMembers(members, groups, state, area, gRe, gIm) {
    const coils = members.coils;
    const points = members.foldPoints;
    const pointCount = points.length / 3;
    const pRe = new Float64Array(pointCount), pIm = new Float64Array(pointCount);
    for (let p = 0; p < pointCount; p++) {
      const cycles = area[0] * points[3 * p] + area[1] * points[3 * p + 1] + area[2] * points[3 * p + 2];
      const angle = 2 * Math.PI * (cycles - Math.round(cycles));
      pRe[p] = Math.cos(angle);
      pIm[p] = Math.sin(angle);
    }
    let any = false;
    for (let m = 0; m < members.count; m++) {
      const k = members.classOf[m];
      const cx = state.mx[k], cy = state.my[k];
      if (cx === 0 && cy === 0) continue;
      any = true;
      const p = members.foldOf[m];
      const mx = cx * pRe[p] - cy * pIm[p];
      const my = cx * pIm[p] + cy * pRe[p];
      const w = members.weight[m];
      const g = groups.groupOf[k];
      for (let c = 0; c < coils; c++) {
        const rr = members.rxRe[c * members.count + m];
        const ri = -members.rxIm[c * members.count + m];
        gRe[g * coils + c] += w * (rr * mx - ri * my);
        gIm[g * coils + c] += w * (rr * my + ri * mx);
      }
    }
    return any;
  }
  var RECURRENCE_ANCHOR = 64;
  function sampleAdc(segment, spins, state, signal, sampleOffset, grouper, members, area) {
    const n = segment.numSamples;
    const coils = members ? members.coils : spins.coils;
    const times = adcSampleTimes(segment);
    const k = new Float64Array(3 * n);
    piecesKAt(segment.gradient, times, k);
    const groups = grouper.groups(segment.activeAxes);
    const gRe = new Float64Array(groups.count * coils);
    const gIm = new Float64Array(groups.count * coils);
    const any = members ? sumMembers(members, groups, state, area, gRe, gIm) : sumSpins(spins, groups, state, gRe, gIm);
    const sumRe = new Float64Array(n * coils);
    const sumIm = new Float64Array(n * coils);
    if (any) {
      let uniform = n > 1;
      for (let s = 2; s < n && uniform; s++) {
        for (let a = 0; a < 3; a++) {
          const first = k[3 + a] - k[a];
          const step = k[3 * s + a] - k[3 * (s - 1) + a];
          if (Math.abs(step - first) > 1e-9 * Math.max(1, Math.abs(first))) uniform = false;
        }
      }
      const twoPi = 2 * Math.PI;
      const dwell = segment.dwell;
      for (let g = 0; g < groups.count; g++) {
        let nonzero = false;
        for (let c = 0; c < coils; c++) if (gRe[g * coils + c] !== 0 || gIm[g * coils + c] !== 0) nonzero = true;
        if (!nonzero) continue;
        const x = groups.x[g], y = groups.y[g], z = groups.z[g], df = groups.df[g], r2 = groups.r2[g];
        const exact = (s) => {
          const tau = times[s] - segment.t0;
          const cycles = k[3 * s] * x + k[3 * s + 1] * y + k[3 * s + 2] * z + df * tau;
          const angle = twoPi * (cycles - Math.round(cycles));
          const decay = Math.exp(-tau * r2);
          return [Math.cos(angle) * decay, Math.sin(angle) * decay];
        };
        let stepRe = 0, stepIm = 0;
        if (uniform) {
          const cycles = (k[3] - k[0]) * x + (k[4] - k[1]) * y + (k[5] - k[2]) * z + df * dwell;
          const angle = twoPi * (cycles - Math.round(cycles));
          const decay = Math.exp(-dwell * r2);
          stepRe = Math.cos(angle) * decay;
          stepIm = Math.sin(angle) * decay;
        }
        let pRe = 0, pIm = 0;
        for (let s = 0; s < n; s++) {
          if (!uniform || s % RECURRENCE_ANCHOR === 0) {
            [pRe, pIm] = exact(s);
          } else {
            const nr = pRe * stepRe - pIm * stepIm;
            pIm = pRe * stepIm + pIm * stepRe;
            pRe = nr;
          }
          for (let c = 0; c < coils; c++) {
            const ar = gRe[g * coils + c], ai = gIm[g * coils + c];
            sumRe[s * coils + c] += ar * pRe - ai * pIm;
            sumIm[s * coils + c] += ar * pIm + ai * pRe;
          }
        }
      }
    }
    for (let s = 0; s < n; s++) {
      const phase = demodulationPhase(segment.phaseOffset, segment.freqOffset, segment.dwell, s, segment.phaseModulation);
      const c = Math.cos(phase), sn = Math.sin(phase);
      for (let coil = 0; coil < coils; coil++) {
        const re = sumRe[s * coils + coil], im = sumIm[s * coils + coil];
        const dRe = re * c + im * sn;
        const dIm = im * c - re * sn;
        const out = ((sampleOffset + s) * coils + coil) * 2;
        signal[out] = dRe;
        signal[out + 1] = -dIm;
      }
    }
  }

  // src/sim/phantom/builtin.ts
  var TISSUES = {
    skin: { name: "skin", pd: 0.9, t1: 0.25, t2: 0.07 },
    whiteMatter: { name: "white matter", pd: 0.69, t1: 0.83, t2: 0.08 },
    greyMatter: { name: "grey matter", pd: 0.8, t1: 1.33, t2: 0.11 },
    csf: { name: "CSF", pd: 1, t1: 4, t2: 2 },
    lesion: { name: "lesion", pd: 0.85, t1: 1.6, t2: 0.25 }
  };
  var SHEPP_LOGAN = [
    { a: 0.69, b: 0.92, x0: 0, y0: 0, deg: 0, tissue: TISSUES.skin },
    { a: 0.6624, b: 0.874, x0: 0, y0: -0.0184, deg: 0, tissue: TISSUES.whiteMatter },
    { a: 0.11, b: 0.31, x0: 0.22, y0: 0, deg: -18, tissue: TISSUES.csf },
    { a: 0.16, b: 0.41, x0: -0.22, y0: 0, deg: 18, tissue: TISSUES.csf },
    { a: 0.21, b: 0.25, x0: 0, y0: 0.35, deg: 0, tissue: TISSUES.greyMatter },
    { a: 0.046, b: 0.046, x0: 0, y0: 0.1, deg: 0, tissue: TISSUES.greyMatter },
    { a: 0.046, b: 0.046, x0: 0, y0: -0.1, deg: 0, tissue: TISSUES.greyMatter },
    { a: 0.046, b: 0.023, x0: -0.08, y0: -0.605, deg: 0, tissue: TISSUES.lesion },
    { a: 0.023, b: 0.023, x0: 0, y0: -0.606, deg: 0, tissue: TISSUES.lesion },
    { a: 0.023, b: 0.046, x0: 0.06, y0: -0.605, deg: 0, tissue: TISSUES.lesion }
  ];
  function sheppLoganPhantom(n, fovX, fovY) {
    if (!(n >= 2) || !Number.isInteger(n)) throw new Error(`phantom size must be an integer \u2265 2, got ${n}`);
    const size = n * n;
    const grid = {
      nx: n,
      ny: n,
      fovX,
      fovY,
      pd: new Float32Array(size),
      t1: new Float32Array(size).fill(Infinity),
      t2: new Float32Array(size).fill(Infinity)
    };
    for (let iy = 0; iy < n; iy++) {
      const v = 2 * (n / 2 - 1 - iy) / n;
      for (let ix = 0; ix < n; ix++) {
        const u = 2 * (ix - n / 2) / n;
        let tissue = null;
        for (const e of SHEPP_LOGAN) {
          const angle = e.deg * Math.PI / 180;
          const dx = u - e.x0, dy = v - e.y0;
          const xr = dx * Math.cos(angle) + dy * Math.sin(angle);
          const yr = -dx * Math.sin(angle) + dy * Math.cos(angle);
          if ((xr / e.a) ** 2 + (yr / e.b) ** 2 <= 1) tissue = e.tissue;
        }
        if (!tissue) continue;
        const index = iy * n + ix;
        grid.pd[index] = tissue.pd;
        grid.t1[index] = tissue.t1;
        grid.t2[index] = tissue.t2;
      }
    }
    return grid;
  }
  function nonEmptyVoxels(grid) {
    let count = 0;
    for (let i = 0; i < grid.pd.length; i++) if (grid.pd[i] > 0) count++;
    const voxels = new Int32Array(count);
    let k = 0;
    for (let i = 0; i < grid.pd.length; i++) if (grid.pd[i] > 0) voxels[k++] = i;
    return voxels;
  }
  function spinsFromGrid2D(grid, options = {}) {
    const zPositions = options.zPositions?.length ? options.zPositions : [0];
    const sub = options.subSpins ?? 1;
    const [mx, my] = (typeof sub === "number" ? [sub, sub] : sub).map((m) => Math.max(1, Math.floor(m)));
    const voxels = options.voxels ?? nonEmptyVoxels(grid);
    const perVoxel = zPositions.length * mx * my;
    const count = voxels.length * perVoxel;
    const set = {
      count,
      x: new Float64Array(count),
      y: new Float64Array(count),
      z: new Float64Array(count),
      df: new Float64Array(count),
      r1: new Float64Array(count),
      r2: new Float64Array(count),
      weight: new Float64Array(count),
      b1Re: new Float64Array(count).fill(1),
      b1Im: new Float64Array(count),
      coils: 1,
      rxRe: new Float64Array(count).fill(1),
      rxIm: new Float64Array(count)
    };
    const dx = grid.fovX / grid.nx, dy = grid.fovY / grid.ny;
    const offsetsX = Array.from({ length: mx }, (_, a) => (a + 0.5) / mx - 0.5);
    const offsetsY = Array.from({ length: my }, (_, a) => (a + 0.5) / my - 0.5);
    let k = 0;
    for (let v = 0; v < voxels.length; v++) {
      const index = voxels[v];
      const ix = index % grid.nx, iy = Math.floor(index / grid.nx);
      const x0 = (ix - grid.nx / 2) * dx;
      const y0 = (grid.ny / 2 - 1 - iy) * dy;
      const t1 = grid.t1[index], t2 = grid.t2[index];
      const r1 = Number.isFinite(t1) && t1 > 0 ? 1 / t1 : 0;
      const r2 = Number.isFinite(t2) && t2 > 0 ? 1 / t2 : 0;
      const weight = grid.pd[index] / perVoxel;
      for (const z of zPositions) {
        for (const oy of offsetsY) {
          for (const ox of offsetsX) {
            set.x[k] = x0 + ox * dx;
            set.y[k] = y0 + oy * dy;
            set.z[k] = z;
            set.r1[k] = r1;
            set.r2[k] = r2;
            set.weight[k] = weight;
            k++;
          }
        }
      }
    }
    return set;
  }

  // src/sim/plan/dephasing.ts
  function analyzeDephasing(program) {
    const intervalArea = [0, 0, 0];
    const readoutExtent = [0, 0, 0];
    const areaAtRf = [0, 0, 0];
    const sinceRf = [0, 0, 0];
    const k = [0, 0, 0];
    const total = [0, 0, 0];
    let readoutAxes = 0, rfGradientAxes = 0;
    let rfEvents = 0, adcEvents = 0, adcSamples = 0;
    for (const segment of program.segments()) {
      const dk = segment.moments.dk;
      if (segment.kind === "rf") {
        for (let a = 0; a < 3; a++) areaAtRf[a] = Math.max(areaAtRf[a], Math.abs(total[a]));
        const { ga, gb } = segment.gradient;
        for (let i = 0; i < ga.length; i++) if (ga[i] !== 0 || gb[i] !== 0) rfGradientAxes |= 1 << i % 3;
        const head = segment.kToCenter;
        if (rfEvents > 0) {
          for (let a = 0; a < 3; a++) {
            intervalArea[a] = Math.max(intervalArea[a], Math.abs(sinceRf[a] + head[a]));
          }
        }
        for (let a = 0; a < 3; a++) sinceRf[a] = dk[a] - head[a];
        rfEvents++;
        for (let a = 0; a < 3; a++) k[a] += head[a];
        const use = segment.use || "";
        if (use === "e" || use === "" || use === "u") k.fill(0);
        else if (use === "r") for (let a = 0; a < 3; a++) k[a] = -k[a];
        for (let a = 0; a < 3; a++) {
          k[a] += dk[a] - head[a];
          total[a] += dk[a];
        }
        continue;
      }
      if (segment.kind === "adc") {
        adcEvents++;
        adcSamples += segment.numSamples;
        readoutAxes |= segment.activeAxes;
        for (let a = 0; a < 3; a++) {
          readoutExtent[a] = Math.max(readoutExtent[a], Math.abs(k[a]), Math.abs(k[a] + dk[a]));
        }
      }
      for (let a = 0; a < 3; a++) {
        sinceRf[a] += dk[a];
        k[a] += dk[a];
        total[a] += dk[a];
      }
    }
    return { intervalArea, readoutExtent, readoutAxes, rfGradientAxes, areaAtRf, rfEvents, adcEvents, adcSamples };
  }
  function foldableAxes(analysis, extent) {
    let mask = 0;
    for (let a = 0; a < 3; a++) {
      const bit = 1 << a;
      if (analysis.readoutAxes & bit || analysis.rfGradientAxes & bit) continue;
      if (analysis.areaAtRf[a] * extent[a] > 1e-9) continue;
      mask |= bit;
    }
    return mask;
  }
  function resolutionCount(analysis, axis, voxel) {
    const extent = analysis.readoutExtent[axis] * voxel;
    return extent > 0.5 + 1e-3 ? Math.ceil(4 * extent) : 1;
  }
  function intervalCycles(analysis, axis, voxel) {
    return analysis.intervalArea[axis] * voxel;
  }

  // src/sim/plan/probe.ts
  var CANDIDATES = [2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 1536, 2048];
  function probeSubSpins(program, axis, voxel, tissues, options = {}) {
    const minimum = Math.max(1, Math.floor(options.minimum ?? 1));
    const tolerance = options.tolerance ?? 0.02;
    const horizon = Math.min(program.totalDuration, options.horizon ?? 4);
    const reference = Math.max(minimum + 1, Math.floor(options.reference ?? defaultReference(program, horizon, options.intervalCycles)));
    const maximum = Math.max(minimum, Math.min(Math.floor(options.maximum ?? 2048), Math.floor(reference / 2)));
    const run = (count, tissue) => simulateReference(program, probeVoxel(axis, voxel, count, tissue), { until: horizon }).signal;
    const order = distinctTissues(tissues).sort((a, b) => lifetime(b) - lifetime(a));
    const references = order.map(() => null);
    const norms = order.map(() => 0);
    const referenceFor = (t) => {
      let signal = references[t];
      if (!signal) {
        signal = run(reference, order[t]);
        references[t] = signal;
        norms[t] = norm(signal);
      }
      return signal;
    };
    const candidates = [minimum, ...CANDIDATES.filter((n) => n > minimum && n <= maximum)];
    const tested = [];
    for (const count of candidates) {
      let error = 0;
      for (let t = 0; t < order.length && error <= tolerance; t++) {
        const target = referenceFor(t);
        if (!(norms[t] > 0)) continue;
        error = Math.max(error, distance(run(count, order[t]), target) / norms[t]);
      }
      tested.push({ count, error });
      if (error <= tolerance) return { count, error, reference, capped: false, tested };
    }
    const last = tested[tested.length - 1];
    return { count: last.count, error: last.error, reference, capped: true, tested };
  }
  function defaultReference(program, horizon, cycles) {
    if (!(cycles !== void 0 && cycles > 0)) return 1024;
    let pulses = 0;
    for (const segment of program.segments()) {
      if (segment.t0 >= horizon) break;
      if (segment.kind === "rf") pulses++;
    }
    const wanted = 2 * cycles * Math.max(1, pulses);
    return Math.min(8192, Math.max(256, 2 ** Math.ceil(Math.log2(wanted))));
  }
  function probeVoxel(axis, voxel, count, tissue) {
    const positions = [new Float64Array(count), new Float64Array(count), new Float64Array(count)];
    for (let a = 0; a < count; a++) positions[axis][a] = ((a + 0.5) / count - 0.5) * voxel;
    const rate = (time) => Number.isFinite(time) && time > 0 ? 1 / time : 0;
    return {
      count,
      x: positions[0],
      y: positions[1],
      z: positions[2],
      df: new Float64Array(count),
      r1: new Float64Array(count).fill(rate(tissue.t1)),
      r2: new Float64Array(count).fill(rate(tissue.t2)),
      weight: new Float64Array(count).fill(1 / count),
      b1Re: new Float64Array(count).fill(1),
      b1Im: new Float64Array(count),
      coils: 1,
      rxRe: new Float64Array(count).fill(1),
      rxIm: new Float64Array(count)
    };
  }
  function distinctTissues(tissues) {
    const seen = /* @__PURE__ */ new Map();
    for (const tissue of tissues) seen.set(`${tissue.t1}|${tissue.t2}`, tissue);
    return [...seen.values()];
  }
  function lifetime(tissue) {
    const t2 = Number.isFinite(tissue.t2) ? tissue.t2 : 1e9;
    const t1 = Number.isFinite(tissue.t1) ? tissue.t1 : 1e9;
    return t2 + 1e-6 * t1;
  }
  function norm(signal) {
    let sum = 0;
    for (let i = 0; i < signal.length; i++) sum += signal[i] * signal[i];
    return Math.sqrt(sum);
  }
  function distance(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
    return Math.sqrt(sum);
  }

  // src/sim/recon/cartesian.ts
  function reconstructCartesian(trajectory, signal, coils, options = {}) {
    const maxSize = options.maxSize ?? 512;
    const maxFrames = options.maxFrames ?? 64;
    const warnings = [];
    const k = trajectory.k;
    const totalSamples = k.length / 3;
    const extent = [0, 0, 0];
    for (let s = 0; s < totalSamples; s++) {
      for (let a = 0; a < 3; a++) extent[a] = Math.max(extent[a], Math.abs(k[3 * s + a]));
    }
    const ranked = [0, 1, 2].sort((a, b) => extent[b] - extent[a]);
    const axes = [ranked[0], ranked[1]].sort((a, b) => a - b);
    const delta = axes.map((axis) => {
      const fov = options.fov?.[axis];
      if (fov && fov > 0) return 1 / fov;
      return estimateStep(trajectory, axis);
    });
    const offset = axes.map((axis, i) => gridOffset(k, axis, delta[i]));
    const size = axes.map((axis, i) => {
      const n = 2 * Math.round(extent[axis] / delta[i] + (offset[i] ? 0.5 : 0));
      return Math.max(2, Math.min(maxSize, n));
    });
    const [nu, nv] = size;
    const groupIds = /* @__PURE__ */ new Map();
    const groupFrames = /* @__PURE__ */ new Map();
    const frameOfReadout = new Int32Array(trajectory.readouts);
    const frameGroup = [];
    const frameRepeat = [];
    const repeats = /* @__PURE__ */ new Map();
    for (let r = 0; r < trajectory.readouts; r++) {
      const key = trajectory.excitationKey[r];
      let group = groupIds.get(key);
      if (group === void 0) {
        group = groupIds.size;
        groupIds.set(key, group);
      }
      const centre = trajectory.offsets[r] + (trajectory.samples[r] >> 1);
      const row = Math.round(k[3 * centre + axes[1]] / delta[1] - offset[1]);
      let current = groupFrames.get(group);
      if (!current || current.rows.has(row)) {
        const repeat = repeats.get(group) ?? 0;
        repeats.set(group, repeat + 1);
        current = { frame: frameGroup.length, rows: /* @__PURE__ */ new Set() };
        groupFrames.set(group, current);
        frameGroup.push(group);
        frameRepeat.push(repeat);
      }
      current.rows.add(row);
      frameOfReadout[r] = current.frame;
    }
    let frames = frameGroup.length;
    if (frames > maxFrames) {
      warnings.push(`Only the first ${maxFrames} of ${frames} frames are reconstructed.`);
      frames = maxFrames;
    }
    const cells = nu * nv;
    const gridRe = new Float64Array(frames * coils * cells);
    const gridIm = new Float64Array(frames * coils * cells);
    const filled = new Uint8Array(frames * cells);
    let offGrid = 0;
    for (let r = 0; r < trajectory.readouts; r++) {
      const frame = frameOfReadout[r];
      if (frame >= frames) continue;
      for (let s = 0; s < trajectory.samples[r]; s++) {
        const index = trajectory.offsets[r] + s;
        const fu = k[3 * index + axes[0]] / delta[0] - offset[0];
        const fv = k[3 * index + axes[1]] / delta[1] - offset[1];
        const cu = Math.round(fu), cv = Math.round(fv);
        if (Math.abs(fu - cu) > 0.1 || Math.abs(fv - cv) > 0.1) offGrid++;
        const iu = cu + (nu >> 1);
        const iv = cv + (nv >> 1);
        if (iu < 0 || iu >= nu || iv < 0 || iv >= nv) continue;
        const cell = iv * nu + iu;
        filled[frame * cells + cell] = 1;
        for (let c = 0; c < coils; c++) {
          const o = (frame * coils + c) * cells + cell;
          const source = (index * coils + c) * 2;
          gridRe[o] = signal[source];
          gridIm[o] = signal[source + 1];
        }
      }
    }
    const offGridFraction = totalSamples > 0 ? offGrid / totalSamples : 0;
    if (offGridFraction > 0.05) {
      warnings.push("Many samples fall between grid points (non-Cartesian or ramp-sampled); this preview snaps them to the nearest cell.");
    }
    const images = new Float32Array(frames * cells);
    const kspace = new Float32Array(frames * cells);
    const twiddleU = centredTwiddles(nu, offset[0]);
    const twiddleV = centredTwiddles(nv, offset[1]);
    const workRe = new Float64Array(cells), workIm = new Float64Array(cells);
    for (let frame = 0; frame < frames; frame++) {
      const image = images.subarray(frame * cells, (frame + 1) * cells);
      const ks = kspace.subarray(frame * cells, (frame + 1) * cells);
      for (let c = 0; c < coils; c++) {
        const base = (frame * coils + c) * cells;
        for (let i = 0; i < cells; i++) {
          workRe[i] = gridRe[base + i];
          workIm[i] = gridIm[base + i];
          ks[i] += workRe[i] * workRe[i] + workIm[i] * workIm[i];
        }
        inverseDft2(workRe, workIm, nu, nv, twiddleU, twiddleV);
        for (let iv = 0; iv < nv; iv++) {
          const row = nv - 1 - iv;
          for (let iu = 0; iu < nu; iu++) {
            const i = iv * nu + iu;
            image[row * nu + iu] += workRe[i] * workRe[i] + workIm[i] * workIm[i];
          }
        }
      }
      for (let i = 0; i < cells; i++) {
        image[i] = Math.sqrt(image[i]);
        ks[i] = Math.sqrt(ks[i]);
      }
      flipRows(ks, nu, nv);
    }
    let filledCount = 0;
    for (let i = 0; i < filled.length; i++) filledCount += filled[i];
    return {
      axes,
      nu,
      nv,
      frames,
      images,
      kspace,
      frameGroup: Int32Array.from(frameGroup.slice(0, frames)),
      frameRepeat: Int32Array.from(frameRepeat.slice(0, frames)),
      fill: frames > 0 ? filledCount / (frames * cells) : 0,
      offGridFraction,
      warnings
    };
  }
  function estimateStep(trajectory, axis) {
    const values = [];
    for (let r = 0; r < trajectory.readouts; r++) {
      const centre = trajectory.offsets[r] + (trajectory.samples[r] >> 1);
      values.push(trajectory.k[3 * centre + axis]);
      if (trajectory.samples[r] > 1) {
        const next = centre + 1 < trajectory.offsets[r] + trajectory.samples[r] ? centre + 1 : centre - 1;
        values.push(trajectory.k[3 * next + axis]);
      }
    }
    values.sort((a, b) => a - b);
    let step = Infinity;
    const span = values.length ? values[values.length - 1] - values[0] : 0;
    for (let i = 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      if (d > span * 1e-6 && d < step) step = d;
    }
    return Number.isFinite(step) && step > 0 ? step : 1;
  }
  function gridOffset(k, axis, delta) {
    let integer = 0, half = 0;
    for (let s = axis; s < k.length; s += 3) {
      const f = k[s] / delta;
      const fraction = Math.abs(f - Math.round(f));
      if (fraction < 0.1) integer++;
      else if (Math.abs(fraction - 0.5) < 0.1) half++;
    }
    return half > integer ? 0.5 : 0;
  }
  function centredTwiddles(n, offset = 0) {
    const re = new Float64Array(n * n), im = new Float64Array(n * n);
    const half = n / 2;
    for (let j = 0; j < n; j++) {
      for (let p = 0; p < n; p++) {
        const product = (j - half + offset) * (p - half) % n;
        const angle = 2 * Math.PI * product / n;
        re[j * n + p] = Math.cos(angle);
        im[j * n + p] = Math.sin(angle);
      }
    }
    return { re, im };
  }
  function inverseDft2(re, im, nu, nv, tu, tv) {
    const lineRe = new Float64Array(Math.max(nu, nv));
    const lineIm = new Float64Array(Math.max(nu, nv));
    for (let v = 0; v < nv; v++) {
      transformLine(re, im, v * nu, 1, nu, tu, lineRe, lineIm);
    }
    for (let u = 0; u < nu; u++) {
      transformLine(re, im, u, nu, nv, tv, lineRe, lineIm);
    }
  }
  function transformLine(re, im, start, stride, n, t, outRe, outIm) {
    for (let p = 0; p < n; p++) {
      let sr = 0, si = 0;
      for (let j = 0; j < n; j++) {
        const xr = re[start + j * stride], xi = im[start + j * stride];
        if (xr === 0 && xi === 0) continue;
        const wr = t.re[j * n + p], wi = t.im[j * n + p];
        sr += xr * wr - xi * wi;
        si += xr * wi + xi * wr;
      }
      outRe[p] = sr;
      outIm[p] = si;
    }
    for (let p = 0; p < n; p++) {
      re[start + p * stride] = outRe[p];
      im[start + p * stride] = outIm[p];
    }
  }
  function flipRows(values, nu, nv) {
    const row = new Float32Array(nu);
    for (let top = 0, bottom = nv - 1; top < bottom; top++, bottom--) {
      row.set(values.subarray(top * nu, (top + 1) * nu));
      values.copyWithin(top * nu, bottom * nu, (bottom + 1) * nu);
      values.set(row, bottom * nu);
    }
  }

  // src/sim/recon/trajectory.ts
  function adcTrajectory(program) {
    const samples = [];
    const offsets = [];
    const excitation = [];
    const excitationKey = [];
    const chunks = [];
    const k = [0, 0, 0];
    let total = 0;
    let excitations = -1;
    let currentKey = "";
    for (const segment of program.segments()) {
      if (segment.kind === "rf") {
        for (let a = 0; a < 3; a++) k[a] += segment.kToCenter[a];
        const use = segment.use || "";
        if (use === "e" || use === "" || use === "u") {
          k.fill(0);
          excitations++;
          currentKey = segment.key;
        } else if (use === "r") {
          for (let a = 0; a < 3; a++) k[a] = -k[a];
        }
        for (let a = 0; a < 3; a++) k[a] += segment.moments.dk[a] - segment.kToCenter[a];
      } else if (segment.kind === "adc") {
        const times = adcSampleTimes(segment);
        const local = new Float64Array(3 * times.length);
        piecesKAt(segment.gradient, times, local);
        for (let s = 0; s < times.length; s++) {
          for (let a = 0; a < 3; a++) local[3 * s + a] += k[a];
        }
        chunks.push(local);
        offsets.push(total);
        samples.push(segment.numSamples);
        excitation.push(excitations);
        excitationKey.push(currentKey);
        total += segment.numSamples;
        for (let a = 0; a < 3; a++) k[a] += segment.moments.dk[a];
      } else {
        for (let a = 0; a < 3; a++) k[a] += segment.moments.dk[a];
      }
    }
    const kAll = new Float64Array(3 * total);
    let position = 0;
    for (const chunk of chunks) {
      kAll.set(chunk, position);
      position += chunk.length;
    }
    return {
      readouts: samples.length,
      samples: Int32Array.from(samples),
      offsets: Int32Array.from(offsets),
      k: kAll,
      excitation: Int32Array.from(excitation),
      excitationKey
    };
  }

  // src/sim/job.ts
  var MAX_JOB_SPINS = 32e6;
  var MAX_JOB_SIMULATED = 4e6;
  var MIN_CHUNK_SPINS = 16384;
  var MAX_CHUNKS = 64;
  var REPLAY_BLOCK_LIMIT = 2e5;
  var SimulationJob = class {
    constructor(bytes, name, settings) {
      __publicField(this, "program");
      __publicField(this, "analysis");
      __publicField(this, "grid");
      __publicField(this, "plan");
      /** Folded axes (bit 0 = x, bit 1 = y). */
      __publicField(this, "fold");
      /** Tissue index of every voxel (−1 when empty), and the tissues' T1/T2. */
      __publicField(this, "tissueOf");
      __publicField(this, "tissues");
      __publicField(this, "chunkVoxels");
      __publicField(this, "sequenceFov");
      __publicField(this, "trajectory", null);
      const seq = parseSequenceBytes(bytes, name);
      this.program = replayable(compileProgram(seq));
      this.analysis = analyzeDephasing(this.program);
      if (this.analysis.adcEvents === 0) throw new Error("The sequence has no ADC events, so there is no signal to simulate.");
      const definition = seq.definitions.get("FOV");
      this.sequenceFov = definition && definition.length >= 2 && definition.every((v) => Number.isFinite(+v)) ? [+definition[0], +definition[1], definition.length > 2 ? +definition[2] : 0] : null;
      const size = Math.round(settings.size);
      if (!(size >= 2 && size <= 1024)) throw new Error(`Phantom size must be between 2 and 1024, got ${settings.size}.`);
      const fov = settings.fov ?? (this.sequenceFov && this.sequenceFov[0] > 0 && this.sequenceFov[1] > 0 ? [this.sequenceFov[0], this.sequenceFov[1]] : [0.256, 0.256]);
      this.grid = sheppLoganPhantom(size, fov[0], fov[1]);
      ({ tissueOf: this.tissueOf, tissues: this.tissues } = tissueTable(this.grid));
      this.fold = foldableAxes(this.analysis, [fov[0], fov[1], 0]) & 3;
      const voxel = [fov[0] / size, fov[1] / size];
      const axes = [0, 1].map((axis) => this.planAxis(axis, voxel[axis], settings));
      const subSpins = [axes[0].count, axes[1].count];
      const perVoxel = subSpins[0] * subSpins[1];
      const voxels = nonEmptyVoxels(this.grid);
      const spins = voxels.length * perVoxel;
      if (spins > MAX_JOB_SPINS) {
        throw new Error(`${spins.toLocaleString("en-US")} spins exceed the ${MAX_JOB_SPINS.toLocaleString("en-US")} limit; use a smaller phantom or fewer spins per voxel.`);
      }
      const units = this.chunkUnits(voxels);
      const simulated = this.countClasses(units, subSpins);
      if (simulated > MAX_JOB_SIMULATED) {
        throw new Error(`${simulated.toLocaleString("en-US")} simulated spins exceed the ${MAX_JOB_SIMULATED.toLocaleString("en-US")} limit; use a smaller phantom or fewer spins per voxel.`);
      }
      this.chunkVoxels = splitUnits(units, perVoxel, Math.max(MIN_CHUNK_SPINS, Math.ceil(spins / MAX_CHUNKS)));
      const notes = ["2D phantom: one plane at z = 0, so the slice profile and through-plane dephasing are not simulated."];
      for (const [axis, plan] of axes.entries()) {
        if (plan.probe?.capped) {
          notes.push(`${"xy"[axis]}: ${plan.count} spins per voxel did not reach the 2 % target (error ${(100 * plan.probe.error).toFixed(0)} %); expect residual stripes from incomplete spoiling.`);
        }
      }
      for (const feature of this.program.ignoredFeatures) notes.push(`Not simulated: ${feature}.`);
      this.plan = {
        blocks: this.program.blockCount,
        duration: this.program.totalDuration,
        rfEvents: this.analysis.rfEvents,
        adcEvents: this.analysis.adcEvents,
        adcSamples: this.analysis.adcSamples,
        phantom: { nx: size, ny: size, fov, voxels: voxels.length, tissues: this.tissues.length },
        axes,
        subSpins,
        spins,
        simulated,
        chunks: this.chunkVoxels.length,
        coils: 1,
        notes
      };
    }
    /** Simulate one chunk; returns its delivered signal (see SimulationResult.signal). */
    simulateChunk(index, options = {}) {
      const voxels = this.chunkVoxels[index];
      if (!voxels) throw new Error(`No chunk ${index} (the job has ${this.chunkVoxels.length}).`);
      if (!this.fold) {
        const spins = spinsFromGrid2D(this.grid, { subSpins: this.plan.subSpins, voxels });
        return simulateReference(this.program, spins, options).signal;
      }
      const { classes, members } = this.foldChunk(voxels);
      return simulateReference(this.program, classes, { ...options, members }).signal;
    }
    reconstruct(signal) {
      this.trajectory ?? (this.trajectory = adcTrajectory(this.program));
      return reconstructCartesian(this.trajectory, signal, this.plan.coils, { fov: this.sequenceFov });
    }
    /** |signal| as readouts × samples, for the raw-data view. */
    rawMagnitude(signal) {
      this.trajectory ?? (this.trajectory = adcTrajectory(this.program));
      const { readouts, samples, offsets } = this.trajectory;
      let columns = 0;
      for (let r = 0; r < readouts; r++) columns = Math.max(columns, samples[r]);
      const coils = this.plan.coils;
      const magnitude = new Float32Array(readouts * columns);
      for (let r = 0; r < readouts; r++) {
        for (let s = 0; s < samples[r]; s++) {
          let power = 0;
          for (let c = 0; c < coils; c++) {
            const o = ((offsets[r] + s) * coils + c) * 2;
            power += signal[o] * signal[o] + signal[o + 1] * signal[o + 1];
          }
          magnitude[r * columns + s] = Math.sqrt(power);
        }
      }
      return { rows: readouts, columns, magnitude };
    }
    planAxis(axis, voxel, settings) {
      const folded = (this.fold & 1 << axis) !== 0;
      if (settings.subSpins !== "auto") {
        return { count: clampCount(settings.subSpins[axis]), reason: "manual", folded };
      }
      const resolution = resolutionCount(this.analysis, axis, voxel);
      if (folded || intervalCycles(this.analysis, axis, voxel) <= 0.05) {
        return { count: resolution, reason: resolution > 1 ? "resolution" : "none", folded };
      }
      const probe = probeSubSpins(this.program, axis, voxel, this.tissues, {
        minimum: resolution,
        maximum: settings.maxSubSpins,
        intervalCycles: intervalCycles(this.analysis, axis, voxel)
      });
      return {
        count: probe.count,
        reason: probe.count > resolution ? "spoiling" : resolution > 1 ? "resolution" : "none",
        folded,
        probe: { error: probe.error, reference: probe.reference, capped: probe.capped, tested: probe.tested }
      };
    }
    /** Voxels grouped into the units chunks are cut from (see the file comment). */
    chunkUnits(voxels) {
      const nx = this.grid.nx;
      const byColumn = this.fold === 2 || this.fold === 0 && (this.analysis.readoutAxes & 7) === 1;
      const byRow = this.fold === 1;
      if (!byColumn && !byRow) return Array.from(voxels, (v) => Int32Array.of(v));
      const lines = /* @__PURE__ */ new Map();
      for (const v of voxels) {
        const line = byColumn ? v % nx : Math.floor(v / nx);
        let list = lines.get(line);
        if (!list) lines.set(line, list = []);
        list.push(v);
      }
      return [...lines.keys()].sort((a, b) => a - b).map((line) => Int32Array.from(lines.get(line)));
    }
    /** Simulated spins over all chunks: classes when folded, else every spin. */
    countClasses(units, subSpins) {
      if (!this.fold) return units.reduce((sum, unit) => sum + unit.length, 0) * subSpins[0] * subSpins[1];
      const unfolded = (this.fold & 1 ? 1 : subSpins[0]) * (this.fold & 2 ? 1 : subSpins[1]);
      if (this.fold === 3) return this.tissues.length;
      let total = 0;
      for (const unit of units) {
        const seen = /* @__PURE__ */ new Set();
        for (const v of unit) seen.add(this.tissueOf[v]);
        total += seen.size * unfolded;
      }
      return total;
    }
    /** Classes (one per unfolded sub-position and tissue) and members of a chunk's voxels. */
    foldChunk(voxels) {
      const grid = this.grid;
      const [mx, my] = this.plan.subSpins;
      const foldX = (this.fold & 1) !== 0, foldY = (this.fold & 2) !== 0;
      const dx = grid.fovX / grid.nx, dy = grid.fovY / grid.ny;
      const offsetsX = Array.from({ length: mx }, (_, a) => (a + 0.5) / mx - 0.5);
      const offsetsY = Array.from({ length: my }, (_, a) => (a + 0.5) / my - 0.5);
      const lineY = grid.ny * my;
      const memberCount = voxels.length * mx * my;
      const classOf = new Int32Array(memberCount);
      const weight = new Float64Array(memberCount);
      const foldOf = new Int32Array(memberCount);
      const classIndex = /* @__PURE__ */ new Map();
      const pointIndex = /* @__PURE__ */ new Map();
      const classX = [], classY = [], classTissue = [];
      const points = [];
      let m = 0;
      for (let v = 0; v < voxels.length; v++) {
        const index = voxels[v];
        const ix = index % grid.nx, iy = Math.floor(index / grid.nx);
        const tissue = this.tissueOf[index];
        const w = grid.pd[index] / (mx * my);
        const x0 = (ix - grid.nx / 2) * dx;
        const y0 = (grid.ny / 2 - 1 - iy) * dy;
        for (let ay = 0; ay < my; ay++) {
          const y = y0 + offsetsY[ay] * dy;
          const jy = iy * my + ay;
          for (let ax = 0; ax < mx; ax++) {
            const x = x0 + offsetsX[ax] * dx;
            const jx = ix * mx + ax;
            const classKey = ((foldX ? 0 : jx) * lineY + (foldY ? 0 : jy)) * this.tissues.length + tissue;
            let c = classIndex.get(classKey);
            if (c === void 0) {
              c = classX.length;
              classIndex.set(classKey, c);
              classX.push(foldX ? 0 : x);
              classY.push(foldY ? 0 : y);
              classTissue.push(tissue);
            }
            const pointKey = (foldX ? jx : 0) * (lineY + 1) + (foldY ? jy : 0);
            let p = pointIndex.get(pointKey);
            if (p === void 0) {
              p = points.length / 3;
              pointIndex.set(pointKey, p);
              points.push(foldX ? x : 0, foldY ? y : 0, 0);
            }
            classOf[m] = c;
            weight[m] = w;
            foldOf[m] = p;
            m++;
          }
        }
      }
      const count = classX.length;
      const rate = (time) => Number.isFinite(time) && time > 0 ? 1 / time : 0;
      const classes = {
        count,
        x: Float64Array.from(classX),
        y: Float64Array.from(classY),
        z: new Float64Array(count),
        df: new Float64Array(count),
        r1: Float64Array.from(classTissue, (t) => rate(this.tissues[t].t1)),
        r2: Float64Array.from(classTissue, (t) => rate(this.tissues[t].t2)),
        weight: new Float64Array(count),
        b1Re: new Float64Array(count).fill(1),
        b1Im: new Float64Array(count),
        coils: 1,
        rxRe: new Float64Array(count).fill(1),
        rxIm: new Float64Array(count)
      };
      const members = {
        count: memberCount,
        classOf,
        weight,
        foldOf,
        foldPoints: Float64Array.from(points),
        coils: 1,
        rxRe: new Float64Array(memberCount).fill(1),
        rxIm: new Float64Array(memberCount)
      };
      return { classes, members };
    }
  };
  function clampCount(value) {
    const n = Math.floor(value);
    if (!(n >= 1 && n <= 4096)) throw new Error(`Spins per voxel must be between 1 and 4096 per axis, got ${value}.`);
    return n;
  }
  function tissueTable(grid) {
    const tissueOf = new Int32Array(grid.pd.length).fill(-1);
    const tissues = [];
    const index = /* @__PURE__ */ new Map();
    for (let i = 0; i < grid.pd.length; i++) {
      if (!(grid.pd[i] > 0)) continue;
      const key = `${grid.t1[i]}|${grid.t2[i]}`;
      let t = index.get(key);
      if (t === void 0) {
        t = tissues.length;
        index.set(key, t);
        tissues.push({ t1: grid.t1[i], t2: grid.t2[i] });
      }
      tissueOf[i] = t;
    }
    return { tissueOf, tissues };
  }
  function splitUnits(units, perVoxel, target) {
    const chunks = [];
    let current = [];
    let spins = 0;
    for (const unit of units) {
      if (current.length && spins + unit.length * perVoxel > target) {
        chunks.push(Int32Array.from(current));
        current = [];
        spins = 0;
      }
      for (const v of unit) current.push(v);
      spins += unit.length * perVoxel;
    }
    if (current.length) chunks.push(Int32Array.from(current));
    return chunks;
  }
  function replayable(program) {
    if (program.blockCount > REPLAY_BLOCK_LIMIT) return program;
    let cached = null;
    return {
      ...program,
      segments: function* () {
        if (!cached) {
          const collected = [];
          for (const segment of program.segments()) {
            collected.push(segment);
            yield segment;
          }
          cached = collected;
          return;
        }
        yield* cached;
      }
    };
  }

  // src/sim/platform/browser.ts
  function standardSelfPort() {
    const g = globalThis;
    return {
      post: (message, transfer) => g.postMessage(message, transfer),
      onMessage: (handler) => g.addEventListener("message", (event) => handler(event.data))
    };
  }

  // src/sim/worker/entry.ts
  var port = standardSelfPort();
  var jobs = /* @__PURE__ */ new Map();
  var PROGRESS_SPACING_MS = 100;
  function now() {
    const clock = globalThis.performance;
    return clock ? clock.now() : Date.now();
  }
  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }
  function jobFor(id) {
    const job = jobs.get(id);
    if (!job) throw new Error("The simulation job is not open in this worker.");
    return job;
  }
  function handle(request) {
    switch (request.type) {
      case "open": {
        jobs.clear();
        const job = new SimulationJob(new Uint8Array(request.bytes), request.name, request.settings);
        jobs.set(request.job, job);
        port.post({ type: "plan", job: request.job, plan: job.plan }, []);
        return;
      }
      case "chunk": {
        const job = jobFor(request.job);
        const started = now();
        let last = started;
        const signal = job.simulateChunk(request.chunk, {
          progressInterval: 16,
          onProgress: (fraction) => {
            const t = now();
            if (t - last < PROGRESS_SPACING_MS) return;
            last = t;
            port.post({ type: "progress", job: request.job, chunk: request.chunk, fraction }, []);
          }
        });
        port.post(
          { type: "chunk", job: request.job, chunk: request.chunk, signal, ms: now() - started },
          [signal.buffer]
        );
        return;
      }
      case "recon": {
        const job = jobFor(request.job);
        const recon = job.reconstruct(request.signal);
        const raw = job.rawMagnitude(request.signal);
        port.post({
          type: "recon",
          job: request.job,
          recon: {
            axes: recon.axes,
            nu: recon.nu,
            nv: recon.nv,
            frames: recon.frames,
            images: recon.images,
            kspace: recon.kspace,
            fill: recon.fill,
            offGridFraction: recon.offGridFraction,
            warnings: recon.warnings
          },
          raw
        }, [recon.images.buffer, recon.kspace.buffer, raw.magnitude.buffer]);
        return;
      }
      case "close":
        jobs.delete(request.job);
        return;
    }
  }
  port.onMessage((data) => {
    const request = data;
    try {
      handle(request);
    } catch (error) {
      port.post({ type: "error", job: request?.job ?? -1, message: errorMessage(error) }, []);
    }
  });
})();
