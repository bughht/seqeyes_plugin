/*! SeqEyes simulation worker. Includes fflate (https://github.com/101arrowz/fflate):
 * MIT License
 * 
 * Copyright (c) 2026 Arjun Barrett
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // src/pulseq/types.ts
  var VER_PRE_14 = 1004e3;
  var VER_V15 = 1005e3;
  var VER_V15001 = 1005001;
  function makeVersionCombined(major, minor, revision) {
    return major * 1e6 + minor * 1e3 + revision;
  }

  // src/pulseq/rfClassification.ts
  var GAMMA_HZ_T = 42576e3;
  var DEFAULT_B0_T = 3;
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
    return DEFAULT_B0_T;
  }

  // src/pulseq/trdetect.ts
  function detectSequenceTiming(seq) {
    const supportsRfUse = seq.versionCombined >= 1005e3;
    const classifiedRfUses = classifyRfUses(seq);
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
    for (let i2 = 0; i2 < seq.blocks.length; i2++) {
      const blk = seq.blocks[i2];
      if (blk.rfId <= 0) {
        rfUsePerBlock.push(0);
        continue;
      }
      const rf = seq.rfs.get(blk.rfId);
      if (!rf) {
        rfUsePerBlock.push(0);
        continue;
      }
      const useChar = classifiedRfUses[i2] || "u";
      const useCode = useChar.charCodeAt(0);
      rfUsePerBlock.push(useCode);
      if (useChar === "e") {
        const center = rf.center >= 0 ? rf.center * 1e-6 : estimateRfCenter(rf, seq);
        const excTime = blockStartTimes[i2] + rf.delay * 1e-6 + center;
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
      const totalDuration = blockStartTimes.length > 0 ? blockStartTimes[blockStartTimes.length - 1] + blockDurationSeconds(seq, seq.blocks[seq.blocks.length - 1]) : 0;
      trCount = Math.max(1, Math.ceil(totalDuration / trTimeSec));
      const tol = trTimeSec * 0.3;
      let trIdx = 0;
      for (let i2 = 0; i2 < seq.blocks.length; i2++) {
        const blkStart = blockStartTimes[i2];
        const expected = trIdx * trTimeSec;
        if (blkStart >= expected - tol && trIdx < trCount) {
          trStartBlocks.push(i2);
          trIdx++;
        }
      }
      trStartBlocks.push(seq.blocks.length);
      trCount = trStartBlocks.length - 1;
    } else {
      trCount = 0;
      for (let i2 = 0; i2 < seq.blocks.length; i2++) {
        if (seq.blocks[i2].adcId > 0) {
          trStartBlocks.push(i2);
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
  function computeCumulativeTimes(seq) {
    const times = [];
    let cum = 0;
    for (const blk of seq.blocks) {
      times.push(cum);
      cum += blockDurationSeconds(seq, blk);
    }
    return times;
  }
  function blockDurationSeconds(seq, block) {
    if (seq.versionCombined < VER_PRE_14) return block.dur * 1e-6;
    return block.dur * seq.rasterTimes.blockDurationRaster;
  }
  function estimateRfCenter(rf, _seq) {
    const magShape = _seq.shapes.get(rf.magShapeId);
    if (!magShape || magShape.numSamples <= 0) return 0;
    let peakIdx = 0;
    let peak = Math.abs(magShape.samples[0]);
    for (let i2 = 1; i2 < magShape.numSamples; i2++) {
      const v = Math.abs(magShape.samples[i2]);
      if (v > peak) {
        peak = v;
        peakIdx = i2;
      }
    }
    const raster = _seq.rasterTimes.rfRaster;
    const timeShape = rf.timeShapeId > 0 ? _seq.shapes.get(rf.timeShapeId)?.samples : void 0;
    return timeShape ? (timeShape[peakIdx] ?? 0) * raster : (peakIdx + 0.5) * raster;
  }
  function estimateTRFromExcitations(excTimesSec) {
    if (excTimesSec.length < 2) return 0;
    const intervals = [];
    for (let i2 = 1; i2 < excTimesSec.length; i2++) {
      const dt = excTimesSec[i2] - excTimesSec[i2 - 1];
      if (dt > 1e-9) intervals.push(dt);
    }
    if (intervals.length === 0) return 0;
    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];
    return Math.round(median * 1e6) / 1e6;
  }

  // src/sim/io/hdf5.ts
  function integer(size, signed) {
    return Object.freeze({ kind: "int", size, signed });
  }
  function float(size) {
    return Object.freeze({ kind: "float", size });
  }
  var h5t = Object.freeze({
    i8: integer(1, true),
    u8: integer(1, false),
    i16: integer(2, true),
    u16: integer(2, false),
    i32: integer(4, true),
    u32: integer(4, false),
    i64: integer(8, true),
    u64: integer(8, false),
    f32: float(4),
    f64: float(8),
    array(base, dims) {
      return Object.freeze({ kind: "array", base, dims: Object.freeze([...dims]) });
    },
    /**
     * A compound with its members packed in order, without padding — numpy's
     * default layout, and the layout of the #pragma pack(2) ISMRMRD structs.
     */
    compound(members) {
      let offset = 0;
      const placed = members.map(([name, type]) => {
        const member = Object.freeze({ name, offset, type });
        offset += typeInfo(type).size;
        return member;
      });
      return Object.freeze({ kind: "compound", size: offset, members: Object.freeze(placed) });
    },
    vlen(base) {
      return Object.freeze({ kind: "vlen", base });
    },
    string(charset = "utf-8") {
      return Object.freeze({ kind: "string", charset });
    }
  });
  var VLEN_REFERENCE_SIZE = 16;
  var MAX_U32 = 4294967295;
  var typeInfoCache = /* @__PURE__ */ new WeakMap();
  function typeInfo(type) {
    const cached = typeInfoCache.get(type);
    if (cached) return cached;
    let info;
    switch (type.kind) {
      case "int":
        if (![1, 2, 4, 8].includes(type.size)) throw new Error(`Integer size must be 1, 2, 4 or 8 bytes, got ${type.size}.`);
        info = { size: type.size, vlen: false, version: 1 };
        break;
      case "float":
        if (type.size !== 4 && type.size !== 8) throw new Error(`Float size must be 4 or 8 bytes, got ${type.size}.`);
        info = { size: type.size, vlen: false, version: 1 };
        break;
      case "string":
        if (type.charset !== "ascii" && type.charset !== "utf-8") throw new Error(`Unknown string charset '${type.charset}'.`);
        info = { size: VLEN_REFERENCE_SIZE, vlen: true, version: 1 };
        break;
      case "vlen": {
        const base = typeInfo(type.base);
        if (base.vlen) throw new Error("Variable-length data nested in variable-length data is not supported.");
        info = { size: VLEN_REFERENCE_SIZE, vlen: true, version: base.version };
        break;
      }
      case "array": {
        const base = typeInfo(type.base);
        if (type.dims.length < 1 || type.dims.length > 32) throw new Error(`An array type needs 1 to 32 dimensions, got ${type.dims.length}.`);
        let count = 1;
        for (const dim of type.dims) {
          if (!Number.isInteger(dim) || dim < 1 || dim > MAX_U32) throw new Error(`Array dimensions must be positive integers, got ${dim}.`);
          count *= dim;
        }
        info = { size: checkedSize(count * base.size), vlen: base.vlen, version: 3 };
        break;
      }
      case "compound": {
        const { members, size } = type;
        if (!Number.isInteger(size) || size < 1 || size > MAX_U32) throw new Error(`Compound size must be a positive integer, got ${size}.`);
        if (members.length < 1 || members.length > 65535) throw new Error(`A compound needs 1 to 65535 members, got ${members.length}.`);
        const names = /* @__PURE__ */ new Set();
        const spans = [];
        let vlen = false;
        for (const member of members) {
          if (!member.name || member.name.includes("\0")) throw new Error(`Invalid compound member name '${member.name}'.`);
          if (names.has(member.name)) throw new Error(`Duplicate compound member '${member.name}'.`);
          names.add(member.name);
          const memberInfo = typeInfo(member.type);
          if (!Number.isInteger(member.offset) || member.offset < 0 || member.offset + memberInfo.size > size) {
            throw new Error(`Member '${member.name}' (offset ${member.offset}, ${memberInfo.size} bytes) does not fit a ${size}-byte compound.`);
          }
          spans.push([member.offset, member.offset + memberInfo.size]);
          vlen || (vlen = memberInfo.vlen);
        }
        spans.sort((a, b) => a[0] - b[0]);
        for (let i2 = 1; i2 < spans.length; i2++) {
          if (spans[i2][0] < spans[i2 - 1][1]) throw new Error("Compound members overlap.");
        }
        info = { size, vlen, version: 3 };
        break;
      }
      default:
        throw new Error(`Unknown HDF5 type kind '${type.kind}'.`);
    }
    typeInfoCache.set(type, info);
    return info;
  }
  function checkedSize(size) {
    if (size > MAX_U32) throw new Error(`A ${size}-byte datatype is larger than HDF5 allows.`);
    return size;
  }
  var rotate = (x2, k) => (x2 << k | x2 >>> 32 - k) >>> 0;
  function lookup3(data, initval = 0) {
    let length = data.length;
    let a = 3735928559 + length + initval >>> 0;
    let b = a;
    let c = a;
    let k = 0;
    const word = (i2) => (data[i2] | data[i2 + 1] << 8 | data[i2 + 2] << 16 | data[i2 + 3] << 24) >>> 0;
    while (length > 12) {
      a = a + word(k) >>> 0;
      b = b + word(k + 4) >>> 0;
      c = c + word(k + 8) >>> 0;
      a = (a - c ^ rotate(c, 4)) >>> 0;
      c = c + b >>> 0;
      b = (b - a ^ rotate(a, 6)) >>> 0;
      a = a + c >>> 0;
      c = (c - b ^ rotate(b, 8)) >>> 0;
      b = b + a >>> 0;
      a = (a - c ^ rotate(c, 16)) >>> 0;
      c = c + b >>> 0;
      b = (b - a ^ rotate(a, 19)) >>> 0;
      a = a + c >>> 0;
      c = (c - b ^ rotate(b, 4)) >>> 0;
      b = b + a >>> 0;
      length -= 12;
      k += 12;
    }
    if (length === 0) return c;
    const tail = new Uint8Array(12);
    tail.set(data.subarray(k, k + length));
    a = a + (tail[0] | tail[1] << 8 | tail[2] << 16 | tail[3] << 24) >>> 0;
    b = b + (tail[4] | tail[5] << 8 | tail[6] << 16 | tail[7] << 24) >>> 0;
    c = c + (tail[8] | tail[9] << 8 | tail[10] << 16 | tail[11] << 24) >>> 0;
    c = (c ^ b) - rotate(b, 14) >>> 0;
    a = (a ^ c) - rotate(c, 11) >>> 0;
    b = (b ^ a) - rotate(a, 25) >>> 0;
    c = (c ^ b) - rotate(b, 16) >>> 0;
    a = (a ^ c) - rotate(c, 4) >>> 0;
    b = (b ^ a) - rotate(a, 14) >>> 0;
    c = (c ^ b) - rotate(b, 24) >>> 0;
    return c;
  }
  var UNDEFINED_ADDRESS = -1;
  var TWO_POW_32 = 4294967296;
  var LITTLE_ENDIAN_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  var utf8 = new TextEncoder();
  function setU64(view, at, value) {
    if (value === UNDEFINED_ADDRESS) {
      view.setUint32(at, MAX_U32, true);
      view.setUint32(at + 4, MAX_U32, true);
      return;
    }
    view.setUint32(at, value % TWO_POW_32, true);
    view.setUint32(at + 4, Math.floor(value / TWO_POW_32), true);
  }
  var ByteList = class {
    constructor() {
      __publicField(this, "buffer", new Uint8Array(64));
      __publicField(this, "view", new DataView(this.buffer.buffer));
      __publicField(this, "length", 0);
    }
    /** Reserves `count` bytes and returns their offset; may replace buffer and view, so call it first. */
    take(count) {
      const at = this.length;
      if (at + count > this.buffer.length) {
        const grown = new Uint8Array(Math.max(2 * this.buffer.length, at + count));
        grown.set(this.buffer);
        this.buffer = grown;
        this.view = new DataView(grown.buffer);
      }
      this.length += count;
      return at;
    }
    u8(value) {
      const at = this.take(1);
      this.buffer[at] = value;
      return this;
    }
    u16(value) {
      const at = this.take(2);
      this.view.setUint16(at, value, true);
      return this;
    }
    u32(value) {
      const at = this.take(4);
      this.view.setUint32(at, value, true);
      return this;
    }
    /** A non-negative safe integer, or UNDEFINED_ADDRESS. */
    u64(value) {
      const at = this.take(8);
      setU64(this.view, at, value);
      return this;
    }
    /** Unsigned little-endian integer in `width` bytes. */
    uint(value, width) {
      const at = this.take(width);
      for (let i2 = 0; i2 < width; i2++) this.buffer[at + i2] = Math.floor(value / 2 ** (8 * i2)) & 255;
      return this;
    }
    bytes(values) {
      const at = this.take(values.length);
      this.buffer.set(values, at);
      return this;
    }
    result() {
      return this.buffer.slice(0, this.length);
    }
  };
  function offsetWidth(size) {
    let bits2 = 0;
    for (let v = size; v >= 1; v = Math.floor(v / 2)) bits2++;
    return Math.floor((bits2 - 1) / 8) + 1;
  }
  function encodeDatatype(type, out) {
    const info = typeInfo(type);
    switch (type.kind) {
      case "int":
        out.u8(16).u8(type.signed ? 8 : 0).u8(0).u8(0).u32(type.size);
        out.u16(0).u16(8 * type.size);
        break;
      case "float": {
        const single = type.size === 4;
        out.u8(17).u8(32).u8(single ? 31 : 63).u8(0).u32(type.size);
        out.u16(0).u16(8 * type.size);
        out.u8(single ? 23 : 52).u8(single ? 8 : 11).u8(0).u8(single ? 23 : 52).u32(single ? 127 : 1023);
        break;
      }
      case "string":
        out.u8(25).u8(1).u8(type.charset === "utf-8" ? 1 : 0).u8(0).u32(VLEN_REFERENCE_SIZE);
        encodeDatatype(h5t.u8, out);
        break;
      case "vlen":
        out.u8(info.version << 4 | 9).u8(0).u8(0).u8(0).u32(VLEN_REFERENCE_SIZE);
        encodeDatatype(type.base, out);
        break;
      case "array":
        out.u8(58).u8(0).u8(0).u8(0).u32(info.size).u8(type.dims.length);
        for (const dim of type.dims) out.u32(dim);
        encodeDatatype(type.base, out);
        break;
      case "compound": {
        const count = type.members.length;
        const width = offsetWidth(type.size);
        out.u8(54).u8(count & 255).u8(count >>> 8).u8(0).u32(type.size);
        for (const member of type.members) {
          out.bytes(utf8.encode(member.name)).u8(0).uint(member.offset, width);
          encodeDatatype(member.type, out);
        }
        break;
      }
    }
  }
  var COLLECTION_HEADER_SIZE = 16;
  var HEAP_OBJECT_HEADER_SIZE = 16;
  var MIN_COLLECTION_SIZE = 4096;
  var TARGET_COLLECTION_SIZE = 4 * 1024 * 1024;
  var MAX_COLLECTION_OBJECTS = 8192;
  var align8 = (n) => Math.ceil(n / 8) * 8;
  var HeapPacker = class {
    constructor() {
      /** Bytes in use (header and objects) in each collection so far. */
      __publicField(this, "used", []);
      __publicField(this, "objects", 0);
      /** Of the last placement. */
      __publicField(this, "collection", -1);
      __publicField(this, "index", 0);
      /** Offset of the object's header within its collection. */
      __publicField(this, "offset", 0);
    }
    place(size) {
      const need = HEAP_OBJECT_HEADER_SIZE + align8(size);
      let last = this.used.length - 1;
      if (last < 0 || this.objects === MAX_COLLECTION_OBJECTS || this.used[last] + need > TARGET_COLLECTION_SIZE) {
        this.used.push(COLLECTION_HEADER_SIZE);
        this.objects = 0;
        last++;
      }
      this.collection = last;
      this.index = ++this.objects;
      this.offset = this.used[last];
      this.used[last] += need;
    }
  };
  var collectionSize = (used) => Math.max(MIN_COLLECTION_SIZE, used);
  function fail(where, expected, value) {
    const shown = typeof value === "bigint" ? `${value}n` : typeof value === "string" ? JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}\u2026` : value) : value !== null && typeof value === "object" ? value.constructor?.name ?? "object" : String(value);
    throw new Error(`${where}: expected ${expected}, got ${shown}.`);
  }
  function asArrayLike(value, where) {
    if (value === null || typeof value !== "object" || typeof value.length !== "number") {
      fail(where, "an array", value);
    }
    return value;
  }
  function asString(value, where) {
    if (typeof value !== "string") fail(where, "a string", value);
    return value;
  }
  function memberValue(value, name, where) {
    if (value === null || typeof value !== "object") fail(where, "an object", value);
    const member = value[name];
    if (member === void 0) throw new Error(`${where}: member '${name}' is missing.`);
    return member;
  }
  function rawElements(type, value) {
    if (!LITTLE_ENDIAN_HOST || !ArrayBuffer.isView(value) || value instanceof DataView) return null;
    let match = false;
    if (type.kind === "float") {
      match = type.size === 4 ? value instanceof Float32Array : value instanceof Float64Array;
    } else if (type.kind === "int") {
      switch (type.size) {
        case 1:
          match = type.signed ? value instanceof Int8Array : value instanceof Uint8Array;
          break;
        case 2:
          match = type.signed ? value instanceof Int16Array : value instanceof Uint16Array;
          break;
        case 4:
          match = type.signed ? value instanceof Int32Array : value instanceof Uint32Array;
          break;
        case 8:
          match = type.signed ? value instanceof BigInt64Array : value instanceof BigUint64Array;
          break;
      }
    }
    return match ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
  }
  function compileMeasure(type, packer, where) {
    switch (type.kind) {
      case "int":
      case "float":
        return null;
      case "string":
        return (value) => packer.place(utf8.encode(asString(value, where)).length);
      case "vlen": {
        const baseSize = typeInfo(type.base).size;
        return (value) => {
          const count = asArrayLike(value, where).length;
          if (count > 0) packer.place(count * baseSize);
        };
      }
      case "array": {
        const inner = compileMeasure(type.base, packer, `${where}[]`);
        if (!inner) return null;
        return (value) => {
          const items = asArrayLike(value, where);
          for (let i2 = 0; i2 < items.length; i2++) inner(items[i2]);
        };
      }
      case "compound": {
        const parts = [];
        for (const member of type.members) {
          const inner = compileMeasure(member.type, packer, `${where}.${member.name}`);
          if (inner) parts.push([member.name, inner]);
        }
        if (parts.length === 0) return null;
        return (value) => {
          for (const [name, inner] of parts) inner(memberValue(value, name, where));
        };
      }
    }
  }
  function compileEncoder(type, sink, put, where) {
    const { bytes, view } = sink;
    switch (type.kind) {
      case "int": {
        const { size, signed } = type;
        if (size === 8) {
          const min2 = signed ? -(2n ** 63n) : 0n;
          const max3 = signed ? 2n ** 63n - 1n : 2n ** 64n - 1n;
          return (value, at) => {
            const v = typeof value === "bigint" ? value : Number.isSafeInteger(value) ? BigInt(value) : fail(where, "an integer", value);
            if (v < min2 || v > max3) fail(where, `an integer in [${min2}, ${max3}]`, value);
            if (signed) view.setBigInt64(at, v, true);
            else view.setBigUint64(at, v, true);
          };
        }
        const bits2 = 8 * size;
        const min = signed ? -(2 ** (bits2 - 1)) : 0;
        const max2 = signed ? 2 ** (bits2 - 1) - 1 : 2 ** bits2 - 1;
        return (value, at) => {
          if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max2) {
            fail(where, `an integer in [${min}, ${max2}]`, value);
          }
          if (size === 1) view.setUint8(at, value & 255);
          else if (size === 2) view.setUint16(at, value & 65535, true);
          else view.setUint32(at, value >>> 0, true);
        };
      }
      case "float":
        return (value, at) => {
          if (typeof value !== "number") fail(where, "a number", value);
          if (type.size === 4) view.setFloat32(at, value, true);
          else view.setFloat64(at, value, true);
        };
      case "string":
        return (value, at) => {
          const encoded = utf8.encode(asString(value, where));
          const slot = put(encoded.length);
          writeVlenReference(view, at, encoded.length, slot.collectionAddress, slot.index);
          bytes.set(encoded, slot.dataAddress);
        };
      case "vlen": {
        const baseSize = typeInfo(type.base).size;
        const writeItems = compileItems(type.base, sink, put, `${where}[]`);
        return (value, at) => {
          const items = asArrayLike(value, where);
          const count = items.length;
          if (count === 0) return;
          const slot = put(count * baseSize);
          writeVlenReference(view, at, count, slot.collectionAddress, slot.index);
          writeItems(items, slot.dataAddress);
        };
      }
      case "array": {
        const count = type.dims.reduce((product, dim) => product * dim, 1);
        const writeItems = compileItems(type.base, sink, put, `${where}[]`);
        return (value, at) => {
          const items = asArrayLike(value, where);
          if (items.length !== count) fail(where, `${count} values`, `${items.length} values`);
          writeItems(items, at);
        };
      }
      case "compound": {
        const { size } = type;
        const vlen = typeInfo(type).vlen;
        const members = type.members.map((member) => [member.name, member.offset, compileEncoder(member.type, sink, put, `${where}.${member.name}`)]);
        return (value, at) => {
          if (value instanceof Uint8Array && !vlen) {
            if (value.length !== size) fail(where, `${size} pre-encoded bytes`, `${value.length} bytes`);
            bytes.set(value, at);
            return;
          }
          for (const [name, offset, encode] of members) encode(memberValue(value, name, where), at + offset);
        };
      }
    }
  }
  function compileItems(base, sink, put, where) {
    const encode = compileEncoder(base, sink, put, where);
    const step = typeInfo(base).size;
    return (items, at) => {
      const raw = rawElements(base, items);
      if (raw) {
        sink.bytes.set(raw, at);
        return;
      }
      for (let i2 = 0; i2 < items.length; i2++) encode(items[i2], at + i2 * step);
    };
  }
  function writeVlenReference(view, at, count, collectionAddress, index) {
    view.setUint32(at, count, true);
    setU64(view, at + 4, collectionAddress);
    view.setUint32(at + 12, index, true);
  }
  var MSG_DATASPACE = 1;
  var MSG_LINK_INFO = 2;
  var MSG_DATATYPE = 3;
  var MSG_FILL_VALUE = 5;
  var MSG_LINK = 6;
  var MSG_LAYOUT = 8;
  var MSG_GROUP_INFO = 10;
  var MSG_FLAG_CONSTANT = 1;
  function chunkSize(messages) {
    let size = 0;
    for (const message of messages) {
      if (message.body.length > 65535) throw new Error(`A ${message.body.length}-byte header message is too large for HDF5.`);
      size += 4 + message.body.length;
    }
    return size;
  }
  var chunkWidthCode = (size) => size <= 255 ? 0 : size <= 65535 ? 1 : 2;
  function objectHeaderSize(messages) {
    const size = chunkSize(messages);
    return 4 + 1 + 1 + (1 << chunkWidthCode(size)) + size + 4;
  }
  function writeObjectHeader(sink, at, messages) {
    const { bytes, view } = sink;
    const size = chunkSize(messages);
    const code = chunkWidthCode(size);
    let p = at;
    bytes.set([79, 72, 68, 82], p);
    bytes[p + 4] = 2;
    bytes[p + 5] = code;
    p += 6;
    if (code === 0) view.setUint8(p, size);
    else if (code === 1) view.setUint16(p, size, true);
    else view.setUint32(p, size, true);
    p += 1 << code;
    for (const message of messages) {
      bytes[p] = message.type;
      view.setUint16(p + 1, message.body.length, true);
      bytes[p + 3] = message.flags;
      bytes.set(message.body, p + 4);
      p += 4 + message.body.length;
    }
    view.setUint32(p, lookup3(bytes.subarray(at, p)), true);
  }
  function groupMessages(group) {
    const linkInfo = new ByteList().u8(0).u8(0).u64(UNDEFINED_ADDRESS).u64(UNDEFINED_ADDRESS).result();
    const messages = [
      { type: MSG_LINK_INFO, flags: 0, body: linkInfo },
      { type: MSG_GROUP_INFO, flags: MSG_FLAG_CONSTANT, body: Uint8Array.of(0, 0) }
    ];
    for (const [name, child] of group.children) {
      const encoded = utf8.encode(name);
      const ascii = encoded.every((byte) => byte < 128);
      const code = encoded.length <= 255 ? 0 : encoded.length <= 65535 ? 1 : 2;
      const link = new ByteList().u8(1).u8(code | (ascii ? 0 : 16));
      if (!ascii) link.u8(1);
      link.uint(encoded.length, 1 << code).bytes(encoded).u64(child.address);
      messages.push({ type: MSG_LINK, flags: 0, body: link.result() });
    }
    return messages;
  }
  function datasetMessages(dataset) {
    const space = new ByteList().u8(2).u8(dataset.dims.length).u8(0).u8(dataset.dims.length === 0 ? 0 : 1);
    for (const dim of dataset.dims) space.u64(dim);
    const datatype = new ByteList();
    encodeDatatype(dataset.type, datatype);
    const fill = Uint8Array.of(3, dataset.vlen ? 2 : 10);
    const layout2 = new ByteList().u8(3).u8(1).u64(dataset.dataAddress).u64(dataset.count * dataset.elementSize);
    return [
      { type: MSG_DATASPACE, flags: 0, body: space.result() },
      { type: MSG_DATATYPE, flags: MSG_FLAG_CONSTANT, body: datatype.result() },
      { type: MSG_FILL_VALUE, flags: MSG_FLAG_CONSTANT, body: fill },
      { type: MSG_LAYOUT, flags: 0, body: layout2.result() }
    ];
  }
  var messagesOf = (node) => node.kind === "group" ? groupMessages(node) : datasetMessages(node);
  var SUPERBLOCK_SIZE = 48;
  function splitPath(path) {
    const parts = path.split("/").filter((part) => part.length > 0);
    for (const part of parts) {
      if (part === "." || part.includes("\0")) throw new Error(`Invalid HDF5 path '${path}'.`);
    }
    return parts;
  }
  var Hdf5Writer = class {
    constructor() {
      __publicField(this, "root", { kind: "group", children: /* @__PURE__ */ new Map(), address: 0 });
      __publicField(this, "finished", false);
    }
    /** Creates a group and any missing parents; an existing group is left as it is. */
    group(path) {
      this.checkOpen();
      this.groupAt(splitPath(path), path);
      return this;
    }
    /**
     * Adds a dataset (and any missing parent groups). `elements` holds the
     * product of `dims` values in row-major order (one value when `dims` is
     * empty, a scalar). The writer keeps the reference and encodes at
     * finish(), so `elements` must not change before then.
     */
    dataset(path, type, dims, elements) {
      this.checkOpen();
      const parts = splitPath(path);
      if (parts.length === 0) throw new Error("A dataset needs a name.");
      const name = parts[parts.length - 1];
      const parent = this.groupAt(parts.slice(0, -1), path);
      if (parent.children.has(name)) throw new Error(`'${path}' already exists.`);
      const info = typeInfo(type);
      let count = 1;
      for (const dim of dims) {
        if (!Number.isSafeInteger(dim) || dim < 0) throw new Error(`Dataset dimensions must be non-negative integers, got ${dim}.`);
        count *= dim;
      }
      if (!Number.isSafeInteger(count * info.size)) throw new Error(`Dataset '${path}' is too large.`);
      if (elements.length !== count) throw new Error(`Dataset '${path}' has ${elements.length} elements for dimensions [${dims.join(", ")}].`);
      parent.children.set(name, {
        kind: "dataset",
        path: `/${parts.join("/")}`,
        type,
        dims: [...dims],
        elements,
        count,
        elementSize: info.size,
        vlen: info.vlen,
        address: 0,
        dataAddress: UNDEFINED_ADDRESS
      });
      return this;
    }
    /** Lays out and encodes the file. The writer cannot be used afterwards. */
    finish() {
      this.checkOpen();
      this.finished = true;
      const nodes = [];
      const visit = (node) => {
        nodes.push(node);
        if (node.kind === "group") for (const child of node.children.values()) visit(child);
      };
      visit(this.root);
      const datasets = nodes.filter((node) => node.kind === "dataset");
      const measured = new HeapPacker();
      for (const dataset of datasets) {
        const measure = dataset.vlen ? compileMeasure(dataset.type, measured, dataset.path) : null;
        if (measure) forEachElement(dataset, measure);
      }
      let end = SUPERBLOCK_SIZE;
      for (const node of nodes) {
        node.address = end;
        end += objectHeaderSize(messagesOf(node));
      }
      for (const dataset of datasets) {
        const size = dataset.count * dataset.elementSize;
        dataset.dataAddress = size > 0 ? end : UNDEFINED_ADDRESS;
        end += size;
      }
      const collections = measured.used.map((used) => {
        const address = end;
        end += collectionSize(used);
        return address;
      });
      if (!Number.isSafeInteger(end)) throw new Error("The HDF5 file would be too large.");
      const bytes = new Uint8Array(end);
      const sink = { bytes, view: new DataView(bytes.buffer) };
      const packer = new HeapPacker();
      const slot = { collectionAddress: 0, index: 0, dataAddress: 0 };
      const put = (size) => {
        packer.place(size);
        const collectionAddress = collections[packer.collection];
        if (collectionAddress === void 0 || packer.used[packer.collection] > measured.used[packer.collection]) {
          throw new Error("Variable-length data changed while the HDF5 file was being written.");
        }
        const at = collectionAddress + packer.offset;
        sink.view.setUint16(at, packer.index, true);
        setU64(sink.view, at + 8, size);
        slot.collectionAddress = collectionAddress;
        slot.index = packer.index;
        slot.dataAddress = at + HEAP_OBJECT_HEADER_SIZE;
        return slot;
      };
      for (const dataset of datasets) {
        if (dataset.count === 0) continue;
        const raw = rawElements(dataset.type, dataset.elements);
        if (raw) {
          bytes.set(raw, dataset.dataAddress);
          continue;
        }
        const encode = compileEncoder(dataset.type, sink, put, dataset.path);
        const { dataAddress, elementSize } = dataset;
        forEachElement(dataset, (value, i2) => encode(value, dataAddress + i2 * elementSize));
      }
      if (packer.used.length !== measured.used.length || packer.used.some((used, k) => used !== measured.used[k])) {
        throw new Error("Variable-length data changed while the HDF5 file was being written.");
      }
      for (const [k, address] of collections.entries()) writeCollectionHeader(sink, address, measured.used[k]);
      for (const node of nodes) writeObjectHeader(sink, node.address, messagesOf(node));
      writeSuperblock(sink, this.root.address, end);
      return bytes;
    }
    checkOpen() {
      if (this.finished) throw new Error("This HDF5 writer has already finished.");
    }
    groupAt(parts, path) {
      let group = this.root;
      for (const part of parts) {
        let child = group.children.get(part);
        if (!child) {
          child = { kind: "group", children: /* @__PURE__ */ new Map(), address: 0 };
          group.children.set(part, child);
        }
        if (child.kind !== "group") throw new Error(`'${part}' in '${path}' is a dataset, not a group.`);
        group = child;
      }
      return group;
    }
  };
  function forEachElement(dataset, visit) {
    const { elements, count } = dataset;
    let i2 = 0;
    try {
      for (; i2 < count; i2++) visit(elements[i2], i2);
    } catch (error) {
      throw new Error(`Dataset ${dataset.path}, element ${i2}: ${error.message}`);
    }
  }
  function writeCollectionHeader(sink, at, used) {
    const { bytes, view } = sink;
    const size = collectionSize(used);
    bytes.set([71, 67, 79, 76], at);
    bytes[at + 4] = 1;
    setU64(view, at + 8, size);
    const free = size - used;
    if (free >= HEAP_OBJECT_HEADER_SIZE) setU64(view, at + used + 8, free);
  }
  function writeSuperblock(sink, rootAddress, endOfFile) {
    const { bytes, view } = sink;
    bytes.set([137, 72, 68, 70, 13, 10, 26, 10], 0);
    bytes[8] = 2;
    bytes[9] = 8;
    bytes[10] = 8;
    bytes[11] = 0;
    setU64(view, 12, 0);
    setU64(view, 20, UNDEFINED_ADDRESS);
    setU64(view, 28, endOfFile);
    setU64(view, 36, rootAddress);
    view.setUint32(44, lookup3(bytes.subarray(0, 44)), true);
  }

  // src/sim/io/ismrmrd.ts
  var ACQUISITION_HEADER_SIZE = 340;
  var IsmrmrdAcqFlag = Object.freeze({
    FIRST_IN_ENCODE_STEP1: 1,
    LAST_IN_ENCODE_STEP1: 2,
    FIRST_IN_ENCODE_STEP2: 3,
    LAST_IN_ENCODE_STEP2: 4,
    FIRST_IN_AVERAGE: 5,
    LAST_IN_AVERAGE: 6,
    FIRST_IN_SLICE: 7,
    LAST_IN_SLICE: 8,
    FIRST_IN_CONTRAST: 9,
    LAST_IN_CONTRAST: 10,
    FIRST_IN_PHASE: 11,
    LAST_IN_PHASE: 12,
    FIRST_IN_REPETITION: 13,
    LAST_IN_REPETITION: 14,
    FIRST_IN_SET: 15,
    LAST_IN_SET: 16,
    FIRST_IN_SEGMENT: 17,
    LAST_IN_SEGMENT: 18,
    IS_NOISE_MEASUREMENT: 19,
    IS_PARALLEL_CALIBRATION: 20,
    IS_PARALLEL_CALIBRATION_AND_IMAGING: 21,
    IS_REVERSE: 22,
    IS_NAVIGATION_DATA: 23,
    IS_PHASECORR_DATA: 24,
    LAST_IN_MEASUREMENT: 25,
    IS_HPFEEDBACK_DATA: 26,
    IS_DUMMYSCAN_DATA: 27,
    IS_RTFEEDBACK_DATA: 28,
    IS_SURFACECOILCORRECTIONSCAN_DATA: 29,
    IS_PHASE_STABILIZATION_REFERENCE: 30,
    IS_PHASE_STABILIZATION: 31,
    COMPRESSION1: 53,
    COMPRESSION2: 54,
    COMPRESSION3: 55,
    COMPRESSION4: 56,
    USER1: 57,
    USER2: 58,
    USER3: 59,
    USER4: 60,
    USER5: 61,
    USER6: 62,
    USER7: 63,
    USER8: 64
  });
  function flagBit(bit) {
    if (!Number.isInteger(bit) || bit < 1 || bit > 64) throw new RangeError(`Acquisition flag bits are 1 to 64, got ${bit}.`);
    return 1n << BigInt(bit - 1);
  }
  function acquisitionFlags(...bits2) {
    let flags = 0n;
    for (const bit of bits2) flags |= flagBit(bit);
    return flags;
  }
  function channelMask(channels) {
    if (!Number.isInteger(channels) || channels < 0 || channels > 1024) throw new RangeError(`ISMRMRD supports 0 to 1024 channels, got ${channels}.`);
    const mask = new Array(16).fill(0n);
    for (let c = 0; c < channels; c++) mask[c >> 6] |= 1n << BigInt(c & 63);
    return mask;
  }
  function acquisitionHeader(init = {}) {
    const active = init.active_channels ?? 1;
    const zeros = (n) => new Array(n).fill(0);
    const head = {
      version: 1,
      flags: 0n,
      measurement_uid: 0,
      scan_counter: 0,
      acquisition_time_stamp: 0,
      physiology_time_stamp: zeros(3),
      number_of_samples: 0,
      available_channels: active,
      active_channels: active,
      channel_mask: channelMask(active),
      discard_pre: 0,
      discard_post: 0,
      center_sample: 0,
      encoding_space_ref: 0,
      trajectory_dimensions: 0,
      sample_time_us: 0,
      position: zeros(3),
      read_dir: zeros(3),
      phase_dir: zeros(3),
      slice_dir: zeros(3),
      patient_table_position: zeros(3),
      idx: {
        kspace_encode_step_1: 0,
        kspace_encode_step_2: 0,
        average: 0,
        slice: 0,
        contrast: 0,
        phase: 0,
        repetition: 0,
        set: 0,
        segment: 0,
        user: zeros(8)
      },
      user_int: zeros(8),
      user_float: zeros(8)
    };
    const assign = (target, values, where) => {
      for (const [key, value] of Object.entries(values)) {
        if (value === void 0) continue;
        if (!(key in target)) throw new Error(`Unknown acquisition header field '${where}${key}'.`);
        target[key] = value;
      }
    };
    const { idx, ...fields } = init;
    assign(head, fields, "");
    assign(head.idx, idx ?? {}, "idx.");
    return head;
  }
  var StructWriter = class {
    constructor(view, start) {
      __publicField(this, "view", view);
      __publicField(this, "start", start);
      __publicField(this, "offset");
      __publicField(this, "u16", (name, value) => {
        this.view.setUint16(this.offset, this.integer(name, value, 0, 65535), true);
        this.offset += 2;
      });
      __publicField(this, "u32", (name, value) => {
        this.view.setUint32(this.offset, this.integer(name, value, 0, 4294967295), true);
        this.offset += 4;
      });
      __publicField(this, "i32", (name, value) => {
        this.view.setInt32(this.offset, this.integer(name, value, -2147483648, 2147483647), true);
        this.offset += 4;
      });
      __publicField(this, "u64", (name, value) => {
        if (typeof value !== "bigint" || value < 0n || value >= 1n << 64n) {
          throw new RangeError(`${name} must be a bigint in [0, 2^64), got ${String(value)}.`);
        }
        this.view.setBigUint64(this.offset, value, true);
        this.offset += 8;
      });
      __publicField(this, "f32", (name, value) => {
        if (typeof value !== "number") throw new RangeError(`${name} must be a number, got ${String(value)}.`);
        this.view.setFloat32(this.offset, value, true);
        this.offset += 4;
      });
      this.offset = start;
    }
    integer(name, value, min, max2) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max2) {
        throw new RangeError(`${name} must be an integer in [${min}, ${max2}], got ${String(value)}.`);
      }
      return value;
    }
    each(name, values, count, write) {
      if (!values || values.length !== count) throw new RangeError(`${name} must have ${count} values, got ${values?.length}.`);
      for (let i2 = 0; i2 < count; i2++) write(`${name}[${i2}]`, values[i2]);
    }
    end(size) {
      if (this.offset - this.start !== size) throw new Error(`Wrote ${this.offset - this.start} bytes of a ${size}-byte struct.`);
    }
  };
  function writeAcquisitionHeader(head, view, at) {
    const w = new StructWriter(view, at);
    w.u16("version", head.version);
    w.u64("flags", head.flags);
    w.u32("measurement_uid", head.measurement_uid);
    w.u32("scan_counter", head.scan_counter);
    w.u32("acquisition_time_stamp", head.acquisition_time_stamp);
    w.each("physiology_time_stamp", head.physiology_time_stamp, 3, w.u32);
    w.u16("number_of_samples", head.number_of_samples);
    w.u16("available_channels", head.available_channels);
    w.u16("active_channels", head.active_channels);
    w.each("channel_mask", head.channel_mask, 16, w.u64);
    w.u16("discard_pre", head.discard_pre);
    w.u16("discard_post", head.discard_post);
    w.u16("center_sample", head.center_sample);
    w.u16("encoding_space_ref", head.encoding_space_ref);
    w.u16("trajectory_dimensions", head.trajectory_dimensions);
    w.f32("sample_time_us", head.sample_time_us);
    w.each("position", head.position, 3, w.f32);
    w.each("read_dir", head.read_dir, 3, w.f32);
    w.each("phase_dir", head.phase_dir, 3, w.f32);
    w.each("slice_dir", head.slice_dir, 3, w.f32);
    w.each("patient_table_position", head.patient_table_position, 3, w.f32);
    const idx = head.idx;
    w.u16("idx.kspace_encode_step_1", idx.kspace_encode_step_1);
    w.u16("idx.kspace_encode_step_2", idx.kspace_encode_step_2);
    w.u16("idx.average", idx.average);
    w.u16("idx.slice", idx.slice);
    w.u16("idx.contrast", idx.contrast);
    w.u16("idx.phase", idx.phase);
    w.u16("idx.repetition", idx.repetition);
    w.u16("idx.set", idx.set);
    w.u16("idx.segment", idx.segment);
    w.each("idx.user", idx.user, 8, w.u16);
    w.each("user_int", head.user_int, 8, w.i32);
    w.each("user_float", head.user_float, 8, w.f32);
    w.end(ACQUISITION_HEADER_SIZE);
  }
  function checkShapes(acquisition, index) {
    const { head, traj, data } = acquisition;
    const samples = head.number_of_samples;
    if (traj.length !== samples * head.trajectory_dimensions) {
      throw new RangeError(`Acquisition ${index}: traj has ${traj.length} values, but number_of_samples \xD7 trajectory_dimensions is ${samples} \xD7 ${head.trajectory_dimensions}.`);
    }
    if (data.length !== 2 * samples * head.active_channels) {
      throw new RangeError(`Acquisition ${index}: data has ${data.length} values, but 2 \xD7 active_channels \xD7 number_of_samples is 2 \xD7 ${head.active_channels} \xD7 ${samples}.`);
    }
  }
  function withIndex(index, run) {
    try {
      return run();
    } catch (error) {
      throw new RangeError(`Acquisition ${index}: ${error.message}`);
    }
  }
  var ENCODING_COUNTERS_HDF5_TYPE = h5t.compound([
    ["kspace_encode_step_1", h5t.u16],
    ["kspace_encode_step_2", h5t.u16],
    ["average", h5t.u16],
    ["slice", h5t.u16],
    ["contrast", h5t.u16],
    ["phase", h5t.u16],
    ["repetition", h5t.u16],
    ["set", h5t.u16],
    ["segment", h5t.u16],
    ["user", h5t.array(h5t.u16, [8])]
  ]);
  var ACQUISITION_HEADER_HDF5_TYPE = h5t.compound([
    ["version", h5t.u16],
    ["flags", h5t.u64],
    ["measurement_uid", h5t.u32],
    ["scan_counter", h5t.u32],
    ["acquisition_time_stamp", h5t.u32],
    ["physiology_time_stamp", h5t.array(h5t.u32, [3])],
    ["number_of_samples", h5t.u16],
    ["available_channels", h5t.u16],
    ["active_channels", h5t.u16],
    ["channel_mask", h5t.array(h5t.u64, [16])],
    ["discard_pre", h5t.u16],
    ["discard_post", h5t.u16],
    ["center_sample", h5t.u16],
    ["encoding_space_ref", h5t.u16],
    ["trajectory_dimensions", h5t.u16],
    ["sample_time_us", h5t.f32],
    ["position", h5t.array(h5t.f32, [3])],
    ["read_dir", h5t.array(h5t.f32, [3])],
    ["phase_dir", h5t.array(h5t.f32, [3])],
    ["slice_dir", h5t.array(h5t.f32, [3])],
    ["patient_table_position", h5t.array(h5t.f32, [3])],
    ["idx", ENCODING_COUNTERS_HDF5_TYPE],
    ["user_int", h5t.array(h5t.i32, [8])],
    ["user_float", h5t.array(h5t.f32, [8])]
  ]);
  var ACQUISITION_HDF5_TYPE = h5t.compound([
    ["head", ACQUISITION_HEADER_HDF5_TYPE],
    ["traj", h5t.vlen(h5t.f32)],
    ["data", h5t.vlen(h5t.f32)]
  ]);
  function writeIsmrmrdHdf5(xmlHeader, acquisitions, options = {}) {
    const group = options.datasetName ?? "dataset";
    if (!group || group === "." || group.includes("/") || group.includes("\0")) {
      throw new Error(`Invalid ISMRMRD dataset name '${group}'.`);
    }
    const heads = new Uint8Array(acquisitions.length * ACQUISITION_HEADER_SIZE);
    const view = new DataView(heads.buffer);
    const rows = acquisitions.map((acquisition, i2) => {
      checkShapes(acquisition, i2);
      const at = i2 * ACQUISITION_HEADER_SIZE;
      withIndex(i2, () => writeAcquisitionHeader(acquisition.head, view, at));
      return { head: heads.subarray(at, at + ACQUISITION_HEADER_SIZE), traj: acquisition.traj, data: acquisition.data };
    });
    return new Hdf5Writer().dataset(`/${group}/xml`, h5t.string("ascii"), [1], [xmlHeader]).dataset(`/${group}/data`, ACQUISITION_HDF5_TYPE, [rows.length], rows).finish();
  }
  var IsmrmrdMessageId = Object.freeze({
    CONFIG_FILE: 1,
    CONFIG_TEXT: 2,
    HEADER: 3,
    CLOSE: 4,
    TEXT: 5,
    ACQUISITION: 1008,
    IMAGE: 1022,
    WAVEFORM: 1026,
    NDARRAY: 1030
  });
  var LITTLE_ENDIAN_HOST2 = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  var utf82 = new TextEncoder();
  function writeFloat32s(bytes, view, at, values) {
    if (LITTLE_ENDIAN_HOST2 && values instanceof Float32Array) {
      bytes.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), at);
    } else {
      for (let i2 = 0; i2 < values.length; i2++) view.setFloat32(at + 4 * i2, values[i2], true);
    }
    return at + 4 * values.length;
  }
  function writeIsmrmrdStream(xmlHeader, acquisitions) {
    const xml = utf82.encode(xmlHeader);
    let size = 2 + 4 + xml.length + 2;
    for (const [i2, acquisition] of acquisitions.entries()) {
      checkShapes(acquisition, i2);
      size += 2 + ACQUISITION_HEADER_SIZE + 4 * (acquisition.traj.length + acquisition.data.length);
    }
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, IsmrmrdMessageId.HEADER, true);
    view.setUint32(2, xml.length, true);
    bytes.set(xml, 6);
    let at = 6 + xml.length;
    for (const [i2, acquisition] of acquisitions.entries()) {
      view.setUint16(at, IsmrmrdMessageId.ACQUISITION, true);
      withIndex(i2, () => writeAcquisitionHeader(acquisition.head, view, at + 2));
      at = writeFloat32s(bytes, view, at + 2 + ACQUISITION_HEADER_SIZE, acquisition.traj);
      at = writeFloat32s(bytes, view, at, acquisition.data);
    }
    view.setUint16(at, IsmrmrdMessageId.CLOSE, true);
    return bytes;
  }
  var ISMRMRD_NAMESPACE = "http://www.ismrm.org/ISMRMRD";
  var TRAJECTORIES = ["cartesian", "epi", "radial", "goldenangle", "spiral", "other"];
  var PATIENT_POSITIONS = ["HFP", "HFS", "HFDR", "HFDL", "FFP", "FFS", "FFDR", "FFDL"];
  var LIMIT_NAMES = [
    "kspace_encoding_step_0",
    "kspace_encoding_step_1",
    "kspace_encoding_step_2",
    "average",
    "slice",
    "contrast",
    "phase",
    "repetition",
    "set",
    "segment",
    "user_0",
    "user_1",
    "user_2",
    "user_3",
    "user_4",
    "user_5",
    "user_6",
    "user_7"
  ];
  var XML_ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
  function escapeXml(text2) {
    let out = "";
    for (const char of text2) {
      const code = char.codePointAt(0);
      if (XML_ENTITIES[char]) out += XML_ENTITIES[char];
      else if (code >= 32 && code < 127) out += char;
      else if (code === 9 || code === 10 || code === 13) out += char;
      else if (code < 32 || code >= 55296 && code <= 57343 || code === 65534 || code === 65535) out += "&#xFFFD;";
      else out += `&#x${code.toString(16).toUpperCase()};`;
    }
    return out;
  }
  function xsFloat(value, name) {
    if (typeof value !== "number") throw new RangeError(`${name} must be a number, got ${String(value)}.`);
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return value > 0 ? "INF" : "-INF";
    return String(value);
  }
  function xsLong(value, name) {
    if (typeof value === "bigint") {
      if (value < -(2n ** 63n) || value >= 2n ** 63n) throw new RangeError(`${name} does not fit xs:long: ${value}.`);
      return String(value);
    }
    if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be an integer, got ${String(value)}.`);
    return String(value);
  }
  function unsignedShort(value, name) {
    if (!Number.isInteger(value) || value < 0 || value > 65535) throw new RangeError(`${name} must be an integer in [0, 65535], got ${String(value)}.`);
    return String(value);
  }
  function oneOf(value, allowed, name) {
    if (!allowed.includes(value)) throw new RangeError(`${name} must be one of ${allowed.join(", ")}, got '${value}'.`);
    return value;
  }
  var XmlWriter = class {
    constructor() {
      __publicField(this, "lines", ['<?xml version="1.0" encoding="UTF-8"?>']);
      __publicField(this, "open", []);
    }
    start(name, attributes = "") {
      this.lines.push(`${"  ".repeat(this.open.length)}<${name}${attributes}>`);
      this.open.push(name);
    }
    end() {
      const name = this.open.pop();
      this.lines.push(`${"  ".repeat(this.open.length)}</${name}>`);
    }
    leaf(name, text2) {
      this.lines.push(`${"  ".repeat(this.open.length)}<${name}>${escapeXml(text2)}</${name}>`);
    }
    xyz(name, value, format) {
      this.start(name);
      for (const axis of ["x", "y", "z"]) this.leaf(axis, format(value[axis], `${name}.${axis}`));
      this.end();
    }
    toString() {
      return `${this.lines.join("\n")}
`;
    }
  };
  function buildIsmrmrdHeaderXml(info) {
    const xml = new XmlWriter();
    xml.start("ismrmrdHeader", ` xmlns="${ISMRMRD_NAMESPACE}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xs="http://www.w3.org/2001/XMLSchema" xsi:schemaLocation="${ISMRMRD_NAMESPACE} ismrmrd.xsd"`);
    const measurement = info.measurementInformation;
    if (measurement) {
      xml.start("measurementInformation");
      xml.leaf("patientPosition", oneOf(measurement.patientPosition ?? "HFS", PATIENT_POSITIONS, "patientPosition"));
      if (measurement.protocolName !== void 0) xml.leaf("protocolName", measurement.protocolName);
      xml.end();
    }
    const system = info.acquisitionSystemInformation ?? {};
    xml.start("acquisitionSystemInformation");
    if (system.systemVendor !== void 0) xml.leaf("systemVendor", system.systemVendor);
    if (system.systemModel !== void 0) xml.leaf("systemModel", system.systemModel);
    if (info.systemFieldStrength_T !== void 0) xml.leaf("systemFieldStrength_T", xsFloat(info.systemFieldStrength_T, "systemFieldStrength_T"));
    xml.leaf("receiverChannels", unsignedShort(info.receiverChannels, "receiverChannels"));
    xml.end();
    if (!Number.isFinite(info.H1resonanceFrequency_Hz)) {
      throw new RangeError(`H1resonanceFrequency_Hz must be finite, got ${info.H1resonanceFrequency_Hz}.`);
    }
    xml.start("experimentalConditions");
    xml.leaf("H1resonanceFrequency_Hz", xsLong(Math.round(info.H1resonanceFrequency_Hz), "H1resonanceFrequency_Hz"));
    xml.end();
    xml.start("encoding");
    for (const [name, space] of [["encodedSpace", info.encodedSpace], ["reconSpace", info.reconSpace ?? info.encodedSpace]]) {
      xml.start(name);
      xml.xyz("matrixSize", space.matrixSize, unsignedShort);
      xml.xyz("fieldOfView_mm", space.fieldOfView_mm, xsFloat);
      xml.end();
    }
    xml.start("encodingLimits");
    for (const name of LIMIT_NAMES) {
      const limit = info.encodingLimits[name];
      if (!limit) continue;
      xml.start(name);
      xml.leaf("minimum", unsignedShort(limit.minimum, `${name}.minimum`));
      xml.leaf("maximum", unsignedShort(limit.maximum, `${name}.maximum`));
      xml.leaf("center", unsignedShort(limit.center, `${name}.center`));
      xml.end();
    }
    xml.end();
    xml.leaf("trajectory", oneOf(info.trajectory, TRAJECTORIES, "trajectory"));
    xml.end();
    const sequence = info.sequenceParameters;
    if (sequence && Object.values(sequence).some((value) => value !== void 0 && !(Array.isArray(value) && value.length === 0))) {
      xml.start("sequenceParameters");
      for (const name of ["TR", "TE", "TI", "flipAngle_deg"]) {
        for (const value of sequence[name] ?? []) xml.leaf(name, xsFloat(value, name));
      }
      if (sequence.sequence_type !== void 0) xml.leaf("sequence_type", sequence.sequence_type);
      for (const value of sequence.echo_spacing ?? []) xml.leaf("echo_spacing", xsFloat(value, "echo_spacing"));
      xml.end();
    }
    const user = info.userParameters;
    const longs = user?.userParameterLong ?? [];
    const doubles = user?.userParameterDouble ?? [];
    const strings = user?.userParameterString ?? [];
    if (longs.length + doubles.length + strings.length > 0) {
      xml.start("userParameters");
      const parameter = (element, name, value) => {
        xml.start(element);
        xml.leaf("name", name);
        xml.leaf("value", value);
        xml.end();
      };
      for (const p of longs) parameter("userParameterLong", p.name, xsLong(p.value, `userParameterLong '${p.name}'`));
      for (const p of doubles) parameter("userParameterDouble", p.name, xsFloat(p.value, `userParameterDouble '${p.name}'`));
      for (const p of strings) parameter("userParameterString", p.name, p.value);
      xml.end();
    }
    xml.end();
    return xml.toString();
  }

  // src/sim/io/exportPlan.ts
  var ACQ_FLAG_BITS = IsmrmrdAcqFlag;
  var COUNTERS = [
    "kspace_encode_step_1",
    "kspace_encode_step_2",
    "average",
    "slice",
    "contrast",
    "phase",
    "repetition",
    "set",
    "segment"
  ];
  var LABEL_OF = {
    kspace_encode_step_1: "LIN",
    kspace_encode_step_2: "PAR",
    average: "AVG",
    slice: "SLC",
    contrast: "ECO",
    phase: "PHS",
    repetition: "REP",
    set: "SET",
    segment: "SEG"
  };
  function planExport(layout2, grid) {
    const names = layout2.labels.names;
    const width = names.length;
    const column = (name) => names.indexOf(name);
    const label = (a, name) => {
      const c = column(name);
      return c >= 0 ? layout2.labels.values[a * width + c] : 0;
    };
    const has = (name) => column(name) >= 0;
    const raw = [];
    const labelled = COUNTERS.filter((counter) => has(LABEL_OF[counter]));
    for (let a = 0; a < layout2.acquisitions; a++) {
      const values = {};
      for (const counter of COUNTERS) values[counter] = label(a, LABEL_OF[counter]);
      if (!has("LIN") && grid.delta) values.kspace_encode_step_1 = gridLine(layout2, a, grid);
      if (!has("PAR") && grid.delta && partitioned(grid)) values.kspace_encode_step_2 = gridPartition(layout2, a, grid);
      raw.push(values);
    }
    const counterOffsets = {};
    const limits = {};
    for (const counter of COUNTERS) {
      let min = Infinity, max2 = -Infinity;
      for (const values of raw) {
        min = Math.min(min, values[counter]);
        max2 = Math.max(max2, values[counter]);
      }
      if (!raw.length) min = max2 = 0;
      counterOffsets[counter] = min;
      const span = max2 - min;
      if (span > 65535) throw new Error(`The ${counter} counter spans ${span + 1} values, more than ISMRMRD's 16 bits hold.`);
      const center = counter === "kspace_encode_step_1" && !has("LIN") && grid.delta ? Math.round(grid.nv / 2) - min : counter === "kspace_encode_step_2" && !has("PAR") && grid.delta && partitioned(grid) ? Math.round(grid.nw / 2) - min : Math.floor(span / 2);
      limits[counter] = { minimum: 0, maximum: span, center: Math.max(0, Math.min(span, center)) };
    }
    const acquisitions = raw.map((values, a) => {
      const idx = {};
      for (const counter of COUNTERS) idx[counter] = values[counter] - counterOffsets[counter];
      const flags = [];
      if (label(a, "NAV")) flags.push(ACQ_FLAG_BITS.IS_NAVIGATION_DATA);
      if (label(a, "NOISE")) flags.push(ACQ_FLAG_BITS.IS_NOISE_MEASUREMENT);
      if (label(a, "REF")) flags.push(label(a, "IMA") ? ACQ_FLAG_BITS.IS_PARALLEL_CALIBRATION_AND_IMAGING : ACQ_FLAG_BITS.IS_PARALLEL_CALIBRATION);
      if (label(a, "REV") || grid.delta && reversedReadout(layout2, a)) flags.push(ACQ_FLAG_BITS.IS_REVERSE);
      return { idx, flags, centerSample: centerSample(layout2, a) };
    });
    markBoundaries(acquisitions);
    if (acquisitions.length) acquisitions[acquisitions.length - 1].flags.push(ACQ_FLAG_BITS.LAST_IN_MEASUREMENT);
    return { acquisitions, counterOffsets, limits, labelled };
  }
  function markBoundaries(acquisitions) {
    const groups = [
      [ACQ_FLAG_BITS.FIRST_IN_SLICE, (p) => `${p.idx.slice}|${p.idx.repetition}|${p.idx.contrast}|${p.idx.set}`],
      [ACQ_FLAG_BITS.FIRST_IN_REPETITION, (p) => `${p.idx.repetition}`]
    ];
    for (const [firstBit, key] of groups) {
      const first = /* @__PURE__ */ new Map(), last = /* @__PURE__ */ new Map();
      acquisitions.forEach((p, a) => {
        const k = key(p);
        if (!first.has(k)) first.set(k, a);
        last.set(k, a);
      });
      for (const a of first.values()) acquisitions[a].flags.push(firstBit);
      for (const a of last.values()) acquisitions[a].flags.push(firstBit + 1);
    }
    const byGroup = /* @__PURE__ */ new Map();
    acquisitions.forEach((p, a) => {
      const k = `${p.idx.slice}|${p.idx.repetition}|${p.idx.contrast}|${p.idx.set}|${p.idx.kspace_encode_step_2}`;
      const line = p.idx.kspace_encode_step_1;
      let g = byGroup.get(k);
      if (!g) byGroup.set(k, g = { min: line, max: line, first: [], last: [] });
      if (line < g.min) {
        g.min = line;
        g.first = [];
      }
      if (line > g.max) {
        g.max = line;
        g.last = [];
      }
      if (line === g.min) g.first.push(a);
      if (line === g.max) g.last.push(a);
    });
    for (const g of byGroup.values()) {
      if (g.first.length) acquisitions[g.first[0]].flags.push(ACQ_FLAG_BITS.FIRST_IN_ENCODE_STEP1);
      if (g.last.length) acquisitions[g.last[g.last.length - 1]].flags.push(ACQ_FLAG_BITS.LAST_IN_ENCODE_STEP1);
    }
  }
  function centerSample(layout2, a) {
    const offset = layout2.offsets[a], n = layout2.samples[a];
    let best = Math.floor(n / 2), bestNorm = Infinity;
    for (let s = 0; s < n; s++) {
      const i2 = 3 * (offset + s);
      const norm3 = layout2.k[i2] ** 2 + layout2.k[i2 + 1] ** 2 + layout2.k[i2 + 2] ** 2;
      if (norm3 < bestNorm - 1e-12) {
        bestNorm = norm3;
        best = s;
      }
    }
    return best;
  }
  function reversedReadout(layout2, a) {
    const n = layout2.samples[a];
    if (n < 2) return false;
    const first = 3 * layout2.offsets[a], last = 3 * (layout2.offsets[a] + n - 1);
    let span = 0;
    for (let d = 0; d < 3; d++) {
      const delta = layout2.k[last + d] - layout2.k[first + d];
      if (Math.abs(delta) > Math.abs(span)) span = delta;
    }
    return span < 0;
  }
  function gridLine(layout2, a, grid) {
    const centre = 3 * (layout2.offsets[a] + (layout2.samples[a] >> 1));
    const kv = layout2.k[centre + grid.axes[1]];
    return Math.round(kv / grid.delta[1] - grid.offset[1]) + (grid.nv >> 1);
  }
  function partitioned(grid) {
    return grid.wAxis !== void 0 && grid.wAxis >= 0 && (grid.nw ?? 1) > 1 && (grid.deltaW ?? 0) > 0;
  }
  function gridPartition(layout2, a, grid) {
    const centre = 3 * (layout2.offsets[a] + (layout2.samples[a] >> 1));
    const kw = layout2.k[centre + grid.wAxis];
    return Math.round(kw / grid.deltaW - (grid.offsetW ?? 0)) + (grid.nw >> 1);
  }
  function normalisedTrajectory(layout2, a, kmax, axes) {
    const n = layout2.samples[a];
    const out = new Float32Array(n * axes.length);
    for (let s = 0; s < n; s++) {
      for (let d = 0; d < axes.length; d++) {
        const axis = axes[d];
        const k = layout2.k[3 * (layout2.offsets[a] + s) + axis];
        out[s * axes.length + d] = kmax[axis] > 0 ? 0.5 * k / kmax[axis] : 0;
      }
    }
    return out;
  }

  // node_modules/fflate/esm/browser.js
  var u8 = Uint8Array;
  var u16 = Uint16Array;
  var i32 = Int32Array;
  var fleb = new u8([
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    3,
    3,
    3,
    3,
    4,
    4,
    4,
    4,
    5,
    5,
    5,
    5,
    0,
    /* unused */
    0,
    0,
    /* impossible */
    0
  ]);
  var fdeb = new u8([
    0,
    0,
    0,
    0,
    1,
    1,
    2,
    2,
    3,
    3,
    4,
    4,
    5,
    5,
    6,
    6,
    7,
    7,
    8,
    8,
    9,
    9,
    10,
    10,
    11,
    11,
    12,
    12,
    13,
    13,
    /* unused */
    0,
    0
  ]);
  var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
  var freb = function(eb, start) {
    var b = new u16(31);
    for (var i2 = 0; i2 < 31; ++i2) {
      b[i2] = start += 1 << eb[i2 - 1];
    }
    var r = new i32(b[30]);
    for (var i2 = 1; i2 < 30; ++i2) {
      for (var j = b[i2]; j < b[i2 + 1]; ++j) {
        r[j] = j - b[i2] << 5 | i2;
      }
    }
    return { b, r };
  };
  var _a = freb(fleb, 2);
  var fl = _a.b;
  var revfl = _a.r;
  fl[28] = 258, revfl[258] = 28;
  var _b = freb(fdeb, 0);
  var fd = _b.b;
  var revfd = _b.r;
  var rev = new u16(32768);
  for (i = 0; i < 32768; ++i) {
    x = (i & 43690) >> 1 | (i & 21845) << 1;
    x = (x & 52428) >> 2 | (x & 13107) << 2;
    x = (x & 61680) >> 4 | (x & 3855) << 4;
    rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
  }
  var x;
  var i;
  var hMap = (function(cd, mb, r) {
    var s = cd.length;
    var i2 = 0;
    var l = new u16(mb);
    for (; i2 < s; ++i2) {
      if (cd[i2])
        ++l[cd[i2] - 1];
    }
    var le = new u16(mb);
    for (i2 = 1; i2 < mb; ++i2) {
      le[i2] = le[i2 - 1] + l[i2 - 1] << 1;
    }
    var co;
    if (r) {
      co = new u16(1 << mb);
      var rvb = 15 - mb;
      for (i2 = 0; i2 < s; ++i2) {
        if (cd[i2]) {
          var sv = i2 << 4 | cd[i2];
          var r_1 = mb - cd[i2];
          var v = le[cd[i2] - 1]++ << r_1;
          for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
            co[rev[v] >> rvb] = sv;
          }
        }
      }
    } else {
      co = new u16(s);
      for (i2 = 0; i2 < s; ++i2) {
        if (cd[i2]) {
          co[i2] = rev[le[cd[i2] - 1]++] >> 15 - cd[i2];
        }
      }
    }
    return co;
  });
  var flt = new u8(288);
  for (i = 0; i < 144; ++i)
    flt[i] = 8;
  var i;
  for (i = 144; i < 256; ++i)
    flt[i] = 9;
  var i;
  for (i = 256; i < 280; ++i)
    flt[i] = 7;
  var i;
  for (i = 280; i < 288; ++i)
    flt[i] = 8;
  var i;
  var fdt = new u8(32);
  for (i = 0; i < 32; ++i)
    fdt[i] = 5;
  var i;
  var flm = /* @__PURE__ */ hMap(flt, 9, 0);
  var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
  var fdm = /* @__PURE__ */ hMap(fdt, 5, 0);
  var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
  var max = function(a) {
    var m = a[0];
    for (var i2 = 1; i2 < a.length; ++i2) {
      if (a[i2] > m)
        m = a[i2];
    }
    return m;
  };
  var bits = function(d, p, m) {
    var o = p / 8 | 0;
    return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
  };
  var bits16 = function(d, p) {
    var o = p / 8 | 0;
    return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
  };
  var shft = function(p) {
    return (p + 7) / 8 | 0;
  };
  var slc = function(v, s, e) {
    if (s == null || s < 0)
      s = 0;
    if (e == null || e > v.length)
      e = v.length;
    return new u8(v.subarray(s, e));
  };
  var ec = [
    "unexpected EOF",
    "invalid block type",
    "invalid length/literal",
    "invalid distance",
    "stream finished",
    "no stream handler",
    ,
    // determined by compression function
    "no callback",
    "invalid UTF-8 data",
    "extra field too long",
    "date not in range 1980-2099",
    "filename too long",
    "stream finishing",
    "invalid zip data"
    // determined by unknown compression method
  ];
  var err = function(ind, msg, nt) {
    var e = new Error(msg || ec[ind]);
    e.code = ind;
    if (Error.captureStackTrace)
      Error.captureStackTrace(e, err);
    if (!nt)
      throw e;
    return e;
  };
  var inflt = function(dat, st, buf, dict) {
    var sl = dat.length, dl = dict ? dict.length : 0;
    if (!sl || st.f && !st.l)
      return buf || new u8(0);
    var noBuf = !buf;
    var resize = noBuf || st.i != 2;
    var noSt = st.i;
    if (noBuf)
      buf = new u8(sl * 3);
    var cbuf = function(l2) {
      var bl = buf.length;
      if (l2 > bl) {
        var nbuf = new u8(Math.max(bl * 2, l2));
        nbuf.set(buf);
        buf = nbuf;
      }
    };
    var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
    var tbts = sl * 8;
    do {
      if (!lm) {
        final = bits(dat, pos, 1);
        var type = bits(dat, pos + 1, 3);
        pos += 3;
        if (!type) {
          var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
          if (t > sl) {
            if (noSt)
              err(0);
            break;
          }
          if (resize)
            cbuf(bt + l);
          buf.set(dat.subarray(s, t), bt);
          st.b = bt += l, st.p = pos = t * 8, st.f = final;
          continue;
        } else if (type == 1)
          lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
        else if (type == 2) {
          var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
          var tl = hLit + bits(dat, pos + 5, 31) + 1;
          pos += 14;
          var ldt = new u8(tl);
          var clt = new u8(19);
          for (var i2 = 0; i2 < hcLen; ++i2) {
            clt[clim[i2]] = bits(dat, pos + i2 * 3, 7);
          }
          pos += hcLen * 3;
          var clb = max(clt), clbmsk = (1 << clb) - 1;
          var clm = hMap(clt, clb, 1);
          for (var i2 = 0; i2 < tl; ) {
            var r = clm[bits(dat, pos, clbmsk)];
            pos += r & 15;
            var s = r >> 4;
            if (s < 16) {
              ldt[i2++] = s;
            } else {
              var c = 0, n = 0;
              if (s == 16)
                n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i2 - 1];
              else if (s == 17)
                n = 3 + bits(dat, pos, 7), pos += 3;
              else if (s == 18)
                n = 11 + bits(dat, pos, 127), pos += 7;
              while (n--)
                ldt[i2++] = c;
            }
          }
          var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
          lbt = max(lt);
          dbt = max(dt);
          lm = hMap(lt, lbt, 1);
          dm = hMap(dt, dbt, 1);
        } else
          err(1);
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
      }
      if (resize)
        cbuf(bt + 131072);
      var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
      var lpos = pos;
      for (; ; lpos = pos) {
        var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
        pos += c & 15;
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (!c)
          err(2);
        if (sym < 256)
          buf[bt++] = sym;
        else if (sym == 256) {
          lpos = pos, lm = null;
          break;
        } else {
          var add = sym - 254;
          if (sym > 264) {
            var i2 = sym - 257, b = fleb[i2];
            add = bits(dat, pos, (1 << b) - 1) + fl[i2];
            pos += b;
          }
          var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
          if (!d)
            err(3);
          pos += d & 15;
          var dt = fd[dsym];
          if (dsym > 3) {
            var b = fdeb[dsym];
            dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
          }
          if (pos > tbts) {
            if (noSt)
              err(0);
            break;
          }
          if (resize)
            cbuf(bt + 131072);
          var end = bt + add;
          if (bt < dt) {
            var shift = dl - dt, dend = Math.min(dt, end);
            if (shift + bt < 0)
              err(3);
            for (; bt < dend; ++bt)
              buf[bt] = dict[shift + bt];
          }
          for (; bt < end; ++bt)
            buf[bt] = buf[bt - dt];
        }
      }
      st.l = lm, st.p = lpos, st.b = bt, st.f = final;
      if (lm)
        final = 1, st.m = lbt, st.d = dm, st.n = dbt;
    } while (!final);
    return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
  };
  var wbits = function(d, p, v) {
    v <<= p & 7;
    var o = p / 8 | 0;
    d[o] |= v;
    d[o + 1] |= v >> 8;
  };
  var wbits16 = function(d, p, v) {
    v <<= p & 7;
    var o = p / 8 | 0;
    d[o] |= v;
    d[o + 1] |= v >> 8;
    d[o + 2] |= v >> 16;
  };
  var hTree = function(d, mb) {
    var t = [];
    for (var i2 = 0; i2 < d.length; ++i2) {
      if (d[i2])
        t.push({ s: i2, f: d[i2] });
    }
    var s = t.length;
    var t2 = t.slice();
    if (!s)
      return { t: et, l: 0 };
    if (s == 1) {
      var v = new u8(t[0].s + 1);
      v[t[0].s] = 1;
      return { t: v, l: 1 };
    }
    t.sort(function(a, b) {
      return a.f - b.f;
    });
    t.push({ s: -1, f: 25001 });
    var l = t[0], r = t[1], i0 = 0, i1 = 1, i22 = 2;
    t[0] = { s: -1, f: l.f + r.f, l, r };
    while (i1 != s - 1) {
      l = t[t[i0].f < t[i22].f ? i0++ : i22++];
      r = t[i0 != i1 && t[i0].f < t[i22].f ? i0++ : i22++];
      t[i1++] = { s: -1, f: l.f + r.f, l, r };
    }
    var maxSym = t2[0].s;
    for (var i2 = 1; i2 < s; ++i2) {
      if (t2[i2].s > maxSym)
        maxSym = t2[i2].s;
    }
    var tr = new u16(maxSym + 1);
    var mbt = ln(t[i1 - 1], tr, 0);
    if (mbt > mb) {
      var i2 = 0, dt = 0;
      var lft = mbt - mb, cst = 1 << lft;
      t2.sort(function(a, b) {
        return tr[b.s] - tr[a.s] || a.f - b.f;
      });
      for (; i2 < s; ++i2) {
        var i2_1 = t2[i2].s;
        if (tr[i2_1] > mb) {
          dt += cst - (1 << mbt - tr[i2_1]);
          tr[i2_1] = mb;
        } else
          break;
      }
      dt >>= lft;
      while (dt > 0) {
        var i2_2 = t2[i2].s;
        if (tr[i2_2] < mb)
          dt -= 1 << mb - tr[i2_2]++ - 1;
        else
          ++i2;
      }
      for (; i2 >= 0 && dt; --i2) {
        var i2_3 = t2[i2].s;
        if (tr[i2_3] == mb) {
          --tr[i2_3];
          ++dt;
        }
      }
      mbt = mb;
    }
    return { t: new u8(tr), l: mbt };
  };
  var ln = function(n, l, d) {
    return n.s == -1 ? Math.max(ln(n.l, l, d + 1), ln(n.r, l, d + 1)) : l[n.s] = d;
  };
  var lc = function(c) {
    var s = c.length;
    while (s && !c[--s])
      ;
    var cl = new u16(++s);
    var cli = 0, cln = c[0], cls = 1;
    var w = function(v) {
      cl[cli++] = v;
    };
    for (var i2 = 1; i2 <= s; ++i2) {
      if (c[i2] == cln && i2 != s)
        ++cls;
      else {
        if (!cln && cls > 2) {
          for (; cls > 138; cls -= 138)
            w(32754);
          if (cls > 2) {
            w(cls > 10 ? cls - 11 << 5 | 28690 : cls - 3 << 5 | 12305);
            cls = 0;
          }
        } else if (cls > 3) {
          w(cln), --cls;
          for (; cls > 6; cls -= 6)
            w(8304);
          if (cls > 2)
            w(cls - 3 << 5 | 8208), cls = 0;
        }
        while (cls--)
          w(cln);
        cls = 1;
        cln = c[i2];
      }
    }
    return { c: cl.subarray(0, cli), n: s };
  };
  var clen = function(cf, cl) {
    var l = 0;
    for (var i2 = 0; i2 < cl.length; ++i2)
      l += cf[i2] * cl[i2];
    return l;
  };
  var wfblk = function(out, pos, dat) {
    var s = dat.length;
    var o = shft(pos + 2);
    out[o] = s & 255;
    out[o + 1] = s >> 8;
    out[o + 2] = out[o] ^ 255;
    out[o + 3] = out[o + 1] ^ 255;
    for (var i2 = 0; i2 < s; ++i2)
      out[o + i2 + 4] = dat[i2];
    return (o + 4 + s) * 8;
  };
  var wblk = function(dat, out, final, syms, lf, df, eb, li, bs, bl, p) {
    wbits(out, p++, final);
    ++lf[256];
    var _a2 = hTree(lf, 15), dlt = _a2.t, mlb = _a2.l;
    var _b2 = hTree(df, 15), ddt = _b2.t, mdb = _b2.l;
    var _c = lc(dlt), lclt = _c.c, nlc = _c.n;
    var _d = lc(ddt), lcdt = _d.c, ndc = _d.n;
    var lcfreq = new u16(19);
    for (var i2 = 0; i2 < lclt.length; ++i2)
      ++lcfreq[lclt[i2] & 31];
    for (var i2 = 0; i2 < lcdt.length; ++i2)
      ++lcfreq[lcdt[i2] & 31];
    var _e = hTree(lcfreq, 7), lct = _e.t, mlcb = _e.l;
    var nlcc = 19;
    for (; nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc)
      ;
    var flen = bl + 5 << 3;
    var ftlen = clen(lf, flt) + clen(df, fdt) + eb;
    var dtlen = clen(lf, dlt) + clen(df, ddt) + eb + 14 + 3 * nlcc + clen(lcfreq, lct) + 2 * lcfreq[16] + 3 * lcfreq[17] + 7 * lcfreq[18];
    if (bs >= 0 && flen <= ftlen && flen <= dtlen)
      return wfblk(out, p, dat.subarray(bs, bs + bl));
    var lm, ll, dm, dl;
    wbits(out, p, 1 + (dtlen < ftlen)), p += 2;
    if (dtlen < ftlen) {
      lm = hMap(dlt, mlb, 0), ll = dlt, dm = hMap(ddt, mdb, 0), dl = ddt;
      var llm = hMap(lct, mlcb, 0);
      wbits(out, p, nlc - 257);
      wbits(out, p + 5, ndc - 1);
      wbits(out, p + 10, nlcc - 4);
      p += 14;
      for (var i2 = 0; i2 < nlcc; ++i2)
        wbits(out, p + 3 * i2, lct[clim[i2]]);
      p += 3 * nlcc;
      var lcts = [lclt, lcdt];
      for (var it = 0; it < 2; ++it) {
        var clct = lcts[it];
        for (var i2 = 0; i2 < clct.length; ++i2) {
          var len = clct[i2] & 31;
          wbits(out, p, llm[len]), p += lct[len];
          if (len > 15)
            wbits(out, p, clct[i2] >> 5 & 127), p += clct[i2] >> 12;
        }
      }
    } else {
      lm = flm, ll = flt, dm = fdm, dl = fdt;
    }
    for (var i2 = 0; i2 < li; ++i2) {
      var sym = syms[i2];
      if (sym > 255) {
        var len = sym >> 18 & 31;
        wbits16(out, p, lm[len + 257]), p += ll[len + 257];
        if (len > 7)
          wbits(out, p, sym >> 23 & 31), p += fleb[len];
        var dst = sym & 31;
        wbits16(out, p, dm[dst]), p += dl[dst];
        if (dst > 3)
          wbits16(out, p, sym >> 5 & 8191), p += fdeb[dst];
      } else {
        wbits16(out, p, lm[sym]), p += ll[sym];
      }
    }
    wbits16(out, p, lm[256]);
    return p + ll[256];
  };
  var deo = /* @__PURE__ */ new i32([65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632]);
  var et = /* @__PURE__ */ new u8(0);
  var dflt = function(dat, lvl, plvl, pre, post, st) {
    var s = st.z || dat.length;
    var o = new u8(pre + s + 5 * (1 + Math.ceil(s / 7e3)) + post);
    var w = o.subarray(pre, o.length - post);
    var lst = st.l;
    var pos = (st.r || 0) & 7;
    if (lvl) {
      if (pos)
        w[0] = st.r >> 3;
      var opt = deo[lvl - 1];
      var n = opt >> 13, c = opt & 8191;
      var msk_1 = (1 << plvl) - 1;
      var prev = st.p || new u16(32768), head = st.h || new u16(msk_1 + 1);
      var bs1_1 = Math.ceil(plvl / 3), bs2_1 = 2 * bs1_1;
      var hsh = function(i3) {
        return (dat[i3] ^ dat[i3 + 1] << bs1_1 ^ dat[i3 + 2] << bs2_1) & msk_1;
      };
      var syms = new i32(25e3);
      var lf = new u16(288), df = new u16(32);
      var lc_1 = 0, eb = 0, i2 = st.i || 0, li = 0, wi = st.w || 0, bs = 0;
      for (; i2 + 2 < s; ++i2) {
        var hv = hsh(i2);
        var imod = i2 & 32767, pimod = head[hv];
        prev[imod] = pimod;
        head[hv] = imod;
        if (wi <= i2) {
          var rem = s - i2;
          if ((lc_1 > 7e3 || li > 24576) && (rem > 423 || !lst)) {
            pos = wblk(dat, w, 0, syms, lf, df, eb, li, bs, i2 - bs, pos);
            li = lc_1 = eb = 0, bs = i2;
            for (var j = 0; j < 286; ++j)
              lf[j] = 0;
            for (var j = 0; j < 30; ++j)
              df[j] = 0;
          }
          var l = 2, d = 0, ch_1 = c, dif = imod - pimod & 32767;
          if (rem > 2 && hv == hsh(i2 - dif)) {
            var maxn = Math.min(n, rem) - 1;
            var maxd = Math.min(32767, i2);
            var ml = Math.min(258, rem);
            while (dif <= maxd && --ch_1 && imod != pimod) {
              if (dat[i2 + l] == dat[i2 + l - dif]) {
                var nl = 0;
                for (; nl < ml && dat[i2 + nl] == dat[i2 + nl - dif]; ++nl)
                  ;
                if (nl > l) {
                  l = nl, d = dif;
                  if (nl > maxn)
                    break;
                  var mmd = Math.min(dif, nl - 2);
                  var md = 0;
                  for (var j = 0; j < mmd; ++j) {
                    var ti = i2 - dif + j & 32767;
                    var pti = prev[ti];
                    var cd = ti - pti & 32767;
                    if (cd > md)
                      md = cd, pimod = ti;
                  }
                }
              }
              imod = pimod, pimod = prev[imod];
              dif += imod - pimod & 32767;
            }
          }
          if (d) {
            syms[li++] = 268435456 | revfl[l] << 18 | revfd[d];
            var lin = revfl[l] & 31, din = revfd[d] & 31;
            eb += fleb[lin] + fdeb[din];
            ++lf[257 + lin];
            ++df[din];
            wi = i2 + l;
            ++lc_1;
          } else {
            syms[li++] = dat[i2];
            ++lf[dat[i2]];
          }
        }
      }
      for (i2 = Math.max(i2, wi); i2 < s; ++i2) {
        syms[li++] = dat[i2];
        ++lf[dat[i2]];
      }
      pos = wblk(dat, w, lst, syms, lf, df, eb, li, bs, i2 - bs, pos);
      if (!lst) {
        st.r = pos & 7 | w[pos / 8 | 0] << 3;
        pos -= 7;
        st.h = head, st.p = prev, st.i = i2, st.w = wi;
      }
    } else {
      for (var i2 = st.w || 0; i2 < s + lst; i2 += 65535) {
        var e = i2 + 65535;
        if (e >= s) {
          w[pos / 8 | 0] = lst;
          e = s;
        }
        pos = wfblk(w, pos + 1, dat.subarray(i2, e));
      }
      st.i = s;
    }
    return slc(o, 0, pre + shft(pos) + post);
  };
  var dopt = function(dat, opt, pre, post, st) {
    if (!st) {
      st = { l: 1 };
      if (opt.dictionary) {
        var dict = opt.dictionary.subarray(-32768);
        var newDat = new u8(dict.length + dat.length);
        newDat.set(dict);
        newDat.set(dat, dict.length);
        dat = newDat;
        st.w = dict.length;
      }
    }
    return dflt(dat, opt.level == null ? 6 : opt.level, opt.mem == null ? st.l ? Math.ceil(Math.max(8, Math.min(13, Math.log(dat.length))) * 1.5) : 20 : 12 + opt.mem, pre, post, st);
  };
  function deflateSync(data, opts) {
    return dopt(data, opts || {}, 0, 0);
  }
  var Inflate = /* @__PURE__ */ (function() {
    function Inflate2(opts, cb) {
      if (typeof opts == "function")
        cb = opts, opts = {};
      this.ondata = cb;
      var dict = opts && opts.dictionary && opts.dictionary.subarray(-32768);
      this.s = { i: 0, b: dict ? dict.length : 0 };
      this.o = new u8(32768);
      this.p = new u8(0);
      if (dict)
        this.o.set(dict);
    }
    Inflate2.prototype.e = function(c) {
      if (!this.ondata)
        err(5);
      if (this.d)
        err(4);
      if (!this.p.length)
        this.p = c;
      else if (c.length) {
        var n = new u8(this.p.length + c.length);
        n.set(this.p), n.set(c, this.p.length), this.p = n;
      }
    };
    Inflate2.prototype.c = function(final) {
      this.s.i = +(this.d = final || false);
      var bts = this.s.b;
      var dt = inflt(this.p, this.s, this.o);
      this.ondata(slc(dt, bts, this.s.b), this.d);
      this.o = slc(dt, this.s.b - 32768), this.s.b = this.o.length;
      this.p = slc(this.p, this.s.p / 8 | 0), this.s.p &= 7;
    };
    Inflate2.prototype.push = function(chunk, final) {
      this.e(chunk), this.c(final);
    };
    return Inflate2;
  })();
  function inflateSync(data, opts) {
    return inflt(data, { i: 2 }, opts && opts.out, opts && opts.dictionary);
  }
  var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
  var tds = 0;
  try {
    td.decode(et, { stream: true });
    tds = 1;
  } catch (e) {
  }

  // src/sim/io/compression.ts
  function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
  }
  function inflateExact(deflated, size, what) {
    let out;
    try {
      out = new Uint8Array(size);
    } catch {
      throw new Error(`${what}: cannot allocate ${size} bytes for the decompressed data.`);
    }
    let result;
    try {
      result = inflateSync(deflated, { out });
    } catch (error) {
      throw new Error(`${what}: the compressed data is corrupt or truncated (${messageOf(error)}).`);
    }
    if (result.length !== size) {
      throw new Error(`${what}: the compressed data expands to ${result.length} bytes, expected ${size}; the file is corrupt.`);
    }
    return out;
  }
  function inflatePrefix(deflated, length, what) {
    const parts = [];
    let have = 0;
    const stream = new Inflate((chunk) => {
      if (chunk.length) {
        parts.push(chunk);
        have += chunk.length;
      }
    });
    try {
      for (let p = 0, chunk = 1024; p < deflated.length && have < length; chunk *= 2) {
        const end = Math.min(p + chunk, deflated.length);
        stream.push(deflated.subarray(p, end), end === deflated.length);
        p = end;
      }
    } catch (error) {
      throw new Error(`${what}: the compressed data is corrupt or truncated (${messageOf(error)}).`);
    }
    const prefix = new Uint8Array(have);
    let offset = 0;
    for (const part of parts) {
      prefix.set(part, offset);
      offset += part.length;
    }
    return prefix;
  }
  function isGzip(bytes) {
    return bytes.length >= 2 && bytes[0] === 31 && bytes[1] === 139;
  }
  function gunzip(bytes, prefixLength, sizeOf, what) {
    const start = gzipDataStart(bytes, what);
    const trailer = bytes.length - 8;
    const deflated = bytes.subarray(start, trailer);
    const expectedCrc = readUint32LE(bytes, trailer);
    const storedSize = readUint32LE(bytes, trailer + 4);
    const needed = sizeOf(inflatePrefix(deflated, prefixLength, what));
    const extra = storedSize - needed % 4294967296;
    if (extra < 0 || extra > Math.max(needed, 1 << 20)) {
      throw new Error(`${what}: the gzip data is truncated or corrupt (the content needs ${needed} bytes, the gzip trailer records ${storedSize}).`);
    }
    const out = inflateExact(deflated, needed + extra, what);
    if (crc32(out) !== expectedCrc) throw new Error(`${what}: gzip checksum mismatch; the file is corrupt.`);
    return out;
  }
  function gzipDataStart(bytes, what) {
    if (!isGzip(bytes)) throw new Error(`${what}: not gzip data.`);
    if (bytes.length < 18) throw new Error(`${what}: the gzip file is truncated.`);
    if (bytes[2] !== 8) throw new Error(`${what}: unsupported gzip compression method ${bytes[2]}.`);
    const flags = bytes[3];
    if (flags & 224) throw new Error(`${what}: invalid gzip header flags.`);
    let p = 10;
    if (flags & 4) p += 2 + (bytes[p] | bytes[p + 1] << 8);
    if (flags & 8) {
      while (p < bytes.length && bytes[p] !== 0) p++;
      p++;
    }
    if (flags & 16) {
      while (p < bytes.length && bytes[p] !== 0) p++;
      p++;
    }
    if (flags & 2) p += 2;
    if (p > bytes.length - 8) throw new Error(`${what}: the gzip file is truncated.`);
    return p;
  }
  function unzlib(bytes, prefixLength, sizeOf, what) {
    if (bytes.length < 6) throw new Error(`${what}: the zlib stream is truncated.`);
    const cmf = bytes[0], flg = bytes[1];
    if ((cmf & 15) !== 8 || cmf >> 4 > 7 || (cmf << 8 | flg) % 31 !== 0) throw new Error(`${what}: not a zlib stream.`);
    if (flg & 32) throw new Error(`${what}: zlib streams with a preset dictionary are not supported.`);
    const deflated = bytes.subarray(2, bytes.length - 4);
    const out = inflateExact(deflated, sizeOf(inflatePrefix(deflated, prefixLength, what)), what);
    const end = bytes.length - 4;
    const expected = (bytes[end] << 24 | bytes[end + 1] << 16 | bytes[end + 2] << 8 | bytes[end + 3]) >>> 0;
    if (adler32(out) !== expected) throw new Error(`${what}: zlib checksum mismatch; the data is corrupt.`);
    return out;
  }
  function readUint32LE(bytes, offset) {
    return (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0;
  }
  var crcTables = null;
  function crcTable() {
    if (crcTables) return crcTables;
    const table = new Int32Array(8 * 256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
      table[n] = c;
    }
    for (let n = 0; n < 256; n++) {
      let c = table[n];
      for (let k = 1; k < 8; k++) {
        c = table[c & 255] ^ c >>> 8;
        table[k * 256 + n] = c;
      }
    }
    crcTables = table;
    return table;
  }
  function crc32(bytes, crc = 0) {
    const t = crcTable();
    let c = ~crc;
    const n = bytes.length;
    const blocks = n - (n & 7);
    let i2 = 0;
    for (; i2 < blocks; i2 += 8) {
      const a = c ^ (bytes[i2] | bytes[i2 + 1] << 8 | bytes[i2 + 2] << 16 | bytes[i2 + 3] << 24);
      c = t[1792 + (a & 255)] ^ t[1536 + (a >>> 8 & 255)] ^ t[1280 + (a >>> 16 & 255)] ^ t[1024 + (a >>> 24)] ^ t[768 + bytes[i2 + 4]] ^ t[512 + bytes[i2 + 5]] ^ t[256 + bytes[i2 + 6]] ^ t[bytes[i2 + 7]];
    }
    for (; i2 < n; i2++) c = t[(c ^ bytes[i2]) & 255] ^ c >>> 8;
    return ~c >>> 0;
  }
  function adler32(bytes) {
    let a = 1, b = 0;
    const n = bytes.length;
    for (let i2 = 0; i2 < n; ) {
      const end = Math.min(i2 + 5552, n);
      for (; i2 < end; i2++) {
        a += bytes[i2];
        b += a;
      }
      a %= 65521;
      b %= 65521;
    }
    return b * 65536 + a >>> 0;
  }

  // src/sim/io/elements.ts
  var ELEMENT_SIZE = {
    b1: 1,
    i1: 1,
    u1: 1,
    i2: 2,
    u2: 2,
    i4: 4,
    u4: 4,
    i8: 8,
    u8: 8,
    f2: 2,
    f4: 4,
    f8: 8
  };
  var HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  function outputPrecision(type) {
    return type === "f8" || type === "i4" || type === "u4" || type === "i8" || type === "u8" ? "f8" : "f4";
  }
  function decodeElements(bytes, offset, count, type, littleEndian, precision, step = 1) {
    const out = precision === "f8" ? new Float64Array(count) : new Float32Array(count);
    if (count === 0) return out;
    const size = ELEMENT_SIZE[type];
    const span = (count - 1) * step + 1;
    if (!(offset >= 0 && offset + span * size <= bytes.length)) {
      throw new RangeError(`Element data [${offset}, ${offset + span * size}) lies outside the ${bytes.length}-byte buffer.`);
    }
    if (type === "i8" || type === "u8") {
      decodeInt64(bytes, offset, count, type === "i8", littleEndian, step, out);
    } else if (size === 1 || littleEndian === HOST_LITTLE_ENDIAN) {
      const view = nativeView(bytes, offset, span, type);
      if (type === "f2") {
        for (let i2 = 0; i2 < count; i2++) out[i2] = halfToNumber(view[i2 * step]);
      } else if (type === "b1") {
        for (let i2 = 0; i2 < count; i2++) out[i2] = view[i2 * step] === 0 ? 0 : 1;
      } else if (step === 1) {
        out.set(view);
      } else {
        for (let i2 = 0; i2 < count; i2++) out[i2] = view[i2 * step];
      }
    } else {
      decodeSwapped(bytes, offset, count, type, littleEndian, step, out);
    }
    return out;
  }
  function nativeView(bytes, offset, length, type) {
    const size = ELEMENT_SIZE[type];
    let buffer = bytes.buffer;
    let start = bytes.byteOffset + offset;
    if (start % size !== 0) {
      buffer = bytes.slice(offset, offset + length * size).buffer;
      start = 0;
    }
    switch (type) {
      case "i1":
        return new Int8Array(buffer, start, length);
      case "u1":
      case "b1":
        return new Uint8Array(buffer, start, length);
      case "i2":
        return new Int16Array(buffer, start, length);
      case "u2":
      case "f2":
        return new Uint16Array(buffer, start, length);
      case "i4":
        return new Int32Array(buffer, start, length);
      case "u4":
        return new Uint32Array(buffer, start, length);
      case "f4":
        return new Float32Array(buffer, start, length);
      case "f8":
        return new Float64Array(buffer, start, length);
    }
  }
  function decodeSwapped(bytes, offset, count, type, littleEndian, step, out) {
    const size = ELEMENT_SIZE[type];
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, ((count - 1) * step + 1) * size);
    const stride = step * size;
    let p = 0;
    switch (type) {
      case "i2":
        for (let i2 = 0; i2 < count; i2++, p += stride) out[i2] = view.getInt16(p, littleEndian);
        break;
      case "u2":
        for (let i2 = 0; i2 < count; i2++, p += stride) out[i2] = view.getUint16(p, littleEndian);
        break;
      case "f2":
        for (let i2 = 0; i2 < count; i2++, p += stride) out[i2] = halfToNumber(view.getUint16(p, littleEndian));
        break;
      case "i4":
        for (let i2 = 0; i2 < count; i2++, p += stride) out[i2] = view.getInt32(p, littleEndian);
        break;
      case "u4":
        for (let i2 = 0; i2 < count; i2++, p += stride) out[i2] = view.getUint32(p, littleEndian);
        break;
      case "f4":
        for (let i2 = 0; i2 < count; i2++, p += stride) out[i2] = view.getFloat32(p, littleEndian);
        break;
      case "f8":
        for (let i2 = 0; i2 < count; i2++, p += stride) out[i2] = view.getFloat64(p, littleEndian);
        break;
      default:
        throw new Error(`No byte-swapped decoder for ${type}.`);
    }
  }
  function decodeInt64(bytes, offset, count, signed, littleEndian, step, out) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, ((count - 1) * step + 1) * 8);
    const low = littleEndian ? 0 : 4, high = 4 - low;
    const stride = step * 8;
    for (let i2 = 0, p = 0; i2 < count; i2++, p += stride) {
      const hi = signed ? view.getInt32(p + high, littleEndian) : view.getUint32(p + high, littleEndian);
      out[i2] = hi * 4294967296 + view.getUint32(p + low, littleEndian);
    }
  }
  function halfToNumber(bits2) {
    const exponent = bits2 >> 10 & 31;
    const fraction = bits2 & 1023;
    const sign = bits2 & 32768 ? -1 : 1;
    if (exponent === 0) return sign * fraction * 2 ** -24;
    if (exponent === 31) return fraction ? NaN : sign * Infinity;
    return sign * (1024 + fraction) * 2 ** (exponent - 25);
  }

  // src/sim/io/ndarray.ts
  function elementCount(shape) {
    let count = 1;
    for (const size of shape) {
      if (!(Number.isInteger(size) && size >= 0)) throw new RangeError(`Invalid array shape [${shape.join(", ")}].`);
      count *= size;
    }
    if (!Number.isSafeInteger(count)) throw new RangeError(`Array shape [${shape.join(", ")}] has too many elements.`);
    return count;
  }

  // src/sim/io/npy.ts
  var MAGIC = [147, 78, 85, 77, 80, 89];
  var ARRAY_ALIGN = 64;
  var GROWTH_AXIS_MAX_DIGITS = 21;
  function readNpyHeader(bytes) {
    if (MAGIC.some((byte, i2) => bytes[i2] !== byte)) throw new Error("Not an NPY file: the \\x93NUMPY magic string is missing.");
    if (bytes.length < 10) throw new Error("NPY file is truncated inside its header.");
    const major = bytes[6], minor = bytes[7];
    if (!(major >= 1 && major <= 3) || minor !== 0) {
      throw new Error(`NPY format version ${major}.${minor} is not supported (1.0, 2.0 and 3.0 are).`);
    }
    const start = major === 1 ? 10 : 12;
    if (bytes.length < start) throw new Error("NPY file is truncated inside its header.");
    const headerLength = major === 1 ? bytes[8] | bytes[9] << 8 : (bytes[8] | bytes[9] << 8 | bytes[10] << 16 | bytes[11] << 24) >>> 0;
    if (start + headerLength > bytes.length) {
      throw new Error(`NPY file is truncated: the header needs ${headerLength} bytes, ${bytes.length - start} remain.`);
    }
    const raw = bytes.subarray(start, start + headerLength);
    const text2 = major === 3 ? new TextDecoder("utf-8").decode(raw) : latin1(raw);
    let header;
    try {
      header = new LiteralParser(text2).parse();
    } catch (error) {
      throw new Error(`NPY header is not a valid Python literal: ${error instanceof Error ? error.message : error}`);
    }
    if (!isDict(header)) throw new Error("NPY header is not a dict.");
    const { descr, fortran_order: fortranOrder, shape } = header;
    if (Array.isArray(descr)) {
      throw new Error("NPY structured (record) dtypes are not supported; save each field as its own array.");
    }
    if (typeof descr !== "string") throw new Error("NPY header has no valid 'descr' entry.");
    if (typeof fortranOrder !== "boolean") throw new Error("NPY header has no valid 'fortran_order' entry.");
    if (!Array.isArray(shape) || !shape.every((size) => typeof size === "number" && Number.isInteger(size) && size >= 0)) {
      throw new Error("NPY header has no valid 'shape' entry.");
    }
    return { version: [major, minor], descr, fortranOrder, shape, dataOffset: start + headerLength };
  }
  function readNpy(bytes) {
    const header = readNpyHeader(bytes);
    const type = parseDescr(header.descr);
    const count = elementCount(header.shape);
    const needed = count * type.itemSize;
    const available = bytes.length - header.dataOffset;
    if (needed > available) {
      throw new Error(`NPY data is truncated: shape (${header.shape.join(", ")}) of ${header.descr} needs ${needed} bytes, ${available} remain after the header.`);
    }
    const precision = outputPrecision(type.element);
    const array = {
      dtype: header.descr,
      shape: header.shape,
      order: header.fortranOrder ? "F" : "C",
      data: decodeElements(bytes, header.dataOffset, count, type.element, type.littleEndian, precision, type.complex ? 2 : 1)
    };
    if (type.complex) {
      const half = ELEMENT_SIZE[type.element];
      array.imag = decodeElements(bytes, header.dataOffset + half, count, type.element, type.littleEndian, precision, 2);
    }
    return array;
  }
  var UNSUPPORTED_KINDS = {
    U: "Unicode strings",
    S: "byte strings",
    a: "byte strings",
    O: "Python objects",
    V: "raw or structured records",
    M: "datetimes",
    m: "timedeltas"
  };
  function parseDescr(descr) {
    const match = /^([<>|=]?)([a-zA-Z?])(\d*)$/.exec(descr);
    const kind = match ? match[2] : descr.replace(/^[<>|=]/, "").charAt(0);
    const size = match && match[3] ? Number(match[3]) : kind === "?" ? 1 : 0;
    let element;
    let complex = false;
    switch (kind) {
      case "f":
        element = size === 2 ? "f2" : size === 4 ? "f4" : size === 8 ? "f8" : void 0;
        break;
      case "i":
        element = size === 1 ? "i1" : size === 2 ? "i2" : size === 4 ? "i4" : size === 8 ? "i8" : void 0;
        break;
      case "u":
        element = size === 1 ? "u1" : size === 2 ? "u2" : size === 4 ? "u4" : size === 8 ? "u8" : void 0;
        break;
      case "b":
      case "?":
        element = size === 1 ? "b1" : void 0;
        break;
      case "c":
        complex = true;
        element = size === 8 ? "f4" : size === 16 ? "f8" : void 0;
        break;
    }
    if (!element || !match) {
      const what = UNSUPPORTED_KINDS[kind] ?? (kind === "f" || kind === "c" ? "extended-precision numbers" : "an unknown type");
      throw new Error(`NPY dtype '${descr}' (${what}) is not supported; save numeric arrays (float16/32/64, integers, bool or complex64/128).`);
    }
    const order = match[1];
    const littleEndian = order === "<" ? true : order === ">" ? false : HOST_LITTLE_ENDIAN;
    return { element, complex, littleEndian, itemSize: (complex ? 2 : 1) * ELEMENT_SIZE[element] };
  }
  function writeNpy(array) {
    const count = elementCount(array.shape);
    if (array.data.length !== count) {
      throw new Error(`Array data has ${array.data.length} elements but shape (${array.shape.join(", ")}) needs ${count}.`);
    }
    if (array.imag && array.imag.length !== count) {
      throw new Error(`Imaginary part has ${array.imag.length} elements but shape (${array.shape.join(", ")}) needs ${count}.`);
    }
    const fortranOrder = (array.order ?? "C") === "F";
    let descr;
    let body;
    if (array.imag) {
      const wide = array.data instanceof Float64Array || array.imag instanceof Float64Array || array.data instanceof Int32Array || array.data instanceof Uint32Array;
      descr = wide ? "<c16" : "<c8";
      const interleaved = wide ? new Float64Array(2 * count) : new Float32Array(2 * count);
      for (let i2 = 0; i2 < count; i2++) {
        interleaved[2 * i2] = array.data[i2];
        interleaved[2 * i2 + 1] = array.imag[i2];
      }
      body = interleaved;
    } else {
      descr = descrOf(array.data);
      body = array.data;
    }
    const header = npyHeader(descr, fortranOrder, array.shape);
    const out = new Uint8Array(header.length + body.byteLength);
    out.set(header);
    writeLittleEndian(body, out, header.length);
    return out;
  }
  function descrOf(data) {
    if (data instanceof Float64Array) return "<f8";
    if (data instanceof Float32Array) return "<f4";
    if (data instanceof Int32Array) return "<i4";
    if (data instanceof Uint32Array) return "<u4";
    if (data instanceof Int16Array) return "<i2";
    if (data instanceof Uint16Array) return "<u2";
    if (data instanceof Int8Array) return "|i1";
    return "|u1";
  }
  function npyHeader(descr, fortranOrder, shape) {
    const shapeText = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(", ")})`;
    let dict = `{'descr': '${descr}', 'fortran_order': ${fortranOrder ? "True" : "False"}, 'shape': ${shapeText}, }`;
    if (shape.length > 0) {
      dict += " ".repeat(Math.max(0, GROWTH_AXIS_MAX_DIGITS - String(shape[fortranOrder ? shape.length - 1 : 0]).length));
    }
    let lengthField = 2;
    let padding = ARRAY_ALIGN - (8 + lengthField + dict.length + 1) % ARRAY_ALIGN;
    if (dict.length + 1 + padding > 65535) {
      lengthField = 4;
      padding = ARRAY_ALIGN - (8 + lengthField + dict.length + 1) % ARRAY_ALIGN;
    }
    const headerLength = dict.length + padding + 1;
    const out = new Uint8Array(8 + lengthField + headerLength);
    out.set(MAGIC);
    out[6] = lengthField === 2 ? 1 : 2;
    out[7] = 0;
    for (let k = 0; k < lengthField; k++) out[8 + k] = headerLength >>> 8 * k & 255;
    const text2 = dict + " ".repeat(padding) + "\n";
    for (let i2 = 0; i2 < text2.length; i2++) out[8 + lengthField + i2] = text2.charCodeAt(i2);
    return out;
  }
  function writeLittleEndian(data, out, offset) {
    out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
    if (HOST_LITTLE_ENDIAN) return;
    const size = data.BYTES_PER_ELEMENT;
    for (let p = offset; size > 1 && p < offset + data.byteLength; p += size) out.subarray(p, p + size).reverse();
  }
  function isDict(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function latin1(bytes) {
    let text2 = "";
    for (let i2 = 0; i2 < bytes.length; i2 += 8192) {
      text2 += String.fromCharCode(...bytes.subarray(i2, Math.min(i2 + 8192, bytes.length)));
    }
    return text2;
  }
  var ESCAPES = { n: "\n", t: "	", r: "\r", "0": "\0", "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", v: "\v" };
  var LiteralParser = class {
    constructor(text2) {
      __publicField(this, "text", text2);
      __publicField(this, "pos", 0);
    }
    parse() {
      const value = this.value();
      this.skipSpace();
      if (this.pos < this.text.length) this.fail("unexpected trailing text");
      return value;
    }
    value() {
      this.skipSpace();
      const c = this.text[this.pos];
      if (c === "{") return this.dict();
      if (c === "(") return this.sequence(")");
      if (c === "[") return this.sequence("]");
      if (c === "'" || c === '"') return this.string();
      if ((c === "u" || c === "b") && (this.text[this.pos + 1] === "'" || this.text[this.pos + 1] === '"')) {
        this.pos++;
        return this.string();
      }
      const number = /^[+-]?(\d+\.?\d*(e[+-]?\d+)?|\.\d+(e[+-]?\d+)?)[lL]?/i.exec(this.text.slice(this.pos));
      if (number) {
        this.pos += number[0].length;
        return Number(number[0].replace(/[lL]$/, ""));
      }
      const word = /^[A-Za-z_]\w*/.exec(this.text.slice(this.pos));
      if (word) {
        this.pos += word[0].length;
        if (word[0] === "True") return true;
        if (word[0] === "False") return false;
        if (word[0] === "None") return null;
        this.fail(`unexpected name '${word[0]}'`);
      }
      return this.fail("expected a value");
    }
    dict() {
      const result = {};
      this.pos++;
      for (; ; ) {
        this.skipSpace();
        if (this.text[this.pos] === "}") {
          this.pos++;
          return result;
        }
        const key = this.value();
        if (typeof key !== "string") this.fail("dict keys must be strings");
        this.expect(":");
        result[key] = this.value();
        this.skipSpace();
        if (this.text[this.pos] === ",") this.pos++;
        else if (this.text[this.pos] !== "}") this.fail("expected ',' or '}'");
      }
    }
    /** Tuples and lists both become arrays; a shape like (5) is read as a tuple too. */
    sequence(close) {
      const items = [];
      this.pos++;
      for (; ; ) {
        this.skipSpace();
        if (this.text[this.pos] === close) {
          this.pos++;
          return items;
        }
        items.push(this.value());
        this.skipSpace();
        if (this.text[this.pos] === ",") this.pos++;
        else if (this.text[this.pos] !== close) this.fail(`expected ',' or '${close}'`);
      }
    }
    string() {
      const quote = this.text[this.pos++];
      let result = "";
      for (; ; ) {
        if (this.pos >= this.text.length) this.fail("unterminated string");
        const c = this.text[this.pos++];
        if (c === quote) return result;
        if (c !== "\\") {
          result += c;
          continue;
        }
        const e = this.text[this.pos++];
        const hex = e === "x" ? 2 : e === "u" ? 4 : e === "U" ? 8 : 0;
        if (hex) {
          const digits = this.text.slice(this.pos, this.pos + hex);
          if (!/^[0-9a-fA-F]+$/.test(digits) || digits.length !== hex) this.fail("invalid escape");
          result += String.fromCodePoint(parseInt(digits, 16));
          this.pos += hex;
        } else {
          result += ESCAPES[e] ?? `\\${e}`;
        }
      }
    }
    expect(char) {
      this.skipSpace();
      if (this.text[this.pos] !== char) this.fail(`expected '${char}'`);
      this.pos++;
    }
    skipSpace() {
      while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
    }
    fail(message) {
      throw new Error(`${message} at position ${this.pos}`);
    }
  };

  // src/sim/io/zip.ts
  var EOCD = 101010256;
  var ZIP64_LOCATOR = 117853008;
  var ZIP64_EOCD = 101075792;
  var CENTRAL_HEADER = 33639248;
  var LOCAL_HEADER = 67324752;
  var MAX32 = 4294967295;
  function readZipDirectory(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findEndOfCentralDirectory(view);
    let count = view.getUint16(eocd + 10, true);
    let directorySize = view.getUint32(eocd + 12, true);
    let directoryOffset = view.getUint32(eocd + 16, true);
    let directoryEnd = eocd;
    if (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR) {
      let record = eocd - 20 - 56;
      if (record < 0 || view.getUint32(record, true) !== ZIP64_EOCD) record = readUint64(view, eocd - 12);
      if (!(record >= 0 && record + 56 <= eocd - 20) || view.getUint32(record, true) !== ZIP64_EOCD) {
        throw new Error("Corrupt zip archive: the ZIP64 end-of-central-directory record is missing.");
      }
      count = readUint64(view, record + 32);
      directorySize = readUint64(view, record + 40);
      directoryOffset = readUint64(view, record + 48);
      directoryEnd = record;
    }
    const shift = directoryEnd - directorySize - directoryOffset;
    if (shift < 0) throw new Error("Corrupt zip archive: the central directory lies outside the file.");
    const entries = [];
    let p = directoryOffset + shift;
    for (let i2 = 0; i2 < count; i2++) {
      if (p + 46 > directoryEnd || view.getUint32(p, true) !== CENTRAL_HEADER) {
        throw new Error(`Corrupt zip archive: central directory entry ${i2 + 1} of ${count} is damaged.`);
      }
      const flags = view.getUint16(p + 8, true);
      const nameLength = view.getUint16(p + 28, true);
      const extraLength = view.getUint16(p + 30, true);
      const commentLength = view.getUint16(p + 32, true);
      const nameStart = p + 46;
      if (nameStart + nameLength + extraLength > directoryEnd) {
        throw new Error(`Corrupt zip archive: central directory entry ${i2 + 1} of ${count} is truncated.`);
      }
      const entry = {
        name: decodeName(bytes.subarray(nameStart, nameStart + nameLength), (flags & 2048) !== 0),
        method: view.getUint16(p + 10, true),
        crc32: view.getUint32(p + 16, true),
        compressedSize: view.getUint32(p + 20, true),
        size: view.getUint32(p + 24, true),
        headerOffset: view.getUint32(p + 42, true),
        encrypted: (flags & 1) !== 0
      };
      applyZip64Extra(view, nameStart + nameLength, extraLength, entry);
      entry.headerOffset += shift;
      entries.push(entry);
      p = nameStart + nameLength + extraLength + commentLength;
    }
    return entries;
  }
  function readZipEntry(bytes, entry) {
    const what = `zip member '${entry.name}'`;
    if (entry.encrypted) throw new Error(`${what} is encrypted, which is not supported.`);
    if (entry.method !== 0 && entry.method !== 8) {
      throw new Error(`${what} uses compression method ${entry.method}; only stored and DEFLATE members are supported.`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header = entry.headerOffset;
    if (header + 30 > bytes.length || view.getUint32(header, true) !== LOCAL_HEADER) {
      throw new Error(`Corrupt zip archive: the local header of ${what} is missing.`);
    }
    const start = header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
    const end = start + entry.compressedSize;
    if (end > bytes.length) throw new Error(`Zip archive is truncated: ${what} extends past the end of the file.`);
    const raw = bytes.subarray(start, end);
    let data;
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.size) throw new Error(`Corrupt zip archive: stored ${what} has inconsistent sizes.`);
      data = raw;
    } else {
      data = inflateExact(raw, entry.size, what);
    }
    if (crc32(data) !== entry.crc32) throw new Error(`${what} fails its CRC-32 check; the archive is corrupt.`);
    return data;
  }
  function writeZip(files, compress) {
    if (files.length > 65535) throw new Error(`A zip archive holds at most 65535 members (got ${files.length}).`);
    const members = files.map((file) => {
      const name = encodeUtf8(file.name);
      if (name.length > 65535) throw new Error(`Zip member name '${file.name.slice(0, 40)}\u2026' is too long.`);
      const data = compress ? deflateSync(file.data, { level: 6 }) : file.data;
      if (file.data.length >= MAX32 || data.length >= MAX32) {
        throw new Error(`Zip member '${file.name}' is ${file.data.length} bytes; members of 4 GB and more are not supported.`);
      }
      const flags = name.length !== file.name.length ? 2048 : 0;
      return { name, data, flags, size: file.data.length, crc: crc32(file.data), offset: 0 };
    });
    const method = compress ? 8 : 0;
    let size = 22;
    for (const member of members) size += 30 + 46 + 2 * member.name.length + member.data.length;
    if (size >= MAX32) throw new Error("The zip archive would reach 4 GB, which is not supported.");
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    let p = 0;
    for (const member of members) {
      member.offset = p;
      view.setUint32(p, LOCAL_HEADER, true);
      writeCommonFields(view, p + 4, member.flags, method, member.crc, member.data.length, member.size, member.name.length);
      view.setUint16(p + 28, 0, true);
      out.set(member.name, p + 30);
      out.set(member.data, p + 30 + member.name.length);
      p += 30 + member.name.length + member.data.length;
    }
    const directoryOffset = p;
    for (const member of members) {
      view.setUint32(p, CENTRAL_HEADER, true);
      view.setUint16(p + 4, 20, true);
      writeCommonFields(view, p + 6, member.flags, method, member.crc, member.data.length, member.size, member.name.length);
      view.setUint32(p + 42, member.offset, true);
      out.set(member.name, p + 46);
      p += 46 + member.name.length;
    }
    view.setUint32(p, EOCD, true);
    view.setUint16(p + 8, members.length, true);
    view.setUint16(p + 10, members.length, true);
    view.setUint32(p + 12, p - directoryOffset, true);
    view.setUint32(p + 16, directoryOffset, true);
    return out;
  }
  function writeCommonFields(view, p, flags, method, crc, compressedSize2, size, nameLength) {
    view.setUint16(p, 20, true);
    view.setUint16(p + 2, flags, true);
    view.setUint16(p + 4, method, true);
    view.setUint16(p + 6, 0, true);
    view.setUint16(p + 8, 1 << 5 | 1, true);
    view.setUint32(p + 10, crc, true);
    view.setUint32(p + 14, compressedSize2, true);
    view.setUint32(p + 18, size, true);
    view.setUint16(p + 22, nameLength, true);
  }
  function findEndOfCentralDirectory(view) {
    const last = view.byteLength - 22;
    for (let p = last; p >= 0 && p >= last - 65535; p--) {
      if (view.getUint32(p, true) === EOCD && p + 22 + view.getUint16(p + 20, true) <= view.byteLength) return p;
    }
    throw new Error("Not a zip archive, or a truncated one: the end-of-central-directory record is missing.");
  }
  function applyZip64Extra(view, start, length, entry) {
    const end = start + length;
    for (let p = start; p + 4 <= end; ) {
      const id = view.getUint16(p, true);
      const fieldLength = view.getUint16(p + 2, true);
      if (id === 1) {
        let q = p + 4;
        const fieldEnd = Math.min(q + fieldLength, end);
        const next = () => {
          if (q + 8 > fieldEnd) throw new Error(`Corrupt zip archive: the ZIP64 field of '${entry.name}' is too short.`);
          const value = readUint64(view, q);
          q += 8;
          return value;
        };
        if (entry.size === MAX32) entry.size = next();
        if (entry.compressedSize === MAX32) entry.compressedSize = next();
        if (entry.headerOffset === MAX32) entry.headerOffset = next();
        return;
      }
      p += 4 + fieldLength;
    }
  }
  function readUint64(view, p) {
    return view.getUint32(p + 4, true) * 4294967296 + view.getUint32(p, true);
  }
  function decodeName(bytes, utf84) {
    if (utf84) return new TextDecoder("utf-8").decode(bytes);
    let name = "";
    for (const byte of bytes) name += String.fromCharCode(byte);
    return name;
  }
  function encodeUtf8(text2) {
    const out = [];
    for (const char of text2) {
      const c = char.codePointAt(0);
      if (c < 128) out.push(c);
      else if (c < 2048) out.push(192 | c >> 6, 128 | c & 63);
      else if (c < 65536) out.push(224 | c >> 12, 128 | c >> 6 & 63, 128 | c & 63);
      else out.push(240 | c >> 18, 128 | c >> 12 & 63, 128 | c >> 6 & 63, 128 | c & 63);
    }
    return Uint8Array.from(out);
  }

  // src/sim/io/npz.ts
  function readNpz(bytes) {
    const arrays = /* @__PURE__ */ new Map();
    for (const entry of readZipDirectory(bytes)) {
      if (!entry.name.endsWith(".npy")) continue;
      try {
        arrays.set(entry.name.slice(0, -4), readNpy(readZipEntry(bytes, entry)));
      } catch (error) {
        throw new Error(`NPZ member '${entry.name}': ${messageOf(error)}`);
      }
    }
    return arrays;
  }
  function writeNpz(entries, options = {}) {
    const files = [];
    const seen = /* @__PURE__ */ new Set();
    for (const [key, array] of entries) {
      if (seen.has(key)) throw new Error(`Duplicate NPZ key '${key}'.`);
      seen.add(key);
      files.push({ name: `${key}.npy`, data: writeNpy(array) });
    }
    return writeZip(files, options.compress ?? false);
  }

  // src/sim/io/export.ts
  var NON_CARTESIAN = 0.05;
  function buildExport(job, signal, format) {
    const coils = job.plan.coils;
    if (signal.length !== 2 * coils * job.plan.adcSamples) throw new Error("The signal does not match the job.");
    if (format === "npz") return { name: ".npz", mime: "application/zip", bytes: numpyExport(job, signal) };
    const recon = job.reconstruct(new Float64Array(signal.length));
    const cartesian = recon.offGridFraction <= NON_CARTESIAN;
    const grid = {
      delta: cartesian ? recon.delta : null,
      axes: recon.axes,
      nu: recon.nu,
      nv: recon.nv,
      offset: recon.offset,
      wAxis: recon.wAxis,
      nw: recon.nw,
      deltaW: recon.deltaW,
      offsetW: recon.offsetW
    };
    const plan = planExport(job.rawLayout(), grid);
    const xml = buildIsmrmrdHeaderXml(headerInfo(job, plan, grid, cartesian));
    const acquisitions = ismrmrdAcquisitions(job, signal, plan, cartesian);
    if (format === "ismrmrd-h5") return { name: ".h5", mime: "application/x-hdf5", bytes: writeIsmrmrdHdf5(xml, acquisitions) };
    return { name: ".bin", mime: "application/octet-stream", bytes: writeIsmrmrdStream(xml, acquisitions) };
  }
  var LIMIT_OF = {
    kspace_encode_step_1: "kspace_encoding_step_1",
    kspace_encode_step_2: "kspace_encoding_step_2",
    average: "average",
    slice: "slice",
    contrast: "contrast",
    phase: "phase",
    repetition: "repetition",
    set: "set",
    segment: "segment"
  };
  function headerInfo(job, plan, grid, cartesian) {
    const timing = detectSequenceTiming(job.program.sequence);
    const fov = job.fieldOfView;
    const p = job.plan;
    const planes = grid.nw && grid.nw > 1 && grid.deltaW ? grid.nw : 1;
    const fieldOfView_mm = fov ? { x: fov[0] * 1e3, y: fov[1] * 1e3, z: Math.max(fov[2], 0) * 1e3 } : grid.delta ? { x: 1e3 / grid.delta[0], y: 1e3 / grid.delta[1], z: planes > 1 ? 1e3 / grid.deltaW : 1 } : { x: p.phantom.fov[0] * 1e3, y: p.phantom.fov[1] * 1e3, z: 1 };
    const matrixSize = { x: grid.nu, y: grid.nv, z: planes };
    const encodingLimits = {
      kspace_encoding_step_0: { minimum: 0, maximum: Math.max(0, grid.nu - 1), center: grid.nu >> 1 }
    };
    for (const counter of COUNTERS) encodingLimits[LIMIT_OF[counter]] = plan.limits[counter];
    const userParameterString = [
      { name: "seqeyes_simulation", value: "SeqEyes Bloch simulation (reference engine, cpu-f64)" },
      { name: "seqeyes_phantom", value: p.phantom.source },
      { name: "seqeyes_signal_convention", value: "delivered signal proportional to exp(-i omega t): inverse FFT reconstructs" },
      { name: "seqeyes_counters_from_labels", value: plan.labelled.join(",") || "none (kspace_encode_step_1 from the k-space grid)" }
    ];
    const userParameterLong = [
      { name: "seqeyes_spins", value: p.spins },
      { name: "seqeyes_simulated_spins", value: p.simulated },
      { name: "seqeyes_spins_per_voxel_x", value: p.subSpins[0] },
      { name: "seqeyes_spins_per_voxel_y", value: p.subSpins[1] }
    ];
    for (const counter of COUNTERS) {
      if (plan.counterOffsets[counter] !== 0) userParameterLong.push({ name: `seqeyes_label_offset_${counter}`, value: plan.counterOffsets[counter] });
    }
    const protocolName = job.program.sequence.definitionsRaw.get("Name");
    return {
      H1resonanceFrequency_Hz: Math.round(p.gamma * p.b0),
      receiverChannels: p.coils,
      systemFieldStrength_T: p.b0,
      encodedSpace: { matrixSize, fieldOfView_mm },
      reconSpace: { matrixSize, fieldOfView_mm },
      trajectory: cartesian ? "cartesian" : "other",
      encodingLimits,
      sequenceParameters: {
        TR: timing.trTimeSec > 0 ? [timing.trTimeSec * 1e3] : void 0,
        TE: timing.hasExplicitTE && timing.teTimeSec > 0 ? [timing.teTimeSec * 1e3] : void 0
      },
      measurementInformation: { protocolName: protocolName ? String(protocolName).trim() : "pulseq", patientPosition: "HFS" },
      acquisitionSystemInformation: { systemVendor: "SeqEyes", systemModel: "Bloch simulator" },
      userParameters: { userParameterLong, userParameterString }
    };
  }
  function ismrmrdAcquisitions(job, signal, plan, cartesian) {
    const layout2 = job.rawLayout();
    const coils = layout2.coils;
    const kmax = [0, 0, 0];
    for (let i2 = 0; i2 < layout2.k.length; i2++) kmax[i2 % 3] = Math.max(kmax[i2 % 3], Math.abs(layout2.k[i2]));
    const peak = Math.max(...kmax);
    const trajectoryAxes = cartesian ? [] : [0, 1, 2].filter((axis) => kmax[axis] > 1e-9 * peak);
    const out = [];
    for (let a = 0; a < layout2.acquisitions; a++) {
      const n = layout2.samples[a];
      const data = new Float32Array(coils * n * 2);
      for (let s = 0; s < n; s++) {
        for (let c = 0; c < coils; c++) {
          const src = ((layout2.offsets[a] + s) * coils + c) * 2;
          const dst = (c * n + s) * 2;
          data[dst] = signal[src];
          data[dst + 1] = signal[src + 1];
        }
      }
      const acquisition = plan.acquisitions[a];
      out.push({
        head: acquisitionHeader({
          flags: acquisitionFlags(...acquisition.flags),
          scan_counter: a,
          // ISMRMRD time stamps count 2.5 ms ticks, as the scanners' do.
          acquisition_time_stamp: Math.round(layout2.t0[a] / 25e-4),
          number_of_samples: n,
          active_channels: coils,
          center_sample: acquisition.centerSample,
          trajectory_dimensions: trajectoryAxes.length,
          sample_time_us: layout2.dwell[a] * 1e6,
          read_dir: [1, 0, 0],
          phase_dir: [0, 1, 0],
          slice_dir: [0, 0, 1],
          idx: acquisition.idx
        }),
        traj: trajectoryAxes.length ? normalisedTrajectory(layout2, a, kmax, trajectoryAxes) : new Float32Array(0),
        data
      });
    }
    return out;
  }
  function numpyExport(job, signal) {
    const layout2 = job.rawLayout();
    const coils = layout2.coils;
    const total = signal.length / (2 * coils);
    const uniform = layout2.samples.every((n) => n === layout2.samples[0]);
    const re = new Float32Array(total * coils), im = new Float32Array(total * coils);
    let shape;
    if (uniform) {
      const n = layout2.samples[0];
      shape = [layout2.acquisitions, coils, n];
      for (let a = 0; a < layout2.acquisitions; a++) {
        for (let c = 0; c < coils; c++) {
          for (let s = 0; s < n; s++) {
            const src = ((layout2.offsets[a] + s) * coils + c) * 2;
            const dst = (a * coils + c) * n + s;
            re[dst] = signal[src];
            im[dst] = signal[src + 1];
          }
        }
      }
    } else {
      shape = [total, coils];
      for (let i2 = 0; i2 < total * coils; i2++) {
        re[i2] = signal[2 * i2];
        im[i2] = signal[2 * i2 + 1];
      }
    }
    const entries = /* @__PURE__ */ new Map();
    entries.set("data", { shape, data: re, imag: im });
    entries.set("traj", { shape: [total, 3], data: layout2.k });
    entries.set("offsets", { shape: [layout2.acquisitions], data: layout2.offsets });
    entries.set("t0", { shape: [layout2.acquisitions], data: layout2.t0 });
    entries.set("dwell", { shape: [layout2.acquisitions], data: layout2.dwell });
    const width = layout2.labels.names.length;
    layout2.labels.names.forEach((name, l) => {
      const column = new Int32Array(layout2.acquisitions);
      for (let a = 0; a < layout2.acquisitions; a++) column[a] = layout2.labels.values[a * width + l];
      entries.set(`label_${name}`, { shape: [layout2.acquisitions], data: column });
    });
    const description = {
      format: "SeqEyes simulated raw data",
      signal: "complex64, delivered proportional to exp(-i omega t): an inverse FFT reconstructs",
      data: uniform ? "data[acquisition, coil, sample]" : "data[sample, coil]; readout a is data[offsets[a]:offsets[a] + n_a]",
      traj: "k [1/m] per sample (x, y, z), reset at each excitation",
      times: "sample s of readout a is at t0[a] + (s + 0.5) * dwell[a] seconds",
      labels: layout2.labels.names,
      phantom: job.plan.phantom.source,
      spinsPerVoxel: job.plan.subSpins,
      coils,
      b0T: job.plan.b0
    };
    const json = utf83(JSON.stringify(description, null, 1));
    entries.set("metadata_json", { shape: [json.length], data: json });
    return writeNpz(entries);
  }
  function utf83(text2) {
    const out = [];
    for (const char of text2) {
      const code = char.codePointAt(0);
      if (code < 128) out.push(code);
      else if (code < 2048) out.push(192 | code >> 6, 128 | code & 63);
      else if (code < 65536) out.push(224 | code >> 12, 128 | code >> 6 & 63, 128 | code & 63);
      else out.push(240 | code >> 18, 128 | code >> 12 & 63, 128 | code >> 6 & 63, 128 | code & 63);
    }
    return Uint8Array.from(out);
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
    for (let i2 = 0; i2 < n / 2; i2++) {
      const angle = -2 * Math.PI * i2 / n;
      cos[i2] = Math.cos(angle);
      sin[i2] = Math.sin(angle);
    }
    const bits2 = Math.round(Math.log2(n));
    const reverse = new Uint32Array(n);
    for (let i2 = 0; i2 < n; i2++) {
      let r = 0;
      for (let b = 0; b < bits2; b++) if (i2 & 1 << b) r |= 1 << bits2 - 1 - b;
      reverse[i2] = r;
    }
    const table = { cos, sin, reverse };
    twiddleCache.set(n, table);
    return table;
  }
  function fftInPlace(re, im, n) {
    const { cos, sin, reverse } = getTwiddles(n);
    for (let i2 = 0; i2 < n; i2++) {
      const j = reverse[i2];
      if (j > i2) {
        let tmp = re[i2];
        re[i2] = re[j];
        re[j] = tmp;
        tmp = im[i2];
        im[i2] = im[j];
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
      for (let i2 = 0; i2 < count2; i2++) visit(i2 * raster, raster, magnitude[i2], phaseCycles ? phaseCycles[i2] : 0);
      return;
    }
    const points = breakpointCount(shapes);
    if (points < 2) return;
    const first = timeShape[0] * raster;
    const last = timeShape[points - 1] * raster;
    const count = Math.max(1, Math.round((last - first) / raster));
    const width = (last - first) / count;
    let k = 0;
    for (let i2 = 0; i2 < count; i2++) {
      const start = first + i2 * width;
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
    let i2 = 0;
    forEachRasterCell(shapes, (start, width, magnitude, phase) => {
      cells.start[i2] = start;
      cells.width[i2] = width;
      cells.magnitude[i2] = magnitude;
      cells.phaseCycles[i2] = phase;
      i2++;
    });
    return cells;
  }
  function detectPtxTimeShapeChannels(timeShape) {
    const n = timeShape.length;
    if (n < 2) return 0;
    const first = timeShape[0];
    let repeats = 0;
    for (let i2 = 0; i2 < n; i2++) {
      if (timeShape[i2] === first) repeats++;
    }
    if (repeats < 2 || n % repeats !== 0) return 0;
    const perChannel = n / repeats;
    for (let channel = 1; channel < repeats; channel++) {
      const offset = channel * perChannel;
      for (let i2 = 0; i2 < perChannel; i2++) {
        if (timeShape[offset + i2] !== timeShape[i2]) return 0;
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
      const norm3 = Math.hypot(bx, by, frequencyOffsetHz);
      const width = samples.widths[index];
      if (!(norm3 > 0) || !(width > 0)) continue;
      const sine = Math.sin(Math.PI * norm3 * width);
      const localAReal = Math.cos(Math.PI * norm3 * width);
      const localAImaginary = -frequencyOffsetHz / norm3 * sine;
      const localBReal = by / norm3 * sine;
      const localBImaginary = -bx / norm3 * sine;
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
  var DEFAULT_B0_T2 = 3;
  function getB02(seq) {
    const raw = seq.definitions.get("B0");
    if (raw && Array.isArray(raw) && raw.length > 0) return +raw[0];
    const raw2 = seq.definitions.get("b0") ?? seq.definitions.get("b_0");
    if (raw2 && Array.isArray(raw2) && raw2.length > 0) return +raw2[0];
    return DEFAULT_B0_T2;
  }
  function effFreqOff(freqOffset, freqPPM, b0) {
    return freqOffset + freqPPM * 1e-6 * GAMMA_HZ_T2 * b0;
  }
  function effPhaseOff(phaseOffset, phasePPM, b0) {
    return phaseOffset + phasePPM * 1e-6 * GAMMA_HZ_T2 * b0;
  }
  var UNANALYZED_RF_RESPONSE = Object.freeze({
    carrierAreaDeg: NaN,
    bands: [],
    spectrumAnalyzed: false,
    limited: true
  });
  function createSequenceDecodeContext(seq) {
    const blockStartTimes = new Float64Array(seq.blocks.length + 1);
    for (let index = 0; index < seq.blocks.length; index++) {
      blockStartTimes[index + 1] = blockStartTimes[index] + blockDurationSeconds2(seq, seq.blocks[index]);
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
    for (let i2 = s; i2 < e; i2++) {
      const block = seq.blocks[i2];
      const dur = blockDurationSeconds2(seq, block);
      const db = { index: block.num, duration: dur, startTime: cumulative };
      if (block.rfId > 0) {
        const rf = seq.rfs.get(block.rfId);
        if (rf) {
          const use = context.classifiedRfUses[i2];
          let response = context.rfResponseCache.get(rf.id);
          if (!response) {
            response = context.skipRfResponse ? UNANALYZED_RF_RESPONSE : analyzeRfResponse(rf, seq, use);
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
  function blockDurationSeconds2(seq, block) {
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
    for (let i2 = 0; i2 < n; i2++) {
      t[i2] = timeShape ? rfStart + timeShape[i2] * raster : rfStart + (i2 + 0.5) * raster;
      amp[i2] = rf.amplitude * mag[i2];
      const dt = t[i2] - rfStart;
      phase[i2] = 2 * Math.PI * ph[i2] + phaseFull + 2 * Math.PI * freqFull * dt;
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
      for (let i2 = 0; i2 < 4; i2++) {
        tp2[i2 + 1] = gradStart + tRel[i2];
        wf2[i2 + 1] = wfRel[i2];
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
    for (let i2 = 0; i2 < 4; i2++) {
      tp[i2] = gradStart + tRel[i2];
      wf[i2] = wfRel[i2];
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
      for (let i2 = 0; i2 < n; i2++) {
        tp2[i2] = gradStart + timeShape[i2] * raster;
        wf2[i2] = arb.amplitude * shape.samples[i2];
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
      for (let i2 = 0; i2 < n; i2++) {
        tp[i2 + 1] = gradStart + (i2 + 1) * dt;
        wf[i2 + 1] = arb.amplitude * shape.samples[i2];
      }
      tp[n + 1] = gradStart + (n + 1) * dt;
    } else {
      for (let i2 = 0; i2 < n; i2++) {
        tp[i2 + 1] = gradStart + (i2 + 0.5) * raster;
        wf[i2 + 1] = arb.amplitude * shape.samples[i2];
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
    for (let i2 = 1; i2 < magnitude.length; i2++) {
      const v = Math.abs(magnitude[i2]);
      if (v > peak) peak = v;
    }
    const threshold = Math.abs(peak) * 0.99999;
    let firstPeak = -1;
    let lastPeak = -1;
    for (let i2 = 0; i2 < magnitude.length; i2++) {
      if (Math.abs(magnitude[i2]) >= threshold) {
        if (firstPeak < 0) firstPeak = i2;
        lastPeak = i2;
      }
    }
    if (firstPeak < 0 || lastPeak < 0) return startTime + duration * 0.5;
    return 0.5 * (timePoints[Math.min(firstPeak, timePoints.length - 1)] + timePoints[Math.min(lastPeak, timePoints.length - 1)]);
  }
  function findById(items, id) {
    return items.find((item) => item.id === id);
  }

  // src/pulseq/labels.ts
  var COUNTER_ORDER = ["SLC", "SEG", "REP", "AVG", "SET", "ECO", "PHS", "LIN", "PAR", "ACQ", "TRID", "ONCE"];
  var FLAG_ORDER = ["NAV", "REV", "SMS", "REF", "IMA", "OFF", "NOISE", "PMC", "NOROT", "NOPOS", "NOSCL"];
  function labelRank(name) {
    const counter = COUNTER_ORDER.indexOf(name);
    if (counter >= 0) return counter;
    const flag = FLAG_ORDER.indexOf(name);
    return flag >= 0 ? 2e3 + flag : 1e3;
  }
  function labelKind(name) {
    return FLAG_ORDER.includes(name) ? "flag" : "counter";
  }
  function listSequenceLabels(seq) {
    const seen = /* @__PURE__ */ new Set();
    for (const spec of seq.labelSets) seen.add(spec.name);
    for (const spec of seq.labelIncs) seen.add(spec.name);
    const names = [...seen].sort((a, b) => labelRank(a) - labelRank(b) || (a < b ? -1 : a > b ? 1 : 0));
    return { names, kinds: names.map(labelKind) };
  }
  function labelOpsForChain(seq, headId, column, sets, incs) {
    const ops = [];
    const visited = /* @__PURE__ */ new Set();
    let cur = seq.extensions.get(headId);
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id);
      const type = seq.extensionTypes.get(cur.type) ?? 999 /* EXT_UNKNOWN */;
      if (type === 3 /* EXT_LABELSET */ || type === 4 /* EXT_LABELINC */) {
        const increment = type === 4 /* EXT_LABELINC */;
        const spec = increment ? incs.get(cur.ref) : sets.get(cur.ref);
        const index = spec ? column.get(spec.name) : void 0;
        if (spec && index !== void 0) ops.push({ column: index, value: spec.value, increment });
      }
      cur = cur.nextId > 0 ? seq.extensions.get(cur.nextId) : void 0;
    }
    return ops;
  }
  function evaluateAdcLabels(seq) {
    const { names, kinds } = listSequenceLabels(seq);
    const width = names.length;
    const column = new Map(names.map((name, index) => [name, index]));
    const sets = new Map(seq.labelSets.map((spec) => [spec.id, spec]));
    const incs = new Map(seq.labelIncs.map((spec) => [spec.id, spec]));
    let count = 0;
    for (const block of seq.blocks) {
      if (block.adcId > 0 && seq.adcs.has(block.adcId)) count++;
    }
    const timeSec = new Float64Array(count);
    const blockNumbers = new Uint32Array(count);
    const values = new Int32Array(count * width);
    const state = new Int32Array(width);
    const chains = /* @__PURE__ */ new Map();
    let start = 0;
    let row = 0;
    for (const block of seq.blocks) {
      if (width > 0 && block.extId > 0) {
        let ops = chains.get(block.extId);
        if (!ops) {
          ops = labelOpsForChain(seq, block.extId, column, sets, incs);
          chains.set(block.extId, ops);
        }
        for (const op of ops) state[op.column] = op.increment ? state[op.column] + op.value : op.value;
      }
      const adc = block.adcId > 0 ? seq.adcs.get(block.adcId) : void 0;
      if (adc) {
        timeSec[row] = start + adc.delay * 1e-6 + adc.numSamples * adc.dwell * 1e-9 / 2;
        blockNumbers[row] = block.num;
        values.set(state, row * width);
        row++;
      }
      start += blockDurationSeconds2(seq, block);
    }
    const min = new Array(width).fill(0);
    const max2 = new Array(width).fill(0);
    for (let label = 0; label < width; label++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let adc = 0; adc < count; adc++) {
        const value = values[adc * width + label];
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
      if (count > 0) {
        min[label] = lo;
        max2[label] = hi;
      }
    }
    return { names, kinds, count, timeSec, block: blockNumbers, values, min, max: max2 };
  }

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
    for (let i2 = 0; i2 < numSamples; i2++) {
      cumSum += result[i2];
      result[i2] = cumSum;
    }
    return result;
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
  var MAGIC2 = new Uint8Array([1, 112, 117, 108, 115, 101, 113, 2]);
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
    if (bytes.byteLength < MAGIC2.byteLength) return false;
    for (let i2 = 0; i2 < MAGIC2.byteLength; i2++) {
      if (bytes[i2] !== MAGIC2[i2]) return false;
    }
    return true;
  }
  function parseSequenceBinary(bytes) {
    const reader = new BinaryReader(bytes);
    const magic = reader.bytes(MAGIC2.byteLength, "file header");
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
        MAGIC2.byteLength
      );
    }
  }
  function readDefinitions(reader, seq) {
    const count = reader.count64("DEFINITIONS count", 9);
    for (let i2 = 0; i2 < count; i2++) {
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
    for (let i2 = 0; i2 < count; i2++) {
      seq.blocks.push({
        num: i2 + 1,
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
    for (let i2 = 0; i2 < count; i2++) {
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
    for (let i2 = 0; i2 < count; i2++) {
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
    for (let i2 = 0; i2 < count; i2++) {
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
    for (let i2 = 0; i2 < count; i2++) {
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
    for (let i2 = 0; i2 < count; i2++) {
      reader.int32("legacy DELAYS id");
      reader.safeInt64("legacy DELAYS duration");
    }
  }
  function readShapes(reader, seq) {
    const count = reader.count64("SHAPES count", 20);
    seq.shapes.clear();
    for (let i2 = 0; i2 < count; i2++) {
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
    for (let i2 = 0; i2 < count; i2++) {
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
    for (let i2 = 0; i2 < count; i2++) {
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
    for (let i2 = 0; i2 < count; i2++) {
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
    for (let i2 = 0; i2 < count; i2++) {
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
    for (let i2 = 0; i2 < count; i2++) {
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
    for (let i2 = 0; i2 < count; i2++) {
      const id = reader.int32("ROTATIONS id");
      const values = [
        reader.float64("ROTATIONS q0"),
        reader.float64("ROTATIONS qx"),
        reader.float64("ROTATIONS qy"),
        reader.float64("ROTATIONS qz")
      ];
      const norm3 = Math.hypot(...values);
      if (!Number.isFinite(norm3) || norm3 <= 0) reader.fail("invalid zero or non-finite rotation quaternion");
      seq.rotations.push({ id, values: values.map((value) => value / norm3) });
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
      const chunkSize2 = 8192;
      for (let start = 0; start < data.length; start += chunkSize2) {
        const end = Math.min(data.length, start + chunkSize2);
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
  function parseSequenceText(text2) {
    const seq = createEmptySequence();
    const seenSections = /* @__PURE__ */ new Set();
    const shapeParser = new ShapeSectionParser(seq);
    let sectionName = null;
    let sectionLines = [];
    forEachLine(text2, (line) => {
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
  function forEachLine(text2, visit) {
    let start = 0;
    while (start <= text2.length) {
      let end = text2.indexOf("\n", start);
      if (end < 0) end = text2.length;
      const contentEnd = end > start && text2.charCodeAt(end - 1) === 13 ? end - 1 : end;
      visit(text2.slice(start, contentEnd));
      if (end === text2.length) break;
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
    let i2 = 0;
    while (i2 < valid.length) {
      const line = valid[i2].trim();
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
      i2++;
    }
    while (i2 < valid.length) {
      const line = valid[i2].trim();
      const extM = line.match(/^extension\s+(\w+)\s+(\d+)/i);
      if (!extM) {
        i2++;
        continue;
      }
      const extName = extM[1].toUpperCase();
      const extId = +extM[2];
      seq.extensionNames.set(extId, extName);
      seq.extensionTypes.set(extId, extensionNameToType(extName));
      i2++;
      const dataLines = [];
      while (i2 < valid.length && !valid[i2].trim().startsWith("extension ")) {
        dataLines.push(valid[i2].trim());
        i2++;
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
        const norm3 = Math.sqrt(q0 * q0 + q1 * q1 + q2 * q2 + q3 * q3);
        if (Math.abs(norm3 - 1) > 1e-3 || norm3 === 0) {
          parseError(`ROTATIONS row has a non-normalized quaternion: ${line}`);
        }
        seq.rotations.push({
          id: toInt(p[0], "ROTATIONS", line),
          values: [q0 / norm3, q1 / norm3, q2 / norm3, q3 / norm3]
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
    let text2;
    try {
      text2 = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Pulseq parse error: sequence text is not valid UTF-8");
    }
    return parseSequenceText(text2);
  }

  // src/sim/conventions.ts
  var PULSEQ_GAMMA_HZ_PER_T = 42576e3;
  var DEFAULT_B0_T3 = 3;
  function demodulationPhase(phaseOffset, freqOffset, dwell, s, phaseModulation) {
    const t = (s + 0.5) * dwell;
    return phaseOffset + 2 * Math.PI * freqOffset * t + (phaseModulation ? phaseModulation[s] : 0);
  }

  // src/pulseq/physicalGradients.ts
  var GRADIENT_ENDPOINT_TOLERANCE_SEC = 1e-12;
  function rotateGradient(block, gx, gy, gz) {
    const values = block.rotation?.values;
    if (!values) return [gx, gy, gz];
    if (values.length === 4) {
      const [w, x2, y, z] = values;
      const r00 = 1 - 2 * y * y - 2 * z * z;
      const r01 = 2 * x2 * y - 2 * w * z;
      const r02 = 2 * x2 * z + 2 * w * y;
      const r10 = 2 * x2 * y + 2 * w * z;
      const r11 = 1 - 2 * x2 * x2 - 2 * z * z;
      const r12 = 2 * y * z - 2 * w * x2;
      const r20 = 2 * x2 * z - 2 * w * y;
      const r21 = 2 * y * z + 2 * w * x2;
      const r22 = 1 - 2 * x2 * x2 - 2 * y * y;
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
      for (let i2 = 0; i2 < lastReleasable; i2++) this.chunks[i2] = null;
    }
    /** Exact-size copy of every value (none may have been released). */
    toArray() {
      const out = new Float64Array(this.count);
      for (let i2 = 0, offset = 0; offset < this.count; i2++, offset += CHUNK_SIZE) {
        const chunk = this.chunks[i2];
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
        for (let i2 = 0; i2 < n; i2++) this.pushPoint(times[i2], values[i2]);
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
      for (let i2 = start; i2 < n; i2++) this.pushPoint(times[i2], i2 === 0 ? firstValue : values[i2]);
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
      for (let i2 = 0; i2 < values.length; i2++) this.number(values[i2]);
      return this;
    }
    text(value) {
      this.word(value.length);
      for (let i2 = 0; i2 < value.length; i2++) this.word(value.charCodeAt(i2));
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
      for (let i2 = 0; i2 < axis.times.length; i2++) {
        const time = axis.times[i2];
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
  function windowMoments(pieces, a, b) {
    const t = [], ga = [], gb = [];
    const n = pieceCount(pieces);
    for (let piece = 0; piece < n; piece++) {
      const t0 = pieces.t[piece], t1 = pieces.t[piece + 1];
      const u = Math.max(a, t0), v = Math.min(b, t1);
      if (!(v > u)) continue;
      const o = 3 * piece;
      if (!t.length) t.push(u);
      t.push(v);
      for (let axis = 0; axis < 3; axis++) {
        const g0 = pieces.ga[o + axis], g1 = pieces.gb[o + axis];
        ga.push(t1 > t0 ? g0 + (g1 - g0) * (u - t0) / (t1 - t0) : g0);
        gb.push(t1 > t0 ? g0 + (g1 - g0) * (v - t0) / (t1 - t0) : g1);
      }
    }
    if (!t.length) return { dk: new Float64Array(3), kIntegral: new Float64Array(3), kSecond: new Float64Array(6) };
    return piecesMoments({ t: Float64Array.from(t), ga: Float64Array.from(ga), gb: Float64Array.from(gb) });
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
    for (let i2 = 0; i2 < t.length; i2++) {
      t[i2] = Math.round((pieces.t[i2] - t0) / RELATIVE_TIME_QUANTUM_SEC) * RELATIVE_TIME_QUANTUM_SEC;
    }
    return { t, ga: pieces.ga.slice(), gb: pieces.gb.slice() };
  }

  // src/sim/program/compile.ts
  var EVENT_TIME_TOLERANCE_SEC = 1e-9;
  var KEY_TIME_QUANTUM_SEC = 1e-10;
  var KEY_GRADIENT_QUANTUM = 1e6;
  function compileProgram(seq, options = {}) {
    const b0 = options.b0 ?? fileB0(seq) ?? DEFAULT_B0_T3;
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
    if (shim) ctx.ignoredFeatures.add("rf-shims");
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
    for (let i2 = 0; i2 < gradient.ga.length; i2++) {
      if (gradient.ga[i2] !== 0 || gradient.gb[i2] !== 0) activeAxes |= 1 << i2 % 3;
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
    for (let i2 = 0; i2 < stored.t.length; i2++) cuts.push(stored.t[i2]);
    for (let i2 = 0; i2 < event.t.length; i2++) cuts.push(event.t[i2] - t0);
    cuts.sort((a2, b2) => a2 - b2);
    let peak = 0;
    for (const values of [stored.ga, stored.gb, event.ga, event.gb]) {
      for (let i2 = 0; i2 < values.length; i2++) peak = Math.max(peak, Math.abs(values[i2]));
    }
    const tolerance = 1e-6 + 1e-9 * peak;
    const a = new Float64Array(3), b = new Float64Array(3);
    for (let i2 = 1; i2 < cuts.length; i2++) {
      const span = cuts[i2] - cuts[i2 - 1];
      if (!(span > KEY_TIME_QUANTUM_SEC)) continue;
      for (const fraction of [1 / 3, 2 / 3]) {
        const time = cuts[i2 - 1] + fraction * span;
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
    for (let i2 = 0; i2 < n; i2++) {
      if (!(gradient.t[i2 + 1] - gradient.t[i2] > KEY_TIME_QUANTUM_SEC)) continue;
      hasher.number(Math.round((gradient.t[i2] - t0) / KEY_TIME_QUANTUM_SEC));
      hasher.number(Math.round((gradient.t[i2 + 1] - t0) / KEY_TIME_QUANTUM_SEC));
      for (let axis = 0; axis < 3; axis++) {
        hasher.number(Math.round(gradient.ga[3 * i2 + axis] * KEY_GRADIENT_QUANTUM));
        hasher.number(Math.round(gradient.gb[3 * i2 + axis] * KEY_GRADIENT_QUANTUM));
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
    for (let i2 = 0; i2 < seq.blocks.length; i2++) {
      starts[i2] = ticks * tick;
      ticks += softDelays?.get(i2) ?? seq.blocks[i2].dur;
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
    return { ...createSequenceDecodeContext(seq), blockStartTimes, skipRfResponse: true };
  }
  function computeNextPieceBlocks(seq) {
    const n = seq.blocks.length;
    const next = [new Int32Array(n + 1), new Int32Array(n + 1), new Int32Array(n + 1)];
    for (let axis = 0; axis < 3; axis++) next[axis][n] = n;
    const exists = (id) => id > 0 && (seq.trapGrads.has(id) || seq.arbitraryGrads.has(id));
    for (let i2 = n - 1; i2 >= 0; i2--) {
      const block = seq.blocks[i2];
      const logical = [exists(block.gxId), exists(block.gyId), exists(block.gzId)];
      const rotated = logical.some(Boolean) && hasRotation(seq, block.extId);
      for (let axis = 0; axis < 3; axis++) {
        next[axis][i2] = rotated || logical[axis] ? i2 : next[axis][i2 + 1];
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

  // src/sim/engine/pathway.ts
  var FOUR_PI2 = 4 * Math.PI * Math.PI;
  var MainPathway = class {
    constructor() {
      /** Dephasing time since the last excitation, reversed by refocusing [s]. */
      __publicField(this, "tau", 0);
      /** b-value since the last excitation [s/m²]. */
      __publicField(this, "b", 0);
      /** An excitation has happened; before it there is no pathway to weight. */
      __publicField(this, "excited", false);
      /** The pathway's gradient area [1/m]. */
      __publicField(this, "k", new Float64Array(3));
      __publicField(this, "halves", /* @__PURE__ */ new Map());
    }
    /** Free precession (or a readout window) of `dt` with these moments. */
    free(moments, dt) {
      const k = this.k, m1 = moments.kIntegral, m2 = moments.kSecond;
      this.b += FOUR_PI2 * ((k[0] * k[0] + k[1] * k[1] + k[2] * k[2]) * dt + 2 * (k[0] * m1[0] + k[1] * m1[1] + k[2] * m1[2]) + m2[0] + m2[1] + m2[2]);
      k[0] += moments.dk[0];
      k[1] += moments.dk[1];
      k[2] += moments.dk[2];
      this.tau += dt;
    }
    /** An RF pulse: the half before its centre, its action there, the half after. */
    pulse(segment) {
      let half = this.halves.get(segment.key);
      if (!half) {
        half = {
          pre: windowMoments(segment.gradient, segment.t0, segment.centerTime),
          post: windowMoments(segment.gradient, segment.centerTime, segment.t1)
        };
        this.halves.set(segment.key, half);
      }
      this.free(half.pre, segment.centerTime - segment.t0);
      if (segment.use === "e") {
        this.k.fill(0);
        this.tau = 0;
        this.b = 0;
        this.excited = true;
      } else if (segment.use === "r") {
        for (let a = 0; a < 3; a++) this.k[a] = -this.k[a] + 0;
        this.tau = -this.tau;
      }
      this.free(half.post, segment.t1 - segment.centerTime);
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
    const grouper = new ReadoutGrouper(spins, (options.readout ?? "grouped") !== "direct");
    const lattice = (options.readout ?? "lattice") === "lattice";
    const interval = Math.max(1, options.progressInterval ?? 64);
    const free = new PendingFree(new FreeKernel(spins));
    const weighting = PathwayWeighting.of(spins, options.readout ?? "lattice");
    let sampleOffset = 0;
    let processed = 0;
    const until = options.until ?? Infinity;
    for (const segment of program.segments()) {
      if (segment.t0 >= until) break;
      if (segment.kind === "free") {
        free.add(segment.moments.dk, segment.t1 - segment.t0);
        weighting?.pathway.free(segment.moments, segment.t1 - segment.t0);
      } else if (segment.kind === "rf") {
        free.flush(spins, state);
        if (cache) cache.apply(segment, state);
        else applyRf(segment, spins, state);
        weighting?.pathway.pulse(segment);
      } else {
        free.flush(spins, state);
        sampleAdc(segment, spins, state, signal, sampleOffset, grouper, members, area, lattice, weighting);
        sampleOffset += segment.numSamples;
        free.add(segment.moments.dk, segment.t1 - segment.t0);
        weighting?.pathway.free(segment.moments, segment.t1 - segment.t0);
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
    let owners = classes;
    if (members.profileOf) {
      owners = members.profiles ?? 0;
      if (members.profileOf.length !== classes) throw new Error(`${members.profileOf.length} class profiles for ${classes} classes.`);
      for (let c = 0; c < classes; c++) {
        const q = members.profileOf[c];
        if (!(q >= 0 && q < owners)) throw new Error(`Class ${c} names profile ${q} of ${owners}.`);
      }
    }
    for (let m = 0; m < members.count; m++) {
      const c = members.classOf[m], p = members.foldOf[m];
      if (!(c >= 0 && c < owners)) throw new Error(`Member ${m} names ${members.profileOf ? "profile" : "class"} ${c} of ${owners}.`);
      if (!(p >= 0 && p < points)) throw new Error(`Member ${m} names fold point ${p} of ${points}.`);
    }
  }
  var PendingFree = class {
    constructor(kernel) {
      __publicField(this, "kernel", kernel);
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
      this.kernel.apply(this.dk, this.dt, state);
      this.dk.fill(0);
      this.dt = 0;
      this.empty = true;
    }
  };
  var FreeKernel = class {
    constructor(spins) {
      __publicField(this, "spins", spins);
      /** Distinct (x, y, z, Δf) of the spins, and each spin's entry. */
      __publicField(this, "keyOf");
      __publicField(this, "kx");
      __publicField(this, "ky");
      __publicField(this, "kz");
      __publicField(this, "kdf");
      __publicField(this, "cos");
      __publicField(this, "sin");
      /** Per coordinate (x, y, z, Δf): its distinct values, each key's index into them, phasor scratch. */
      __publicField(this, "tables");
      __publicField(this, "relaxation", /* @__PURE__ */ new Map());
      const index = /* @__PURE__ */ new Map();
      const keyOf = new Int32Array(spins.count);
      const x2 = [], y = [], z = [], df = [];
      for (let i2 = 0; i2 < spins.count; i2++) {
        const freq = freeOffset(spins, i2);
        const key = `${spins.x[i2]}|${spins.y[i2]}|${spins.z[i2]}|${freq}`;
        let k = index.get(key);
        if (k === void 0) {
          k = x2.length;
          index.set(key, k);
          x2.push(spins.x[i2]);
          y.push(spins.y[i2]);
          z.push(spins.z[i2]);
          df.push(freq);
        }
        keyOf[i2] = k;
      }
      this.keyOf = keyOf;
      this.kx = Float64Array.from(x2);
      this.ky = Float64Array.from(y);
      this.kz = Float64Array.from(z);
      this.kdf = Float64Array.from(df);
      this.cos = new Float64Array(x2.length);
      this.sin = new Float64Array(x2.length);
      const tables = [this.kx, this.ky, this.kz, this.kdf].map((coordinate) => {
        const distinct = /* @__PURE__ */ new Map();
        const at = new Int32Array(coordinate.length);
        for (let k = 0; k < coordinate.length; k++) {
          let j = distinct.get(coordinate[k]);
          if (j === void 0) distinct.set(coordinate[k], j = distinct.size);
          at[k] = j;
        }
        const values = new Float64Array(distinct.size);
        for (const [value, j] of distinct) values[j] = value;
        return { values, index: at, cos: new Float64Array(values.length), sin: new Float64Array(values.length) };
      });
      const tableSize = tables.reduce((sum, table) => sum + table.values.length, 0);
      this.tables = tableSize * 4 < x2.length ? tables : null;
    }
    apply(dk, dt, state) {
      const twoPi = 2 * Math.PI;
      if (this.tables) {
        this.factorisedPhasors(dk, dt);
      } else {
        for (let k = 0; k < this.kx.length; k++) {
          const cycles = dk[0] * this.kx[k] + dk[1] * this.ky[k] + dk[2] * this.kz[k] + this.kdf[k] * dt;
          const angle = twoPi * (cycles - Math.round(cycles));
          this.cos[k] = Math.cos(angle);
          this.sin[k] = Math.sin(angle);
        }
      }
      const { e1, e2 } = this.factors(dt);
      const { mx, my, mz } = state;
      const keyOf = this.keyOf, cosT = this.cos, sinT = this.sin;
      for (let i2 = 0; i2 < this.spins.count; i2++) {
        const k = keyOf[i2];
        const c = cosT[k] * e2[i2], sn = sinT[k] * e2[i2];
        const x2 = mx[i2], y = my[i2];
        mx[i2] = x2 * c - y * sn;
        my[i2] = x2 * sn + y * c;
        mz[i2] = mz[i2] * e1[i2] + (1 - e1[i2]);
      }
    }
    /** Each key's phasor as the product of its coordinates' factors (only those that turn). */
    factorisedPhasors(dk, dt) {
      const tables = this.tables;
      const scales = [dk[0], dk[1], dk[2], dt];
      const active = [];
      for (let a = 0; a < 4; a++) {
        if (scales[a] === 0) continue;
        const table = tables[a];
        let turns = false;
        for (let j = 0; j < table.values.length; j++) {
          const cycles = scales[a] * table.values[j];
          const angle = 2 * Math.PI * (cycles - Math.round(cycles));
          table.cos[j] = Math.cos(angle);
          table.sin[j] = Math.sin(angle);
          if (angle !== 0) turns = true;
        }
        if (turns) active.push(a);
      }
      const keys = this.cos.length;
      if (!active.length) {
        this.cos.fill(1);
        this.sin.fill(0);
        return;
      }
      const first = tables[active[0]];
      for (let k = 0; k < keys; k++) {
        const j = first.index[k];
        this.cos[k] = first.cos[j];
        this.sin[k] = first.sin[j];
      }
      for (let n = 1; n < active.length; n++) {
        const table = tables[active[n]];
        for (let k = 0; k < keys; k++) {
          const j = table.index[k];
          const fc = table.cos[j], fs = table.sin[j];
          const c = this.cos[k], s = this.sin[k];
          this.cos[k] = c * fc - s * fs;
          this.sin[k] = c * fs + s * fc;
        }
      }
    }
    /** E1 and E2 of every spin for an interval, cached for the lengths that recur. */
    factors(dt) {
      let entry = this.relaxation.get(dt);
      if (entry) return entry;
      const n = this.spins.count;
      entry = { e1: new Float64Array(n), e2: new Float64Array(n) };
      for (let i2 = 0; i2 < n; i2++) {
        entry.e1[i2] = Math.exp(-dt * this.spins.r1[i2]);
        entry.e2[i2] = Math.exp(-dt * this.spins.r2[i2]);
      }
      if (this.relaxation.size >= FREE_CACHE_LENGTHS) this.relaxation.clear();
      this.relaxation.set(dt, entry);
      return entry;
    }
  };
  var FREE_CACHE_LENGTHS = 32;
  function freeOffset(spins, i2) {
    return spins.dfFree ? spins.df[i2] + spins.dfFree[i2] : spins.df[i2];
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
    for (let i2 = 0; i2 < spins.count; i2++) stepRfSpin(cells, spins, i2, state);
  }
  function stepRfSpin(cells, spins, i2, state) {
    const out = stepRfVector(cells, spins, i2, state.mx[i2], state.my[i2], state.mz[i2]);
    state.mx[i2] = out[0];
    state.my[i2] = out[1];
    state.mz[i2] = out[2];
  }
  function stepRfVector(cells, spins, i2, x2, y, z) {
    {
      const c2 = Math.cos(cells.phaseIn), s2 = Math.sin(cells.phaseIn);
      const nx = x2 * c2 + y * s2, ny = -x2 * s2 + y * c2;
      x2 = nx;
      y = ny;
    }
    const sx = spins.x[i2], sy = spins.y[i2], sz = spins.z[i2];
    const offset = spins.df[i2] - cells.freq;
    const r1 = spins.r1[i2], r2 = spins.r2[i2];
    const bRe = spins.b1Re[i2], bIm = spins.b1Im[i2];
    for (let j = 0; j < cells.count; j++) {
      const w = cells.width[j];
      const half = 0.5 * w;
      const e2h = Math.exp(-half * r2), e1h = Math.exp(-half * r1);
      x2 *= e2h;
      y *= e2h;
      z = z * e1h + (1 - e1h);
      const bx = cells.b1Re[j] * bRe - cells.b1Im[j] * bIm;
      const by = cells.b1Re[j] * bIm + cells.b1Im[j] * bRe;
      const bz = cells.grad[3 * j] * sx + cells.grad[3 * j + 1] * sy + cells.grad[3 * j + 2] * sz + offset;
      [x2, y, z] = rotateCayleyKlein(x2, y, z, bx, by, bz, w);
      x2 *= e2h;
      y *= e2h;
      z = z * e1h + (1 - e1h);
    }
    const c = Math.cos(cells.phaseOut), s = Math.sin(cells.phaseOut);
    return [x2 * c - y * s, x2 * s + y * c, z];
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
      for (let i2 = 0; i2 < this.spins.count; i2++) {
        const o = 12 * i2;
        const vx = mx[i2] * cp + my[i2] * sp;
        const vy = -mx[i2] * sp + my[i2] * cp;
        const vz = mz[i2];
        const wx = map[o] * vx + map[o + 1] * vy + map[o + 2] * vz + map[o + 9];
        const wy = map[o + 3] * vx + map[o + 4] * vy + map[o + 5] * vz + map[o + 10];
        const wz = map[o + 6] * vx + map[o + 7] * vy + map[o + 8] * vz + map[o + 11];
        mx[i2] = wx * cp - wy * sp;
        my[i2] = wx * sp + wy * cp;
        mz[i2] = wz;
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
      for (let i2 = 0; i2 < spins.count; i2++) {
        let signature = `${spins.df[i2]}|${spins.r1[i2]}|${spins.r2[i2]}|${spins.b1Re[i2]}|${spins.b1Im[i2]}`;
        for (let axis = 0; axis < 3; axis++) if (active[axis]) signature += `|${coordinates[axis][i2]}`;
        const twin = built.get(signature);
        if (twin !== void 0) {
          map.copyWithin(12 * i2, 12 * twin, 12 * twin + 12);
          continue;
        }
        built.set(signature, i2);
        const c = stepRfVector(cells, spins, i2, 0, 0, 0);
        const ex = stepRfVector(cells, spins, i2, 1, 0, 0);
        const ey = stepRfVector(cells, spins, i2, 0, 1, 0);
        const ez = stepRfVector(cells, spins, i2, 0, 0, 1);
        const o = 12 * i2;
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
  function sinc(x2) {
    const px = Math.PI * x2;
    if (Math.abs(px) < 1e-4) return 1 - px * px / 6;
    return Math.sin(px) / px;
  }
  function rotateCayleyKlein(x2, y, z, bx, by, bz, w) {
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
    const nx = a2Re * x2 - a2Im * y - (b2Re * x2 + b2Im * y) + 2 * abRe * z;
    const ny = a2Re * y + a2Im * x2 - (b2Im * x2 - b2Re * y) + 2 * abIm * z;
    const pRe = aRe * bRe - aIm * bIm;
    const pIm = aRe * bIm + aIm * bRe;
    const nz = -2 * (pRe * x2 + pIm * y) + (aRe * aRe + aIm * aIm - bRe * bRe - bIm * bIm) * z;
    return [nx, ny, nz];
  }
  function groupLattice(groups, axis) {
    groups.lattices ?? (groups.lattices = []);
    const cached = groups.lattices[axis];
    if (cached !== void 0) return cached;
    const position = axis === 0 ? groups.x : axis === 1 ? groups.y : groups.z;
    const values = Float64Array.from(position).sort();
    let result = null;
    if (values.length) {
      const origin = values[0];
      let pitch = Infinity;
      for (let i2 = 1; i2 < values.length; i2++) {
        const gap = values[i2] - values[i2 - 1];
        if (gap > 1e-12 * Math.max(1, Math.abs(values[i2])) && gap < pitch) pitch = gap;
      }
      if (!Number.isFinite(pitch)) pitch = 1;
      const span = Math.round((values[values.length - 1] - origin) / pitch) + 1;
      const slot = new Int32Array(groups.count);
      let onLattice = span <= 1 << 22;
      for (let g = 0; g < groups.count && onLattice; g++) {
        const offset = (position[g] - origin) / pitch;
        slot[g] = Math.round(offset);
        if (Math.abs(offset - slot[g]) > 1e-6) onLattice = false;
      }
      if (onLattice) result = { origin, pitch, span, slot };
    }
    groups.lattices[axis] = result;
    return result;
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
      const x2 = [], y = [], z = [], df = [], r2 = [];
      for (let i2 = 0; i2 < spins.count; i2++) {
        const gx = mask < 0 || mask & 1 ? spins.x[i2] : 0;
        const gy = mask < 0 || mask & 2 ? spins.y[i2] : 0;
        const gz = mask < 0 || mask & 4 ? spins.z[i2] : 0;
        let group;
        if (mask >= 0) {
          const signature = `${gx}|${gy}|${gz}|${freeOffset(spins, i2)}|${spins.r2[i2]}`;
          group = index.get(signature);
          if (group === void 0) {
            group = x2.length;
            index.set(signature, group);
          }
        } else {
          group = x2.length;
        }
        if (group === x2.length) {
          x2.push(gx);
          y.push(gy);
          z.push(gz);
          df.push(freeOffset(spins, i2));
          r2.push(spins.r2[i2]);
        }
        groupOf[i2] = group;
      }
      return {
        count: x2.length,
        groupOf,
        x: Float64Array.from(x2),
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
    for (let i2 = 0; i2 < spins.count; i2++) {
      const mx = state.mx[i2], my = state.my[i2];
      if (mx === 0 && my === 0) continue;
      any = true;
      const w = spins.weight[i2];
      const g = groups.groupOf[i2];
      for (let c = 0; c < coils; c++) {
        const rr = spins.rxRe[c * spins.count + i2];
        const ri = -spins.rxIm[c * spins.count + i2];
        gRe[g * coils + c] += w * (rr * mx - ri * my);
        gIm[g * coils + c] += w * (rr * my + ri * mx);
      }
    }
    return any;
  }
  function sumMembers(members, spins, groups, state, area, gRe, gIm) {
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
    const profiles = members.profileOf ? profileSums(members, spins, groups, state) : null;
    if (profiles && !profiles.shared) return sumMembersByClass(members, spins, groups, state, pRe, pIm, gRe, gIm);
    const sx = profiles ? profiles.mx : state.mx, sy = profiles ? profiles.my : state.my;
    const groupOf = profiles ? profiles.groupOf : groups.groupOf;
    let any = false;
    for (let m = 0; m < members.count; m++) {
      const k = members.classOf[m];
      const cx = sx[k], cy = sy[k];
      if (cx === 0 && cy === 0) continue;
      any = true;
      const p = members.foldOf[m];
      const mx = cx * pRe[p] - cy * pIm[p];
      const my = cx * pIm[p] + cy * pRe[p];
      const w = members.weight[m];
      const g = groupOf[k];
      for (let c = 0; c < coils; c++) {
        const rr = members.rxRe[c * members.count + m];
        const ri = -members.rxIm[c * members.count + m];
        gRe[g * coils + c] += w * (rr * mx - ri * my);
        gIm[g * coils + c] += w * (rr * my + ri * mx);
      }
    }
    return any;
  }
  function profileSums(members, spins, groups, state) {
    const count = members.profiles ?? 0;
    const profileOf = members.profileOf;
    const mx = new Float64Array(count), my = new Float64Array(count);
    const groupOf = new Int32Array(count).fill(-1);
    let shared = true;
    for (let c = 0; c < spins.count; c++) {
      const q = profileOf[c];
      const g = groups.groupOf[c];
      if (groupOf[q] < 0) groupOf[q] = g;
      else if (groupOf[q] !== g) shared = false;
      mx[q] += spins.weight[c] * state.mx[c];
      my[q] += spins.weight[c] * state.my[c];
    }
    return { mx, my, groupOf, shared };
  }
  function sumMembersByClass(members, spins, groups, state, pRe, pIm, gRe, gIm) {
    const coils = members.coils;
    const count = members.profiles ?? 0;
    const profileOf = members.profileOf;
    const start = new Int32Array(count + 1);
    for (let c = 0; c < spins.count; c++) start[profileOf[c] + 1]++;
    for (let q = 0; q < count; q++) start[q + 1] += start[q];
    const fill = start.slice(0, count);
    const classes = new Int32Array(spins.count);
    for (let c = 0; c < spins.count; c++) classes[fill[profileOf[c]]++] = c;
    let any = false;
    for (let m = 0; m < members.count; m++) {
      const q = members.classOf[m];
      const p = members.foldOf[m];
      for (let i2 = start[q]; i2 < start[q + 1]; i2++) {
        const k = classes[i2];
        const cx = state.mx[k] * spins.weight[k], cy = state.my[k] * spins.weight[k];
        if (cx === 0 && cy === 0) continue;
        any = true;
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
    }
    return any;
  }
  var LATTICE_MAX_TERMS = 24;
  var LATTICE_TOLERANCE = 1e-13;
  function synthesizeOnLattice(segment, groups, gRe, gIm, coils, k, times, sumRe, sumIm) {
    const axes = segment.activeAxes & 7;
    const axis = axes === 1 ? 0 : axes === 2 ? 1 : axes === 4 ? 2 : -1;
    if (axis < 0) return false;
    const lattice = groupLattice(groups, axis);
    if (!lattice) return false;
    const { origin, pitch, span } = lattice;
    const n = segment.numSamples;
    const active = [];
    let zRe = 0, zIm = 0;
    for (let g = 0; g < groups.count; g++) {
      let nonzero = false;
      for (let c = 0; c < coils; c++) if (gRe[g * coils + c] !== 0 || gIm[g * coils + c] !== 0) nonzero = true;
      if (!nonzero) continue;
      active.push(g);
      zRe -= groups.r2[g];
      zIm += 2 * Math.PI * groups.df[g];
    }
    if (active.length < 64) return false;
    zRe /= active.length;
    zIm /= active.length;
    const tauMax = times[n - 1] - segment.t0;
    let spread = 0;
    for (const g of active) {
      const dRe = -groups.r2[g] - zRe, dIm = 2 * Math.PI * groups.df[g] - zIm;
      spread = Math.max(spread, Math.sqrt(dRe * dRe + dIm * dIm));
    }
    spread *= tauMax;
    let terms = 1, bound = Math.exp(spread);
    for (; terms <= LATTICE_MAX_TERMS; terms++) {
      bound *= spread / terms;
      if (bound < LATTICE_TOLERANCE) break;
    }
    if (terms > LATTICE_MAX_TERMS) return false;
    if (span * (1 + terms * coils) > 0.5 * active.length * (1 + coils) || span * terms * coils > 4e6) return false;
    const slot = lattice.slot;
    const stride = span * coils;
    const cRe = new Float64Array(terms * stride), cIm = new Float64Array(terms * stride);
    for (let i2 = 0; i2 < active.length; i2++) {
      const g = active[i2];
      const dRe = -groups.r2[g] - zRe, dIm = 2 * Math.PI * groups.df[g] - zIm;
      let pRe2 = 1, pIm2 = 0;
      for (let m = 0; m < terms; m++) {
        for (let c = 0; c < coils; c++) {
          const ar = gRe[g * coils + c], ai = gIm[g * coils + c];
          const o = m * stride + slot[g] * coils + c;
          cRe[o] += ar * pRe2 - ai * pIm2;
          cIm[o] += ar * pIm2 + ai * pRe2;
        }
        const nr = (pRe2 * dRe - pIm2 * dIm) / (m + 1);
        pIm2 = (pRe2 * dIm + pIm2 * dRe) / (m + 1);
        pRe2 = nr;
      }
    }
    const pStride = n * coils;
    const pRe = new Float64Array(terms * pStride), pIm = new Float64Array(terms * pStride);
    const twoPi = 2 * Math.PI;
    const step = k[3 + axis] - k[axis];
    for (let j = 0; j < span; j++) {
      let any = false;
      for (let m = 0; m < terms && !any; m++) {
        for (let c = 0; c < coils; c++) if (cRe[m * stride + j * coils + c] !== 0 || cIm[m * stride + j * coils + c] !== 0) any = true;
      }
      if (!any) continue;
      const x2 = origin + j * pitch;
      const stepCycles = step * x2;
      const stepAngle = twoPi * (stepCycles - Math.round(stepCycles));
      const sRe = Math.cos(stepAngle), sIm = Math.sin(stepAngle);
      let eRe = 0, eIm = 0;
      for (let s = 0; s < n; s++) {
        if (s % RECURRENCE_ANCHOR === 0) {
          const cycles = k[3 * s + axis] * x2;
          const angle = twoPi * (cycles - Math.round(cycles));
          eRe = Math.cos(angle);
          eIm = Math.sin(angle);
        } else {
          const nr = eRe * sRe - eIm * sIm;
          eIm = eRe * sIm + eIm * sRe;
          eRe = nr;
        }
        for (let m = 0; m < terms; m++) {
          for (let c = 0; c < coils; c++) {
            const o = m * stride + j * coils + c;
            const ar = cRe[o], ai = cIm[o];
            const q = m * pStride + s * coils + c;
            pRe[q] += ar * eRe - ai * eIm;
            pIm[q] += ar * eIm + ai * eRe;
          }
        }
      }
    }
    for (let s = 0; s < n; s++) {
      const tau = times[s] - segment.t0;
      const decay = Math.exp(zRe * tau);
      const turns = zIm * tau / twoPi;
      const angle = twoPi * (turns - Math.round(turns));
      const wRe = decay * Math.cos(angle), wIm = decay * Math.sin(angle);
      for (let c = 0; c < coils; c++) {
        let accRe = 0, accIm = 0, power = 1;
        for (let m = 0; m < terms; m++) {
          const q = m * pStride + s * coils + c;
          accRe += pRe[q] * power;
          accIm += pIm[q] * power;
          power *= tau;
        }
        sumRe[s * coils + c] += accRe * wRe - accIm * wIm;
        sumIm[s * coils + c] += accRe * wIm + accIm * wRe;
      }
    }
    return true;
  }
  var RECURRENCE_ANCHOR = 64;
  var PathwayWeighting = class _PathwayWeighting {
    constructor(spins, grouped) {
      __publicField(this, "spins", spins);
      __publicField(this, "grouped", grouped);
      __publicField(this, "pathway", new MainPathway());
      __publicField(this, "groupers", /* @__PURE__ */ new Map());
      /** Each spin's (D, R2′) pair, and the distinct pairs. */
      __publicField(this, "pairOf");
      __publicField(this, "pairs", []);
      __publicField(this, "factor");
      __publicField(this, "mx");
      __publicField(this, "my");
      const index = /* @__PURE__ */ new Map();
      this.pairOf = new Int32Array(spins.count);
      for (let i2 = 0; i2 < spins.count; i2++) {
        const adc = spins.adc ? Math.max(0, spins.adc[i2]) : 0, rate2 = spins.r2prime ? Math.max(0, spins.r2prime[i2]) : 0;
        const key = `${adc}|${rate2}`;
        let p = index.get(key);
        if (p === void 0) {
          p = this.pairs.length;
          index.set(key, p);
          this.pairs.push({ adc, rate: rate2 });
        }
        this.pairOf[i2] = p;
      }
      this.factor = new Float64Array(this.pairs.length);
      this.mx = new Float64Array(spins.count);
      this.my = new Float64Array(spins.count);
    }
    static of(spins, readout) {
      const used = (values) => !!values && values.some((v) => v > 0);
      return used(spins.r2prime) || used(spins.adc) ? new _PathwayWeighting(spins, readout !== "direct") : null;
    }
    /** Groupings whose decay rate is R2 + sign·R2′. */
    grouper(sign) {
      let grouper = this.groupers.get(sign);
      if (!grouper) {
        const { r2, r2prime } = this.spins;
        const rate2 = r2prime ? Float64Array.from(r2, (v, i2) => v + sign * Math.max(0, r2prime[i2])) : r2;
        grouper = new ReadoutGrouper({ ...this.spins, r2: rate2 }, this.grouped);
        this.groupers.set(sign, grouper);
      }
      return grouper;
    }
    /** The state scaled per spin by e^{−bD}·e^{−sign·R2′·τ} (τ at the window start); reuses its buffers. */
    scaled(state, sign) {
      const { tau, b } = this.pathway;
      this.pairs.forEach((pair, p) => {
        this.factor[p] = Math.exp(-b * pair.adc - sign * pair.rate * tau);
      });
      const { mx, my, factor, pairOf } = this;
      for (let i2 = 0; i2 < mx.length; i2++) {
        const f = factor[pairOf[i2]];
        mx[i2] = state.mx[i2] * f;
        my[i2] = state.my[i2] * f;
      }
      return { mx, my, mz: state.mz };
    }
  };
  function sampleAdc(segment, spins, state, signal, sampleOffset, grouper, members, area, useLattice, weighting = null) {
    const n = segment.numSamples;
    const coils = members ? members.coils : spins.coils;
    const times = adcSampleTimes(segment);
    const k = new Float64Array(3 * n);
    piecesKAt(segment.gradient, times, k);
    const sumRe = new Float64Array(n * coils);
    const sumIm = new Float64Array(n * coils);
    const branches = [{ sign: 1, from: 0, to: n }];
    const active = weighting?.pathway.excited ? weighting : null;
    if (active && spins.r2prime) {
      const tau = active.pathway.tau;
      if (tau + times[0] - segment.t0 < 0) {
        let cross = 0;
        while (cross < n && tau + times[cross] - segment.t0 < 0) cross++;
        branches.splice(0, 1, { sign: -1, from: 0, to: cross });
        if (cross < n) branches.push({ sign: 1, from: cross, to: n });
      }
    }
    const tmpRe = branches.length > 1 ? new Float64Array(n * coils) : sumRe;
    const tmpIm = branches.length > 1 ? new Float64Array(n * coils) : sumIm;
    for (const branch of branches) {
      const groups = (active ? active.grouper(branch.sign) : grouper).groups(segment.activeAxes);
      const source = active ? active.scaled(state, branch.sign) : state;
      const gRe = new Float64Array(groups.count * coils);
      const gIm = new Float64Array(groups.count * coils);
      const any = members ? sumMembers(members, spins, groups, source, area, gRe, gIm) : sumSpins(spins, groups, source, gRe, gIm);
      if (!any) continue;
      if (tmpRe !== sumRe) {
        tmpRe.fill(0);
        tmpIm.fill(0);
      }
      synthesizeReadout(segment, groups, gRe, gIm, coils, k, times, tmpRe, tmpIm, useLattice);
      if (tmpRe !== sumRe) {
        for (let o = branch.from * coils; o < branch.to * coils; o++) {
          sumRe[o] += tmpRe[o];
          sumIm[o] += tmpIm[o];
        }
      }
    }
    emitReadout(segment, sumRe, sumIm, coils, signal, sampleOffset);
  }
  function synthesizeReadout(segment, groups, gRe, gIm, coils, k, times, sumRe, sumIm, useLattice) {
    const n = segment.numSamples;
    {
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
      const lattice = uniform && useLattice && synthesizeOnLattice(segment, groups, gRe, gIm, coils, k, times, sumRe, sumIm);
      if (!lattice && !uniform && synthesizeFactorised(segment, groups, gRe, gIm, coils, k, times, sumRe, sumIm)) return;
      for (let g = 0; g < groups.count && !lattice; g++) {
        let nonzero = false;
        for (let c = 0; c < coils; c++) if (gRe[g * coils + c] !== 0 || gIm[g * coils + c] !== 0) nonzero = true;
        if (!nonzero) continue;
        const x2 = groups.x[g], y = groups.y[g], z = groups.z[g], df = groups.df[g], r2 = groups.r2[g];
        const exact = (s) => {
          const tau = times[s] - segment.t0;
          const cycles = k[3 * s] * x2 + k[3 * s + 1] * y + k[3 * s + 2] * z + df * tau;
          const angle = twoPi * (cycles - Math.round(cycles));
          const decay = Math.exp(-tau * r2);
          return [Math.cos(angle) * decay, Math.sin(angle) * decay];
        };
        let stepRe = 0, stepIm = 0;
        if (uniform) {
          const cycles = (k[3] - k[0]) * x2 + (k[4] - k[1]) * y + (k[5] - k[2]) * z + df * dwell;
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
  }
  function synthesizeFactorised(segment, groups, gRe, gIm, coils, k, times, sumRe, sumIm) {
    const active = [];
    for (let g = 0; g < groups.count; g++) {
      for (let c = 0; c < coils; c++) if (gRe[g * coils + c] !== 0 || gIm[g * coils + c] !== 0) {
        active.push(g);
        break;
      }
    }
    if (active.length < 4) return false;
    const table = (value) => {
      const index = /* @__PURE__ */ new Map();
      const of = new Int32Array(active.length);
      for (let i2 = 0; i2 < active.length; i2++) {
        const v = value(active[i2]);
        let j = index.get(v);
        if (j === void 0) {
          j = index.size;
          index.set(v, j);
        }
        of[i2] = j;
      }
      return { values: [...index.keys()], of };
    };
    const tx = table((g) => groups.x[g]), ty = table((g) => groups.y[g]), tz = table((g) => groups.z[g]);
    const pairs = table((g) => `${groups.df[g]}|${groups.r2[g]}`);
    const dfOf = new Float64Array(pairs.values.length), r2Of = new Float64Array(pairs.values.length);
    for (let i2 = 0; i2 < active.length; i2++) {
      dfOf[pairs.of[i2]] = groups.df[active[i2]];
      r2Of[pairs.of[i2]] = groups.r2[active[i2]];
    }
    const twoPi = 2 * Math.PI;
    const cis = (cycles) => {
      const a = twoPi * (cycles - Math.round(cycles));
      return [Math.cos(a), Math.sin(a)];
    };
    const axisPhasors = (values) => {
      const re = new Float64Array(values.length), im = new Float64Array(values.length);
      const sorted = Float64Array.from(values).sort();
      let pitch = Infinity;
      for (let j = 1; j < sorted.length; j++) {
        const gap = sorted[j] - sorted[j - 1];
        if (gap > 1e-12 * Math.max(1, Math.abs(sorted[j])) && gap < pitch) pitch = gap;
      }
      const origin = sorted[0];
      let slots = null, span = 0;
      if (values.length > 2 && Number.isFinite(pitch)) {
        span = Math.round((sorted[sorted.length - 1] - origin) / pitch) + 1;
        slots = new Int32Array(values.length);
        for (let j = 0; j < values.length && slots; j++) {
          const offset = (values[j] - origin) / pitch;
          slots[j] = Math.round(offset);
          if (Math.abs(offset - slots[j]) > 1e-6) slots = null;
        }
        if (span > 4 * values.length) slots = null;
      }
      const slotRe = slots ? new Float64Array(span) : null, slotIm = slots ? new Float64Array(span) : null;
      return {
        re,
        im,
        at(scale2) {
          if (slots && slotRe && slotIm) {
            const [br, bi] = cis(scale2 * origin), [sr, si] = cis(scale2 * pitch);
            let pr = br, pi = bi;
            for (let j = 0; j < span; j++) {
              slotRe[j] = pr;
              slotIm[j] = pi;
              const nr = pr * sr - pi * si;
              pi = pr * si + pi * sr;
              pr = nr;
            }
            for (let j = 0; j < values.length; j++) {
              re[j] = slotRe[slots[j]];
              im[j] = slotIm[slots[j]];
            }
          } else {
            for (let j = 0; j < values.length; j++) [re[j], im[j]] = cis(scale2 * values[j]);
          }
        }
      };
    };
    const px = axisPhasors(tx.values), py = axisPhasors(ty.values), pz = axisPhasors(tz.values);
    const xr = px.re, xi = px.im, yr = py.re, yi = py.im, zr = pz.re, zi = pz.im;
    const dr = new Float64Array(dfOf.length), di = new Float64Array(dfOf.length);
    const stepR = new Float64Array(dfOf.length), stepI = new Float64Array(dfOf.length);
    const dwell = segment.dwell;
    for (let m = 0; m < dfOf.length; m++) {
      const [cr, ci] = cis(dfOf[m] * dwell), d = Math.exp(-dwell * r2Of[m]);
      stepR[m] = cr * d;
      stepI[m] = ci * d;
    }
    const n = segment.numSamples;
    for (let s = 0; s < n; s++) {
      const tau = times[s] - segment.t0;
      px.at(k[3 * s]);
      py.at(k[3 * s + 1]);
      pz.at(k[3 * s + 2]);
      for (let m = 0; m < dfOf.length; m++) {
        if (s % RECURRENCE_ANCHOR === 0) {
          const [cr, ci] = cis(dfOf[m] * tau), d = Math.exp(-tau * r2Of[m]);
          dr[m] = cr * d;
          di[m] = ci * d;
        } else {
          const nr = dr[m] * stepR[m] - di[m] * stepI[m];
          di[m] = dr[m] * stepI[m] + di[m] * stepR[m];
          dr[m] = nr;
        }
      }
      for (let i2 = 0; i2 < active.length; i2++) {
        const g = active[i2];
        const a = tx.of[i2], b = ty.of[i2], c = tz.of[i2], m = pairs.of[i2];
        let pr = xr[a] * yr[b] - xi[a] * yi[b], pi = xr[a] * yi[b] + xi[a] * yr[b];
        let nr = pr * zr[c] - pi * zi[c];
        pi = pr * zi[c] + pi * zr[c];
        pr = nr;
        nr = pr * dr[m] - pi * di[m];
        pi = pr * di[m] + pi * dr[m];
        pr = nr;
        for (let cc = 0; cc < coils; cc++) {
          const ar = gRe[g * coils + cc], ai = gIm[g * coils + cc];
          sumRe[s * coils + cc] += ar * pr - ai * pi;
          sumIm[s * coils + cc] += ar * pi + ai * pr;
        }
      }
    }
    return true;
  }
  function emitReadout(segment, sumRe, sumIm, coils, signal, sampleOffset) {
    const n = segment.numSamples;
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

  // src/sim/engine/phaseGraph.ts
  var K_QUANTUM = 1e-3;
  var TAU_QUANTUM = 1e-9;
  var TWO_PI = 2 * Math.PI;
  var FOUR_PI22 = 4 * Math.PI * Math.PI;
  var States = class {
    constructor(lanes, capacity = 64) {
      __publicField(this, "lanes", lanes);
      __publicField(this, "count", 0);
      __publicField(this, "k");
      __publicField(this, "tau");
      __publicField(this, "amp");
      this.k = new Float64Array(3 * capacity);
      this.tau = new Float64Array(capacity);
      this.amp = new Float64Array(2 * lanes * capacity);
    }
    /** A new state at (k, τ) with zero amplitudes; returns its index. */
    add(kx, ky, kz, tau) {
      if (this.count === this.tau.length) this.grow(2 * this.count);
      const i2 = this.count++;
      this.k[3 * i2] = kx;
      this.k[3 * i2 + 1] = ky;
      this.k[3 * i2 + 2] = kz;
      this.tau[i2] = tau;
      this.amp.fill(0, 2 * this.lanes * i2, 2 * this.lanes * (i2 + 1));
      return i2;
    }
    grow(capacity) {
      const k = new Float64Array(3 * capacity);
      k.set(this.k);
      const tau = new Float64Array(capacity);
      tau.set(this.tau);
      const amp = new Float64Array(2 * this.lanes * capacity);
      amp.set(this.amp);
      this.k = k;
      this.tau = tau;
      this.amp = amp;
    }
    /** Largest |amplitude component| of state i over the lanes. */
    peak(i2) {
      let m = 0;
      const base = 2 * this.lanes * i2, end = base + 2 * this.lanes;
      for (let o = base; o < end; o++) {
        const v = Math.abs(this.amp[o]);
        if (v > m) m = v;
      }
      return m;
    }
    /** Keep the states `keep` lists, in that order. */
    compact(keep) {
      const n = keep.length, L2 = 2 * this.lanes;
      const k = new Float64Array(3 * Math.max(64, n)), tau = new Float64Array(Math.max(64, n)), amp = new Float64Array(L2 * Math.max(64, n));
      for (let j = 0; j < n; j++) {
        const i2 = keep[j];
        k[3 * j] = this.k[3 * i2];
        k[3 * j + 1] = this.k[3 * i2 + 1];
        k[3 * j + 2] = this.k[3 * i2 + 2];
        tau[j] = this.tau[i2];
        amp.set(this.amp.subarray(L2 * i2, L2 * (i2 + 1)), L2 * j);
      }
      this.k = k;
      this.tau = tau;
      this.amp = amp;
      this.count = n;
    }
  };
  var KeyTable = class {
    constructor(expected) {
      __publicField(this, "keys");
      __publicField(this, "values");
      __publicField(this, "mask");
      __publicField(this, "size", 0);
      let capacity = 16;
      while (capacity < 2 * expected + 2) capacity <<= 1;
      this.keys = new Float64Array(4 * capacity);
      this.values = new Int32Array(capacity).fill(-1);
      this.mask = capacity - 1;
    }
    slot(a, b, c, d) {
      let h = Math.imul(a | 0, 2654435761) ^ Math.imul(b | 0, 2246822519) ^ Math.imul(c | 0, 3266489917) ^ Math.imul(d | 0, 668265263) ^ Math.imul(d / 4294967296 | 0, 374761393);
      h ^= h >>> 15;
      h = Math.imul(h, 739982445);
      h ^= h >>> 12;
      let s = h & this.mask;
      while (this.values[s] !== -1) {
        const o = 4 * s;
        if (this.keys[o] === a && this.keys[o + 1] === b && this.keys[o + 2] === c && this.keys[o + 3] === d) return s;
        s = s + 1 & this.mask;
      }
      return s;
    }
    get(a, b, c, d) {
      return this.values[this.slot(a, b, c, d)];
    }
    /** The index stored for the key, or `value` stored and returned when absent. */
    claim(a, b, c, d, value) {
      const s = this.slot(a, b, c, d);
      if (this.values[s] !== -1) return this.values[s];
      const o = 4 * s;
      this.keys[o] = a;
      this.keys[o + 1] = b;
      this.keys[o + 2] = c;
      this.keys[o + 3] = d;
      this.values[s] = value;
      this.size++;
      return value;
    }
  };
  var qk = (v) => (v < 0 ? -Math.round(-v / K_QUANTUM) : Math.round(v / K_QUANTUM)) + 0;
  var qt = (v) => (v < 0 ? -Math.round(-v / TAU_QUANTUM) : Math.round(v / TAU_QUANTUM)) + 0;
  var COEFFICIENTS = 12;
  function simulatePhaseGraph(program, model, options = {}) {
    const { classes, slices, sources } = model;
    const C = classes.length, K = slices.z.length, L = C * K;
    if (!(C >= 1 && K >= 1)) throw new Error("The phase-graph model has no tissue class or no sub-slice.");
    const prune = options.prune ?? 1e-5;
    const maxStates = Math.max(1, Math.floor(options.maxStates ?? 2e3));
    const coils = sources.coils;
    const r1 = classes.map((c) => Number.isFinite(c.t1) && c.t1 > 0 ? 1 / c.t1 : 0);
    const r2 = classes.map((c) => Number.isFinite(c.t2) && c.t2 > 0 ? 1 / c.t2 : 0);
    const diffusion = classes.map((c) => c.adc !== void 0 && Number.isFinite(c.adc) && c.adc > 0 ? c.adc : 0);
    const anyDiffusion = diffusion.some((d) => d > 0);
    const attenuation = new Float64Array(C);
    let F = new States(L), Z = new States(L);
    const z0 = Z.add(0, 0, 0, 0);
    for (let lane2 = 0; lane2 < L; lane2++) Z.amp[2 * (L * z0 + lane2)] = 1;
    const sampleCount = countAdcSamples(program.sequence);
    const signal = new Float64Array(2 * sampleCount * coils);
    const operators = /* @__PURE__ */ new Map();
    const relaxation = /* @__PURE__ */ new Map();
    const stats = { maxStates: 1, meanStates: 0, emitted: 0 };
    let readouts = 0, sampleOffset = 0, processed = 0;
    const emitters = {
      count: sources.count,
      x: sources.x,
      y: sources.y,
      z: new Float64Array(sources.count),
      df: sources.df,
      r1: new Float64Array(sources.count),
      r2: Float64Array.from(sources.classOf, (c) => r2[c]),
      weight: new Float64Array(sources.count),
      b1Re: new Float64Array(sources.count),
      b1Im: new Float64Array(sources.count),
      coils: 1,
      rxRe: new Float64Array(sources.count),
      rxIm: new Float64Array(sources.count)
    };
    const grouper = new ReadoutGrouper(emitters);
    const r2p = classes.map((c) => c.t2prime !== void 0 && Number.isFinite(c.t2prime) && c.t2prime > 0 ? 1 / c.t2prime : 0);
    const anyT2p = r2p.some((v) => v > 0);
    const withRate = (sign) => new ReadoutGrouper({
      ...emitters,
      r2: Float64Array.from(sources.classOf, (c) => r2[c] + sign * r2p[c])
    });
    const after = anyT2p ? withRate(1) : grouper, before = anyT2p ? withRate(-1) : grouper;
    const pairIndex = /* @__PURE__ */ new Map();
    const pairOf = new Int32Array(sources.count);
    const pairClass = [], pairFrom = [], pairTo = [];
    for (let i2 = 0; i2 < sources.count; i2++) {
      const key = `${sources.classOf[i2]}|${sources.sliceFrom[i2]}|${sources.sliceTo[i2]}`;
      let p = pairIndex.get(key);
      if (p === void 0) {
        p = pairClass.length;
        pairIndex.set(key, p);
        pairClass.push(sources.classOf[i2]);
        pairFrom.push(sources.sliceFrom[i2]);
        pairTo.push(sources.sliceTo[i2]);
      }
      pairOf[i2] = p;
    }
    const pairSums = new Float64Array(2 * pairClass.length);
    const anyB0 = sources.df.some((v) => v !== 0);
    const distinct = (values) => {
      const index = /* @__PURE__ */ new Map();
      const of = new Int32Array(values.length);
      for (let i2 = 0; i2 < values.length; i2++) {
        let j = index.get(values[i2]);
        if (j === void 0) {
          j = index.size;
          index.set(values[i2], j);
        }
        of[i2] = j;
      }
      return { values: Float64Array.from(index.keys()), of };
    };
    const xs = distinct(sources.x), ys = distinct(sources.y);
    const xRe = new Float64Array(xs.values.length), xIm = new Float64Array(xs.values.length);
    const yRe = new Float64Array(ys.values.length), yIm = new Float64Array(ys.values.length);
    const phaseTables = (kx, ky) => {
      for (let j = 0; j < xs.values.length; j++) {
        const c = kx * xs.values[j], a = TWO_PI * (c - Math.round(c));
        xRe[j] = Math.cos(a);
        xIm[j] = Math.sin(a);
      }
      for (let j = 0; j < ys.values.length; j++) {
        const c = ky * ys.values[j], a = TWO_PI * (c - Math.round(c));
        yRe[j] = Math.cos(a);
        yIm[j] = Math.sin(a);
      }
    };
    const slabCache = /* @__PURE__ */ new Map();
    const runStarts = new Uint8Array(K + 1);
    for (let i2 = 0; i2 < sources.count; i2++) {
      runStarts[sources.sliceFrom[i2]] = 1;
      runStarts[sources.sliceTo[i2]] = 1;
    }
    const pendingDk = new Float64Array(3), pendingM1 = new Float64Array(3);
    let pendingDt = 0, pendingM2 = 0, pending = false;
    const addPending = (moments, dt) => {
      if (anyDiffusion) {
        for (let a = 0; a < 3; a++) {
          pendingM2 += pendingDk[a] * pendingDk[a] * dt + 2 * pendingDk[a] * moments.kIntegral[a] + moments.kSecond[a];
          pendingM1[a] += pendingDk[a] * dt + moments.kIntegral[a];
        }
      }
      for (let a = 0; a < 3; a++) pendingDk[a] += moments.dk[a];
      pendingDt += dt;
      pending = true;
    };
    const flush = () => {
      if (!pending) return;
      free(pendingDk, pendingDt, pendingM1, pendingM2);
      pendingDk.fill(0);
      pendingM1.fill(0);
      pendingDt = 0;
      pendingM2 = 0;
      pending = false;
    };
    const halves = /* @__PURE__ */ new Map();
    const until = options.until ?? Infinity;
    const interval = Math.max(1, options.progressInterval ?? 64);
    for (const segment of program.segments()) {
      if (segment.t0 >= until) break;
      if (segment.kind === "free") {
        addPending(segment.moments, segment.t1 - segment.t0);
      } else if (segment.kind === "rf") {
        flush();
        pulse(segment, operators.get(segment.key) ?? buildOperator(segment));
        stats.maxStates = Math.max(stats.maxStates, F.count);
      } else {
        flush();
        readout(segment);
        stats.meanStates += F.count;
        readouts++;
        sampleOffset += segment.numSamples;
        addPending(segment.moments, segment.t1 - segment.t0);
      }
      if (++processed % interval === 0) {
        if (options.isCancelled?.()) throw new SimulationCancelledError();
        options.onProgress?.(program.totalDuration > 0 ? segment.t1 / program.totalDuration : 1);
      }
    }
    options.onProgress?.(1);
    if (readouts) stats.meanStates /= readouts;
    return { signal, sampleCount, coils, stats };
    function factors(dt) {
      let entry = relaxation.get(dt);
      if (entry) return entry;
      entry = { e1: Float64Array.from(r1, (r) => Math.exp(-dt * r)), e2: Float64Array.from(r2, (r) => Math.exp(-dt * r)) };
      if (relaxation.size >= 32) relaxation.clear();
      relaxation.set(dt, entry);
      return entry;
    }
    function free(dk, dt, m1, m2) {
      const { e1, e2 } = factors(dt);
      for (let i2 = 0; i2 < F.count; i2++) {
        if (anyDiffusion) {
          const kx = F.k[3 * i2], ky = F.k[3 * i2 + 1], kz = F.k[3 * i2 + 2];
          diffuse(FOUR_PI22 * ((kx * kx + ky * ky + kz * kz) * dt + 2 * (kx * m1[0] + ky * m1[1] + kz * m1[2]) + m2));
        }
        F.k[3 * i2] += dk[0];
        F.k[3 * i2 + 1] += dk[1];
        F.k[3 * i2 + 2] += dk[2];
        F.tau[i2] += dt;
        let o2 = 2 * L * i2;
        for (let c = 0; c < C; c++) {
          const d = anyDiffusion ? e2[c] * attenuation[c] : e2[c];
          for (let j = 0; j < K; j++, o2 += 2) {
            F.amp[o2] *= d;
            F.amp[o2 + 1] *= d;
          }
        }
      }
      let zero = -1;
      for (let i2 = 0; i2 < Z.count; i2++) {
        const kx = Z.k[3 * i2], ky = Z.k[3 * i2 + 1], kz = Z.k[3 * i2 + 2];
        if (kx === 0 && ky === 0 && kz === 0 && Z.tau[i2] === 0) zero = i2;
        if (anyDiffusion) diffuse(FOUR_PI22 * (kx * kx + ky * ky + kz * kz) * dt);
        let o2 = 2 * L * i2;
        for (let c = 0; c < C; c++) {
          const d = anyDiffusion ? e1[c] * attenuation[c] : e1[c];
          for (let j = 0; j < K; j++, o2 += 2) {
            Z.amp[o2] *= d;
            Z.amp[o2 + 1] *= d;
          }
        }
      }
      if (zero < 0) zero = Z.add(0, 0, 0, 0);
      let o = 2 * L * zero;
      for (let c = 0; c < C; c++) {
        const add = 1 - e1[c];
        for (let j = 0; j < K; j++, o += 2) Z.amp[o] += add;
      }
    }
    function diffuse(b) {
      for (let c = 0; c < C; c++) attenuation[c] = diffusion[c] > 0 && b > 0 ? Math.exp(-b * diffusion[c]) : 1;
    }
    function diffuseHalf(moments, dt) {
      if (!(dt > 0)) return;
      let m2 = 0;
      for (let a = 0; a < 3; a++) m2 += moments.kSecond[a];
      const m1 = moments.kIntegral;
      for (const [states, moving] of [[F, true], [Z, false]]) {
        for (let i2 = 0; i2 < states.count; i2++) {
          const kx = states.k[3 * i2], ky = states.k[3 * i2 + 1], kz = states.k[3 * i2 + 2];
          const b = moving ? FOUR_PI22 * ((kx * kx + ky * ky + kz * kz) * dt + 2 * (kx * m1[0] + ky * m1[1] + kz * m1[2]) + m2) : FOUR_PI22 * (kx * kx + ky * ky + kz * kz) * dt;
          if (!(b > 0)) continue;
          diffuse(b);
          let o = 2 * L * i2;
          for (let c = 0; c < C; c++) {
            const d = attenuation[c];
            for (let j = 0; j < K; j++, o += 2) {
              states.amp[o] *= d;
              states.amp[o + 1] *= d;
            }
          }
        }
      }
    }
    function buildOperator(segment) {
      const cells = rfCells(segment, 0);
      for (let j = 0; j < cells.count; j++) {
        if (cells.grad[3 * j] !== 0 || cells.grad[3 * j + 1] !== 0) {
          throw new Error("The phase-graph engine cannot simulate RF pulses played with x or y gradients (in-plane selective excitation); use the isochromat engine.");
        }
      }
      const pre = segment.kToCenter[2], post = segment.moments.dk[2] - segment.kToCenter[2];
      const tPre = segment.centerTime - segment.t0, tPost = segment.t1 - segment.centerTime;
      const out = new Float64Array(COEFFICIENTS * L);
      const one = {
        count: 1,
        x: Float64Array.of(0),
        y: Float64Array.of(0),
        z: Float64Array.of(0),
        df: Float64Array.of(0),
        r1: Float64Array.of(0),
        r2: Float64Array.of(0),
        weight: Float64Array.of(1),
        b1Re: Float64Array.of(1),
        b1Im: Float64Array.of(0),
        coils: 1,
        rxRe: Float64Array.of(1),
        rxIm: Float64Array.of(0)
      };
      for (let c = 0; c < C; c++) {
        const cls = classes[c];
        one.df[0] = cls.df;
        one.r1[0] = r1[c];
        one.r2[0] = r2[c];
        one.b1Re[0] = cls.b1Re;
        one.b1Im[0] = cls.b1Im;
        for (let j = 0; j < K; j++) {
          const z = slices.z[j];
          one.z[0] = z;
          const c0 = stepRfVector(cells, one, 0, 0, 0, 0);
          const ex = stepRfVector(cells, one, 0, 1, 0, 0);
          const ey = stepRfVector(cells, one, 0, 0, 1, 0);
          const ez = stepRfVector(cells, one, 0, 0, 0, 1);
          const a = [ex[0] - c0[0], ey[0] - c0[0], ez[0] - c0[0], ex[1] - c0[1], ey[1] - c0[1], ez[1] - c0[1], ex[2] - c0[2], ey[2] - c0[2], ez[2] - c0[2]];
          const aPre = TWO_PI * (pre * z + cls.df * tPre), aPost = TWO_PI * (post * z + cls.df * tPost);
          const cp = Math.cos(-aPre), sp = Math.sin(-aPre), cq = Math.cos(-aPost), sq = Math.sin(-aPost);
          const m = a.slice();
          for (let row = 0; row < 3; row++) {
            const u = a[3 * row], v = a[3 * row + 1];
            m[3 * row] = u * cp + v * sp;
            m[3 * row + 1] = -u * sp + v * cp;
          }
          const r = m.slice();
          for (let col = 0; col < 3; col++) {
            const u = m[col], v = m[3 + col];
            r[col] = u * cq - v * sq;
            r[3 + col] = u * sq + v * cq;
          }
          const ctx = c0[0] * cq - c0[1] * sq, cty = c0[0] * sq + c0[1] * cq;
          const o = COEFFICIENTS * (c * K + j);
          const R00 = r[0], R01 = r[1], R02 = r[2], R10 = r[3], R11 = r[4], R12 = r[5], R20 = r[6], R21 = r[7], R22 = r[8];
          out[o] = 0.5 * (R00 + R11);
          out[o + 1] = 0.5 * (R10 - R01);
          out[o + 2] = 0.5 * (R00 - R11);
          out[o + 3] = 0.5 * (R10 + R01);
          out[o + 4] = R02;
          out[o + 5] = R12;
          out[o + 6] = R20;
          out[o + 7] = -R21;
          out[o + 8] = R22;
          out[o + 9] = ctx;
          out[o + 10] = cty;
          out[o + 11] = c0[2];
        }
      }
      operators.set(segment.key, out);
      return out;
    }
    function pulse(segment, coefficients) {
      const pre = segment.kToCenter, total = segment.moments.dk;
      const tPre = segment.centerTime - segment.t0, tPost = segment.t1 - segment.centerTime;
      let half;
      if (anyDiffusion) {
        half = halves.get(segment.key);
        if (!half) {
          half = {
            pre: windowMoments(segment.gradient, segment.t0, segment.centerTime),
            post: windowMoments(segment.gradient, segment.centerTime, segment.t1)
          };
          halves.set(segment.key, half);
        }
        diffuseHalf(half.pre, tPre);
      }
      for (let i2 = 0; i2 < F.count; i2++) {
        F.k[3 * i2] += pre[0];
        F.k[3 * i2 + 1] += pre[1];
        F.k[3 * i2 + 2] += pre[2];
        F.tau[i2] += tPre;
      }
      const phi = segment.phaseOffset;
      const p1r = Math.cos(phi), p1i = Math.sin(phi), p2r = Math.cos(2 * phi), p2i = Math.sin(2 * phi);
      const fTable = new KeyTable(F.count), zTable = new KeyTable(Z.count);
      const fq = new Float64Array(4 * F.count), zq = new Float64Array(4 * Z.count);
      for (let i2 = 0; i2 < F.count; i2++) {
        const a = qk(F.k[3 * i2]), b = qk(F.k[3 * i2 + 1]), c = qk(F.k[3 * i2 + 2]), d = qt(F.tau[i2]);
        fq[4 * i2] = a;
        fq[4 * i2 + 1] = b;
        fq[4 * i2 + 2] = c;
        fq[4 * i2 + 3] = d;
        const owner = fTable.claim(a, b, c, d, i2);
        if (owner !== i2) addInto(F, owner, i2);
      }
      for (let i2 = 0; i2 < Z.count; i2++) {
        const a = qk(Z.k[3 * i2]), b = qk(Z.k[3 * i2 + 1]), c = qk(Z.k[3 * i2 + 2]), d = qt(Z.tau[i2]);
        zq[4 * i2] = a;
        zq[4 * i2 + 1] = b;
        zq[4 * i2 + 2] = c;
        zq[4 * i2 + 3] = d;
        const owner = zTable.claim(a, b, c, d, i2);
        if (owner !== i2) addInto(Z, owner, i2);
      }
      const keys = new KeyTable(2 * F.count + Z.count);
      const list = [];
      const exact = [];
      const visit = (a, b, c, d, kx, ky, kz, tau) => {
        const n = list.length / 4;
        if (keys.claim(a, b, c, d, n) === n) {
          list.push(a, b, c, d);
          exact.push(kx, ky, kz, tau);
        }
      };
      for (let i2 = 0; i2 < F.count; i2++) {
        if (fTable.get(fq[4 * i2], fq[4 * i2 + 1], fq[4 * i2 + 2], fq[4 * i2 + 3]) !== i2) continue;
        visit(fq[4 * i2], fq[4 * i2 + 1], fq[4 * i2 + 2], fq[4 * i2 + 3], F.k[3 * i2], F.k[3 * i2 + 1], F.k[3 * i2 + 2], F.tau[i2]);
        visit(-fq[4 * i2] + 0, -fq[4 * i2 + 1] + 0, -fq[4 * i2 + 2] + 0, -fq[4 * i2 + 3] + 0, -F.k[3 * i2], -F.k[3 * i2 + 1], -F.k[3 * i2 + 2], -F.tau[i2]);
      }
      for (let i2 = 0; i2 < Z.count; i2++) {
        if (zTable.get(zq[4 * i2], zq[4 * i2 + 1], zq[4 * i2 + 2], zq[4 * i2 + 3]) !== i2) continue;
        visit(zq[4 * i2], zq[4 * i2 + 1], zq[4 * i2 + 2], zq[4 * i2 + 3], Z.k[3 * i2], Z.k[3 * i2 + 1], Z.k[3 * i2 + 2], Z.tau[i2]);
      }
      const rot = new Float64Array(COEFFICIENTS * L);
      for (let lane2 = 0; lane2 < L; lane2++) {
        const o = COEFFICIENTS * lane2;
        const Br = coefficients[o + 2], Bi = coefficients[o + 3], Cr = coefficients[o + 4], Ci = coefficients[o + 5];
        const Dr = coefficients[o + 6], Di = coefficients[o + 7], cr = coefficients[o + 9], ci = coefficients[o + 10];
        rot[o] = coefficients[o];
        rot[o + 1] = coefficients[o + 1];
        rot[o + 2] = Br * p2r - Bi * p2i;
        rot[o + 3] = Br * p2i + Bi * p2r;
        rot[o + 4] = Cr * p1r - Ci * p1i;
        rot[o + 5] = Cr * p1i + Ci * p1r;
        rot[o + 6] = Dr * p1r + Di * p1i;
        rot[o + 7] = Di * p1r - Dr * p1i;
        rot[o + 8] = coefficients[o + 8];
        rot[o + 9] = cr * p1r - ci * p1i;
        rot[o + 10] = cr * p1i + ci * p1r;
        rot[o + 11] = coefficients[o + 11];
      }
      const count = list.length / 4;
      const nextF = new States(L, Math.max(64, count)), nextZ = new States(L, Math.max(64, count));
      const fPeaks = [], zPeaks = [];
      for (let u = 0; u < count; u++) {
        const a = list[4 * u], b = list[4 * u + 1], c = list[4 * u + 2], d = list[4 * u + 3];
        const fi = fTable.get(a, b, c, d), mi = fTable.get(-a + 0, -b + 0, -c + 0, -d + 0), zi = zTable.get(a, b, c, d);
        const isZero = a === 0 && b === 0 && c === 0 && d === 0;
        const nf = nextF.add(exact[4 * u], exact[4 * u + 1], exact[4 * u + 2], exact[4 * u + 3]);
        const nz = nextZ.add(exact[4 * u], exact[4 * u + 1], exact[4 * u + 2], exact[4 * u + 3]);
        const fo = fi >= 0 ? 2 * L * fi : -1, mo = mi >= 0 ? 2 * L * mi : -1, zo = zi >= 0 ? 2 * L * zi : -1;
        const no = 2 * L * nf, wo = 2 * L * nz;
        let fPeak = 0, zPeak = 0;
        for (let lane2 = 0; lane2 < L; lane2++) {
          const o = COEFFICIENTS * lane2;
          const fr = fo >= 0 ? F.amp[fo + 2 * lane2] : 0, fim = fo >= 0 ? F.amp[fo + 2 * lane2 + 1] : 0;
          const mr = mo >= 0 ? F.amp[mo + 2 * lane2] : 0, mim = mo >= 0 ? -F.amp[mo + 2 * lane2 + 1] : 0;
          const zr = zo >= 0 ? Z.amp[zo + 2 * lane2] : 0, zim = zo >= 0 ? Z.amp[zo + 2 * lane2 + 1] : 0;
          const Ar = rot[o], Ai = rot[o + 1], Br = rot[o + 2], Bi = rot[o + 3], Cr = rot[o + 4], Ci = rot[o + 5];
          const Dr = rot[o + 6], Di = rot[o + 7], E = rot[o + 8];
          let nr = Ar * fr - Ai * fim + Br * mr - Bi * mim + Cr * zr - Ci * zim;
          let ni = Ar * fim + Ai * fr + Br * mim + Bi * mr + Cr * zim + Ci * zr;
          let wr = 0.5 * (Dr * fr - Di * fim + Dr * mr + Di * mim) + E * zr;
          const wi = 0.5 * (Dr * fim + Di * fr + Dr * mim - Di * mr) + E * zim;
          if (isZero) {
            nr += rot[o + 9];
            ni += rot[o + 10];
            wr += rot[o + 11];
          }
          nextF.amp[no + 2 * lane2] = nr;
          nextF.amp[no + 2 * lane2 + 1] = ni;
          nextZ.amp[wo + 2 * lane2] = wr;
          nextZ.amp[wo + 2 * lane2 + 1] = wi;
          const pf = Math.max(Math.abs(nr), Math.abs(ni)), pz = Math.max(Math.abs(wr), Math.abs(wi));
          if (pf > fPeak) fPeak = pf;
          if (pz > zPeak) zPeak = pz;
        }
        fPeaks.push(isZero ? Infinity : fPeak);
        zPeaks.push(isZero ? Infinity : zPeak);
      }
      F = keepStrongest(nextF, fPeaks, false);
      Z = keepStrongest(nextZ, zPeaks, true);
      if (half) diffuseHalf(half.post, tPost);
      for (let i2 = 0; i2 < F.count; i2++) {
        F.k[3 * i2] += total[0] - pre[0];
        F.k[3 * i2 + 1] += total[1] - pre[1];
        F.k[3 * i2 + 2] += total[2] - pre[2];
        F.tau[i2] += tPost;
      }
    }
    function addInto(states, owner, other) {
      const a = 2 * L * owner, b = 2 * L * other;
      for (let o = 0; o < 2 * L; o++) {
        states.amp[a + o] += states.amp[b + o];
        states.amp[b + o] = 0;
      }
    }
    function keepStrongest(states, peaks, keepZero) {
      let level = prune;
      let candidates = 0;
      for (let i2 = 0; i2 < states.count; i2++) if (peaks[i2] >= prune || keepZero && peaks[i2] === Infinity) candidates++;
      if (candidates > maxStates) {
        const sorted = Float64Array.from(peaks).sort();
        level = Math.max(prune, sorted[sorted.length - maxStates]);
      }
      const keep = [];
      for (let i2 = 0; i2 < states.count && keep.length < maxStates; i2++) {
        if (peaks[i2] >= level || keepZero && peaks[i2] === Infinity) keep.push(i2);
      }
      if (keep.length !== states.count) states.compact(keep);
      return states;
    }
    function readout(segment) {
      const n = segment.numSamples;
      const times = adcSampleTimes(segment);
      const k = new Float64Array(3 * n);
      piecesKAt(segment.gradient, times, k);
      const groups = grouper.groups(segment.activeAxes);
      const sumRe = new Float64Array(n * coils), sumIm = new Float64Array(n * coils);
      if ((segment.activeAxes & 4) !== 0) {
        readoutAlongZ(segment, k, times, groups, sumRe, sumIm);
        emitReadout(segment, sumRe, sumIm, coils, signal, sampleOffset);
        return;
      }
      const kMin = [Infinity, Infinity], kMax = [-Infinity, -Infinity];
      for (let i2 = 0; i2 < n; i2++) {
        for (let a = 0; a < 2; a++) {
          kMin[a] = Math.min(kMin[a], k[3 * i2 + a]);
          kMax[a] = Math.max(kMax[a], k[3 * i2 + a]);
        }
      }
      const shapeBound = (kx, ky) => boxBound(kx + kMin[0], kx + kMax[0], model.voxel[0]) * boxBound(ky + kMin[1], ky + kMax[1], model.voxel[1]);
      const table = new KeyTable(F.count);
      const groupK = [], groupSide = [];
      let G = new Float64Array(2 * L * Math.max(8, Math.min(F.count, 64)));
      let count = 0;
      const tauFirst = times[0] - segment.t0, tauLast = times[n - 1] - segment.t0;
      const sideOf = (tau) => !anyT2p ? 0 : tau + tauFirst >= 0 ? 1 : tau + tauLast <= 0 ? 2 : 3;
      const sideFactor = new Float64Array(C);
      const floor = 0.01 * prune;
      for (let s = 0; s < F.count; s++) {
        if (shapeBound(F.k[3 * s], F.k[3 * s + 1]) * F.peak(s) < floor) continue;
        const side = sideOf(F.tau[s]);
        const a = qk(F.k[3 * s]), b = qk(F.k[3 * s + 1]), d = anyB0 || side === 3 ? qt(F.tau[s]) : 0;
        const g = table.claim(a, b, side, d, count);
        if (g === count) {
          count++;
          groupK.push(F.k[3 * s], F.k[3 * s + 1], F.tau[s]);
          groupSide.push(side);
          if (2 * L * count > G.length) {
            const grown = new Float64Array(2 * G.length);
            grown.set(G);
            G = grown;
          }
        }
        for (let c = 0; c < C; c++) {
          sideFactor[c] = (side === 1 || side === 2) && r2p[c] > 0 ? Math.exp((side === 1 ? -1 : 1) * r2p[c] * F.tau[s]) : 1;
        }
        const weights = slabWeights(F.k[3 * s + 2]);
        const o = 2 * L * s, go = 2 * L * g;
        for (let c = 0; c < C; c++) {
          const f = sideFactor[c];
          for (let j = 0; j < K; j++) {
            const lane2 = 2 * (c * K + j);
            const fr = F.amp[o + lane2] * f, fi = F.amp[o + lane2 + 1] * f;
            const wr = weights[2 * j], wi = weights[2 * j + 1];
            G[go + lane2] += fr * wr - fi * wi;
            G[go + lane2 + 1] += fr * wi + fi * wr;
          }
        }
      }
      const tmpRe = new Float64Array(n * coils), tmpIm = new Float64Array(n * coils);
      const shape = new Float64Array(n);
      const classFactor = new Float64Array(C).fill(1);
      const buffers = /* @__PURE__ */ new Map();
      const bufferFor = (which) => {
        let entry = buffers.get(which);
        if (!entry) {
          const gs = which.groups(segment.activeAxes);
          entry = { groups: gs, gRe: new Float64Array(gs.count * coils), gIm: new Float64Array(gs.count * coils) };
          buffers.set(which, entry);
        }
        return entry;
      };
      for (let g = 0; g < count; g++) {
        const go = 2 * L * g;
        let peak = 0;
        for (let o = go; o < go + 2 * L; o++) peak = Math.max(peak, Math.abs(G[o]));
        if (!(peak > 0)) continue;
        if (shapeBound(groupK[3 * g], groupK[3 * g + 1]) * peak < prune) continue;
        let shapePeak = 0;
        for (let i2 = 0; i2 < n; i2++) {
          shape[i2] = sinc2((groupK[3 * g] + k[3 * i2]) * model.voxel[0]) * sinc2((groupK[3 * g + 1] + k[3 * i2 + 1]) * model.voxel[1]);
          shapePeak = Math.max(shapePeak, Math.abs(shape[i2]));
        }
        if (shapePeak * peak < prune) continue;
        stats.emitted++;
        for (let p = 0; p < pairClass.length; p++) {
          const base = go + 2 * pairClass[p] * K;
          let ar = 0, ai = 0;
          for (let j = pairFrom[p]; j < pairTo[p]; j++) {
            ar += G[base + 2 * j];
            ai += G[base + 2 * j + 1];
          }
          pairSums[2 * p] = ar;
          pairSums[2 * p + 1] = ai;
        }
        phaseTables(groupK[3 * g], groupK[3 * g + 1]);
        const tau = groupK[3 * g + 2], side = groupSide[g];
        const branches = [];
        if (side !== 3) {
          branches.push(side === 2 ? { grouper: before, sign: -1, from: 0, to: n } : { grouper: after, sign: 1, from: 0, to: n });
        } else {
          let cross = 0;
          while (cross < n && tau + times[cross] - segment.t0 < 0) cross++;
          branches.push({ grouper: before, sign: -1, from: 0, to: cross }, { grouper: after, sign: 1, from: cross, to: n });
        }
        for (const branch of branches) {
          const { groups: groups2, gRe, gIm } = bufferFor(branch.grouper);
          for (let c = 0; c < C; c++) classFactor[c] = side === 3 && r2p[c] > 0 ? Math.exp(-branch.sign * r2p[c] * tau) : 1;
          gRe.fill(0);
          gIm.fill(0);
          let any = false;
          for (let i2 = 0; i2 < sources.count; i2++) {
            const c = sources.classOf[i2];
            let ar = pairSums[2 * pairOf[i2]], ai = pairSums[2 * pairOf[i2] + 1];
            if (ar === 0 && ai === 0) continue;
            any = true;
            if (classFactor[c] !== 1) {
              ar *= classFactor[c];
              ai *= classFactor[c];
            }
            const xi = xs.of[i2], yi = ys.of[i2];
            let pr = xRe[xi] * yRe[yi] - xIm[xi] * yIm[yi], pi = xRe[xi] * yIm[yi] + xIm[xi] * yRe[yi];
            if (anyB0 && sources.df[i2] !== 0) {
              const cyc = sources.df[i2] * tau, a = TWO_PI * (cyc - Math.round(cyc));
              const cr = Math.cos(a), ci = Math.sin(a);
              const nr = pr * cr - pi * ci;
              pi = pr * ci + pi * cr;
              pr = nr;
            }
            const pd = sources.pd[i2];
            const vr = (ar * pr - ai * pi) * pd, vi = (ar * pi + ai * pr) * pd;
            const gg = groups2.groupOf[i2];
            for (let cc = 0; cc < coils; cc++) {
              const rr = sources.rxRe[cc * sources.count + i2], ri = -sources.rxIm[cc * sources.count + i2];
              gRe[gg * coils + cc] += rr * vr - ri * vi;
              gIm[gg * coils + cc] += rr * vi + ri * vr;
            }
          }
          if (!any) continue;
          tmpRe.fill(0);
          tmpIm.fill(0);
          synthesizeReadout(segment, groups2, gRe, gIm, coils, k, times, tmpRe, tmpIm, true);
          for (let i2 = branch.from; i2 < branch.to; i2++) {
            const v = shape[i2];
            for (let c = 0; c < coils; c++) {
              sumRe[i2 * coils + c] += v * tmpRe[i2 * coils + c];
              sumIm[i2 * coils + c] += v * tmpIm[i2 * coils + c];
            }
          }
        }
      }
      emitReadout(segment, sumRe, sumIm, coils, signal, sampleOffset);
    }
    function readoutAlongZ(segment, k, times, groups, sumRe, sumIm) {
      const n = segment.numSamples;
      const gRe = new Float64Array(groups.count * coils), gIm = new Float64Array(groups.count * coils);
      for (let s = 0; s < F.count; s++) {
        if (F.peak(s) < prune) continue;
        stats.emitted++;
        const o = 2 * L * s;
        for (let t = 0; t < n; t++) {
          const shape = sinc2((F.k[3 * s] + k[3 * t]) * model.voxel[0]) * sinc2((F.k[3 * s + 1] + k[3 * t + 1]) * model.voxel[1]);
          if (shape === 0) continue;
          const weights = slabWeights(F.k[3 * s + 2] + k[3 * t + 2]);
          const tau = times[t] - segment.t0;
          gRe.fill(0);
          gIm.fill(0);
          for (let i2 = 0; i2 < sources.count; i2++) {
            const c = sources.classOf[i2];
            let ar = 0, ai = 0;
            for (let j = sources.sliceFrom[i2]; j < sources.sliceTo[i2]; j++) {
              const fr = F.amp[o + 2 * (c * K + j)], fi = F.amp[o + 2 * (c * K + j) + 1];
              ar += fr * weights[2 * j] - fi * weights[2 * j + 1];
              ai += fr * weights[2 * j + 1] + fi * weights[2 * j];
            }
            if (ar === 0 && ai === 0) continue;
            const lorentz = r2p[c] > 0 ? Math.exp(-r2p[c] * Math.abs(F.tau[s] + tau)) : 1;
            accumulate(i2, F.k[3 * s], F.k[3 * s + 1], F.tau[s], ar * lorentz, ai * lorentz, groups.groupOf[i2], gRe, gIm);
          }
          for (let g = 0; g < groups.count; g++) {
            const cycles = k[3 * t] * groups.x[g] + k[3 * t + 1] * groups.y[g] + groups.df[g] * tau;
            const angle = TWO_PI * (cycles - Math.round(cycles));
            const decay = Math.exp(-tau * groups.r2[g]) * shape;
            const er = Math.cos(angle) * decay, ei = Math.sin(angle) * decay;
            for (let c = 0; c < coils; c++) {
              const ar = gRe[g * coils + c], ai = gIm[g * coils + c];
              sumRe[t * coils + c] += ar * er - ai * ei;
              sumIm[t * coils + c] += ar * ei + ai * er;
            }
          }
        }
      }
    }
    function accumulate(i2, kx, ky, tau, ar, ai, g, gRe, gIm) {
      const cycles = kx * sources.x[i2] + ky * sources.y[i2] + sources.df[i2] * tau;
      const angle = TWO_PI * (cycles - Math.round(cycles));
      const pd = sources.pd[i2];
      const er = Math.cos(angle) * pd, ei = Math.sin(angle) * pd;
      const vr = ar * er - ai * ei, vi = ar * ei + ai * er;
      for (let c = 0; c < coils; c++) {
        const rr = sources.rxRe[c * sources.count + i2], ri = -sources.rxIm[c * sources.count + i2];
        gRe[g * coils + c] += rr * vr - ri * vi;
        gIm[g * coils + c] += rr * vi + ri * vr;
      }
    }
    function slabWeights(q) {
      const key = qk(q);
      let w = slabCache.get(key);
      if (!w) {
        if (slabCache.size > 65536) slabCache.clear();
        w = slabWeightsAt(key * K_QUANTUM);
        slabCache.set(key, w);
      }
      return w;
    }
    function slabWeightsAt(q) {
      const w = new Float64Array(2 * K);
      const z = slices.z, ref = slices.reference;
      if (K === 1) {
        const a = TWO_PI * q * z[0];
        w[0] = slices.weight[0] * Math.cos(a);
        w[1] = slices.weight[0] * Math.sin(a);
        return w;
      }
      const width = (j) => slices.weight[j] * ref;
      const omega = TWO_PI * q;
      let start = 0;
      while (start < K) {
        let end = start;
        while (end + 1 < K && !runStarts[end + 1] && z[end + 1] - z[end] <= 0.51 * (width(end) + width(end + 1)) + 1e-12) end++;
        cap(w, start, z[start] - width(start) / 2, z[start], omega, ref);
        cap(w, end, z[end], z[end] + width(end) / 2, omega, ref);
        for (let j = start; j < end; j++) {
          const h = z[j + 1] - z[j];
          const [j0r, j0i] = J0(omega, h), [j1r, j1i] = J1(omega, h);
          const er = Math.cos(omega * z[j]), ei = Math.sin(omega * z[j]);
          const fr = j0r - j1r, fi = j0i - j1i;
          w[2 * j] += (er * fr - ei * fi) / ref;
          w[2 * j + 1] += (er * fi + ei * fr) / ref;
          w[2 * (j + 1)] += (er * j1r - ei * j1i) / ref;
          w[2 * (j + 1) + 1] += (er * j1i + ei * j1r) / ref;
        }
        start = end + 1;
      }
      return w;
    }
  }
  function cap(w, j, a, b, omega, ref) {
    const [cr, ci] = J0(omega, b - a);
    const er = Math.cos(omega * a), ei = Math.sin(omega * a);
    w[2 * j] += (er * cr - ei * ci) / ref;
    w[2 * j + 1] += (er * ci + ei * cr) / ref;
  }
  function J0(omega, h) {
    const x2 = omega * h;
    if (Math.abs(x2) < 1e-4) return [h * (1 - x2 * x2 / 6), h * (x2 / 2 - x2 * x2 * x2 / 24)];
    return [Math.sin(x2) / omega, (1 - Math.cos(x2)) / omega];
  }
  function J1(omega, h) {
    const x2 = omega * h;
    if (Math.abs(x2) < 1e-4) return [h * (0.5 - x2 * x2 / 8), h * (x2 / 3 - x2 * x2 * x2 / 30)];
    const c = Math.cos(x2), s = Math.sin(x2);
    return [h * (c + x2 * s - 1) / (x2 * x2), h * (s - x2 * c) / (x2 * x2)];
  }
  function boxBound(lo, hi, size) {
    if (size === 0 || lo <= 0 && hi >= 0) return 1;
    const nearest = Math.min(Math.abs(lo), Math.abs(hi)) * size;
    return nearest > 0 ? Math.min(1, 1 / (Math.PI * nearest)) : 1;
  }
  function sinc2(x2) {
    if (x2 === 0) return 1;
    const px = Math.PI * x2;
    return Math.abs(px) < 1e-6 ? 1 - px * px / 6 : Math.sin(px) / px;
  }

  // src/sim/phantom/model.ts
  function planeMaps(phantom, plane) {
    return plane < 0 ? phantom.maps : phantom.planes[plane].maps;
  }
  function assignPlanes(phantom, z) {
    const plane = new Int32Array(z.length).fill(-1);
    const planes = phantom.planes;
    if (!planes?.length || !(phantom.voxel[2] > 0)) return plane;
    for (let k = 0; k < z.length; k++) {
      const wanted = Math.round(z[k] / phantom.voxel[2]);
      let best = -1, distance3 = Math.abs(wanted);
      for (let i2 = 0; i2 < planes.length; i2++) {
        const d = Math.abs(planes[i2].offset - wanted);
        if (d < distance3) {
          distance3 = d;
          best = i2;
        }
      }
      plane[k] = best;
    }
    return plane;
  }
  function sliceVolume(volume2, options = {}) {
    const plane = options.plane ?? "xy";
    const [sx, sy, sz] = volume2.shape;
    const axes = plane === "xy" ? [0, 1, 2] : plane === "xz" ? [0, 2, 1] : [1, 2, 0];
    const sizes = [sx, sy, sz];
    const nu = sizes[axes[0]], nv = sizes[axes[1]], nw = sizes[axes[2]];
    const index = Math.round(options.index ?? Math.floor(nw / 2));
    if (!(index >= 0 && index < nw)) throw new Error(`Slice ${index} is outside 0\u2026${nw - 1}.`);
    const fovU = nu * volume2.voxel[axes[0]], fovV = nv * volume2.voxel[axes[1]];
    let nx = nu, ny = nv;
    if (options.matrix && options.matrix > 0) {
      const scale2 = options.matrix / Math.max(nu, nv);
      nx = Math.max(1, Math.round(nu * scale2));
      ny = Math.max(1, Math.round(nv * scale2));
    }
    const strides = [1, sx, sx * sy];
    const source = new Int32Array(nx * ny);
    for (let row = 0; row < ny; row++) {
      const v = Math.min(nv - 1, Math.floor((ny - 1 - row + 0.5) * nv / ny));
      for (let col = 0; col < nx; col++) {
        const u = Math.min(nu - 1, Math.floor((col + 0.5) * nu / nx));
        source[row * nx + col] = u * strides[axes[0]] + v * strides[axes[1]] + index * strides[axes[2]];
      }
    }
    const mapsAt = (offset) => {
      const shift = offset * strides[axes[2]];
      const pickAt = (map) => {
        const out = new Float32Array(nx * ny);
        for (let i2 = 0; i2 < out.length; i2++) out[i2] = map[source[i2] + shift];
        return out;
      };
      const maps2 = { pd: pickAt(volume2.maps.pd), t1: pickAt(volume2.maps.t1), t2: pickAt(volume2.maps.t2) };
      for (const name of ["t2prime", "adc", "b0", "b1"]) {
        const map = volume2.maps[name];
        if (map) maps2[name] = pickAt(map);
      }
      return maps2;
    };
    const maps = mapsAt(0);
    const planes = [];
    if (options.neighbours) {
      const [lo, hi] = options.neighbours;
      let empty = null;
      for (let offset = Math.min(0, Math.round(lo)); offset <= Math.max(0, Math.round(hi)); offset++) {
        if (offset === 0) continue;
        const inside = index + offset >= 0 && index + offset < nw;
        if (inside) {
          planes.push({ offset, maps: mapsAt(offset) });
        } else {
          empty ?? (empty = { pd: new Float32Array(nx * ny), t1: new Float32Array(nx * ny), t2: new Float32Array(nx * ny) });
          planes.push({ offset, maps: empty });
        }
      }
    }
    const label = "xyz";
    return {
      nx,
      ny,
      voxel: [fovU / nx, fovV / ny, volume2.voxel[axes[2]]],
      maps,
      planes: planes.length ? planes : void 0,
      source: `${volume2.source} \xB7 ${label[axes[0]]}${label[axes[1]]} plane, ${label[axes[2]]} = ${index}`,
      notes: volume2.notes.slice()
    };
  }
  function mrzeroFieldMaps(volume2) {
    const [nx, ny, nz] = volume2.shape;
    const n = nx * ny * nz;
    const b0 = new Float32Array(n), b1 = new Float32Array(n);
    const lin = (count, i2) => count > 1 ? -1 + 2 * i2 / (count - 1) : -1;
    let weightSum = 0, b0Sum = 0, b1Sum = 0;
    for (let z = 0; z < nz; z++) {
      const pz = lin(nz, z);
      for (let y = 0; y < ny; y++) {
        const py = lin(ny, y);
        for (let x2 = 0; x2 < nx; x2++) {
          const px = lin(nx, x2);
          const i2 = x2 + nx * (y + ny * z);
          const field = Math.exp(-(0.4 * px * px + 0.2 * py * py + 0.3 * pz * pz));
          const dist2 = 0.4 * px * px + 0.2 * (py - 0.7) ** 2 + 0.3 * pz * pz;
          const offset = 7 / (0.05 + dist2) - 45 / (0.3 + dist2);
          b1[i2] = field;
          b0[i2] = offset;
          const w = volume2.maps.pd[i2];
          weightSum += w;
          b0Sum += offset * w;
          b1Sum += field * w;
        }
      }
    }
    if (weightSum > 0) {
      const meanB0 = b0Sum / weightSum, meanB1 = b1Sum / weightSum;
      for (let i2 = 0; i2 < n; i2++) {
        b0[i2] -= meanB0;
        if (meanB1 > 0) b1[i2] /= meanB1;
      }
    }
    return { b0, b1 };
  }
  function syntheticCoils(nx, ny, voxel, count) {
    const cells = nx * ny;
    const re = new Float32Array(count * cells), im = new Float32Array(count * cells);
    const halfX = nx * voxel[0] / 2, halfY = ny * voxel[1] / 2;
    const radius = 1.1 * Math.max(halfX, halfY);
    const width = 0.9 * Math.max(halfX, halfY);
    const centre = (c) => {
      const angle = 2 * Math.PI * c / count + Math.PI / 2;
      return [radius * Math.cos(angle), radius * Math.sin(angle)];
    };
    let centrePower = 0;
    for (let c = 0; c < count; c++) {
      const [cx, cy] = centre(c);
      centrePower += Math.exp(-(cx * cx + cy * cy) / (width * width));
    }
    const norm3 = count === 1 ? 1 : 1 / Math.sqrt(centrePower);
    for (let c = 0; c < count; c++) {
      const [cx, cy] = centre(c);
      for (let row = 0; row < ny; row++) {
        const y = (ny / 2 - 1 - row) * voxel[1];
        for (let col = 0; col < nx; col++) {
          const x2 = (col - nx / 2) * voxel[0];
          const i2 = c * cells + row * nx + col;
          if (count === 1) {
            re[i2] = 1;
            continue;
          }
          const dx = x2 - cx, dy = y - cy;
          const magnitude = norm3 * Math.exp(-(dx * dx + dy * dy) / (2 * width * width));
          const phase = Math.atan2(dy, dx);
          re[i2] = magnitude * Math.cos(phase);
          im[i2] = magnitude * Math.sin(phase);
        }
      }
    }
    return { count, re, im };
  }
  function occupiedVoxels(phantom) {
    const cells = phantom.nx * phantom.ny;
    const any = new Uint8Array(cells);
    for (const maps of [phantom.maps, ...(phantom.planes ?? []).map((plane) => plane.maps)]) {
      for (let i2 = 0; i2 < cells; i2++) if (maps.pd[i2] > 0) any[i2] = 1;
    }
    let count = 0;
    for (let i2 = 0; i2 < cells; i2++) count += any[i2];
    const voxels = new Int32Array(count);
    let k = 0;
    for (let i2 = 0; i2 < cells; i2++) if (any[i2]) voxels[k++] = i2;
    return voxels;
  }
  function rate(time) {
    return Number.isFinite(time) && time > 0 ? 1 / time : 0;
  }
  function physicsTable(phantom) {
    const table = { of: new Int32Array(0), ofPlanes: [], t1: [], t2: [], t2p: [], adc: [], df: [], b1: [], pathway: false };
    const index = /* @__PURE__ */ new Map();
    const entries = (maps) => {
      const { pd, t1, t2, t2prime, adc, b0, b1 } = maps;
      const of = new Int32Array(pd.length).fill(-1);
      for (let i2 = 0; i2 < pd.length; i2++) {
        if (!(pd[i2] > 0)) continue;
        const df = b0 ? b0[i2] : 0, gain = b1 ? b1[i2] : 1;
        const t2p = t2prime && Number.isFinite(t2prime[i2]) && t2prime[i2] > 0 ? t2prime[i2] : Infinity;
        const d = adc && adc[i2] > 0 ? adc[i2] : 0;
        const key = `${t1[i2]}|${t2[i2]}|${t2p}|${d}|${df}|${gain}`;
        let k = index.get(key);
        if (k === void 0) {
          k = table.t1.length;
          index.set(key, k);
          table.t1.push(t1[i2]);
          table.t2.push(t2[i2]);
          table.t2p.push(t2p);
          table.adc.push(d);
          table.df.push(df);
          table.b1.push(gain);
          if (Number.isFinite(t2p) || d > 0) table.pathway = true;
        }
        of[i2] = k;
      }
      return of;
    };
    table.of = entries(phantom.maps);
    table.ofPlanes = (phantom.planes ?? []).map((plane) => entries(plane.maps));
    return table;
  }
  function entriesOf(physics, plane) {
    return plane < 0 ? physics.of : physics.ofPlanes[plane];
  }
  function slicesOf(options) {
    return options.slices ?? { z: Float64Array.of(0), weight: Float64Array.of(1), plane: Int32Array.of(-1) };
  }
  function xCount(options, index) {
    return options.countX ? options.countX[index] : options.subSpins[0];
  }
  function spinCount(options, phantom) {
    const slices = slicesOf(options);
    let total = 0;
    for (let v = 0; v < options.voxels.length; v++) {
      const index = options.voxels[v];
      let present = 0;
      for (let k = 0; k < slices.z.length; k++) {
        if (!phantom || planeMaps(phantom, slices.plane[k]).pd[index] > 0) present++;
      }
      total += xCount(options, index) * present;
    }
    return total * options.subSpins[1];
  }
  function phantomSpins(phantom, options) {
    const my = options.subSpins[1];
    const voxels = options.voxels;
    const slices = slicesOf(options);
    const count = spinCount(options, phantom);
    const coils = phantom.coils?.count ?? 1;
    const pathway = [phantom.maps, ...(phantom.planes ?? []).map((plane) => plane.maps)].some((maps) => maps.t2prime || maps.adc);
    const set = {
      count,
      x: new Float64Array(count),
      y: new Float64Array(count),
      z: new Float64Array(count),
      df: new Float64Array(count),
      r1: new Float64Array(count),
      r2: new Float64Array(count),
      r2prime: pathway ? new Float64Array(count) : void 0,
      adc: pathway ? new Float64Array(count) : void 0,
      weight: new Float64Array(count),
      b1Re: new Float64Array(count),
      b1Im: new Float64Array(count),
      coils,
      rxRe: new Float64Array(coils * count),
      rxIm: new Float64Array(coils * count)
    };
    const cells = phantom.nx * phantom.ny;
    const [dx, dy] = phantom.voxel;
    const offsetsY = stratified(my);
    let k = 0;
    for (let v = 0; v < voxels.length; v++) {
      const index = voxels[v];
      const mx = xCount(options, index);
      const offsetsX = stratified(mx);
      const col = index % phantom.nx, row = Math.floor(index / phantom.nx);
      const x0 = (col - phantom.nx / 2) * dx;
      const y0 = (phantom.ny / 2 - 1 - row) * dy;
      for (let slice = 0; slice < slices.z.length; slice++) {
        const { pd, t1, t2, t2prime, adc, b0, b1 } = planeMaps(phantom, slices.plane[slice]);
        if (!(pd[index] > 0)) continue;
        const r1 = rate(t1[index]), r2 = rate(t2[index]);
        const r2p = t2prime ? rate(t2prime[index]) : 0, d = adc && adc[index] > 0 ? adc[index] : 0;
        const df = b0 ? b0[index] : 0;
        const gain = b1 ? b1[index] : 1;
        const weight = pd[index] / (mx * my) * slices.weight[slice];
        for (const oy of offsetsY) {
          for (const ox of offsetsX) {
            set.x[k] = x0 + ox * dx;
            set.y[k] = y0 + oy * dy;
            set.z[k] = slices.z[slice];
            set.df[k] = df;
            set.r1[k] = r1;
            set.r2[k] = r2;
            if (set.r2prime && set.adc) {
              set.r2prime[k] = r2p;
              set.adc[k] = d;
            }
            set.weight[k] = weight;
            set.b1Re[k] = gain;
            for (let c = 0; c < coils; c++) {
              set.rxRe[c * count + k] = phantom.coils ? phantom.coils.re[c * cells + index] : 1;
              set.rxIm[c * count + k] = phantom.coils ? phantom.coils.im[c * cells + index] : 0;
            }
            k++;
          }
        }
      }
    }
    return set;
  }
  function foldedPhantomSpins(phantom, physics, options, fold) {
    const [finest, my] = options.subSpins;
    const voxels = options.voxels;
    const foldX = (fold & 1) !== 0, foldY = (fold & 2) !== 0;
    const [dx, dy] = phantom.voxel;
    const offsetsY = stratified(my);
    const lineY = phantom.ny * my;
    const entries = physics.t1.length;
    const coils = phantom.coils?.count ?? 1;
    const cells = phantom.nx * phantom.ny;
    const slices = slicesOf(options);
    const through = options.slices !== void 0;
    const usedPlanes = [...new Set(Array.from(slices.plane))];
    const slicesOfPlane = new Map(usedPlanes.map((plane) => [plane, []]));
    for (let k = 0; k < slices.z.length; k++) slicesOfPlane.get(slices.plane[k]).push(k);
    const planeSlot = new Map(usedPlanes.map((plane, i2) => [plane, i2]));
    let memberCount = 0;
    for (let v = 0; v < voxels.length; v++) {
      for (const plane of usedPlanes) if (planeMaps(phantom, plane).pd[voxels[v]] > 0) memberCount += xCount(options, voxels[v]) * my;
    }
    const classOf = new Int32Array(memberCount);
    const weight = new Float64Array(memberCount);
    const foldOf = new Int32Array(memberCount);
    const rxRe = new Float64Array(coils * memberCount), rxIm = new Float64Array(coils * memberCount);
    const classIndex = /* @__PURE__ */ new Map();
    const pointIndex = /* @__PURE__ */ new Map();
    const classX = [], classY = [], classEntry = [], classPlane = [];
    const points = [];
    let m = 0;
    for (let v = 0; v < voxels.length; v++) {
      const index = voxels[v];
      for (const plane of usedPlanes) {
        const maps = planeMaps(phantom, plane);
        if (!(maps.pd[index] > 0)) continue;
        const mx = xCount(options, index);
        const offsetsX = stratified(mx);
        const stepX = finest / mx;
        const col = index % phantom.nx, row = Math.floor(index / phantom.nx);
        const entry = entriesOf(physics, plane)[index];
        const w = maps.pd[index] / (mx * my);
        const x0 = (col - phantom.nx / 2) * dx;
        const y0 = (phantom.ny / 2 - 1 - row) * dy;
        const slot = planeSlot.get(plane);
        for (let ay = 0; ay < my; ay++) {
          const y = y0 + offsetsY[ay] * dy;
          const jy = row * my + ay;
          for (let ax = 0; ax < mx; ax++) {
            const x2 = x0 + offsetsX[ax] * dx;
            const jx = col * 2 * finest + (2 * ax + 1) * stepX;
            const classKey = (((foldX ? 0 : jx) * lineY + (foldY ? 0 : jy)) * entries + entry) * usedPlanes.length + slot;
            let c2 = classIndex.get(classKey);
            if (c2 === void 0) {
              c2 = classX.length;
              classIndex.set(classKey, c2);
              classX.push(foldX ? 0 : x2);
              classY.push(foldY ? 0 : y);
              classEntry.push(entry);
              classPlane.push(plane);
            }
            const pointKey = (foldX ? jx : 0) * (lineY + 1) + (foldY ? jy : 0);
            let p = pointIndex.get(pointKey);
            if (p === void 0) {
              p = points.length / 3;
              pointIndex.set(pointKey, p);
              points.push(foldX ? x2 : 0, foldY ? y : 0, 0);
            }
            classOf[m] = c2;
            weight[m] = w;
            foldOf[m] = p;
            for (let coil = 0; coil < coils; coil++) {
              rxRe[coil * memberCount + m] = phantom.coils ? phantom.coils.re[coil * cells + index] : 1;
              rxIm[coil * memberCount + m] = phantom.coils ? phantom.coils.im[coil * cells + index] : 0;
            }
            m++;
          }
        }
      }
    }
    const profiles = classX.length;
    if (!through) {
      const classes2 = {
        count: profiles,
        x: Float64Array.from(classX),
        y: Float64Array.from(classY),
        z: new Float64Array(profiles),
        df: Float64Array.from(classEntry, (e) => physics.df[e]),
        r1: Float64Array.from(classEntry, (e) => rate(physics.t1[e])),
        r2: Float64Array.from(classEntry, (e) => rate(physics.t2[e])),
        r2prime: physics.pathway ? Float64Array.from(classEntry, (e) => rate(physics.t2p[e])) : void 0,
        adc: physics.pathway ? Float64Array.from(classEntry, (e) => physics.adc[e]) : void 0,
        weight: new Float64Array(profiles),
        b1Re: Float64Array.from(classEntry, (e) => physics.b1[e]),
        b1Im: new Float64Array(profiles),
        coils: 1,
        rxRe: new Float64Array(profiles).fill(1),
        rxIm: new Float64Array(profiles)
      };
      const members2 = { count: memberCount, classOf, weight, foldOf, foldPoints: Float64Array.from(points), coils, rxRe, rxIm };
      return { classes: classes2, members: members2 };
    }
    let count = 0;
    for (let q = 0; q < profiles; q++) count += slicesOfPlane.get(classPlane[q]).length;
    const profileOf = new Int32Array(count);
    const classes = {
      count,
      x: new Float64Array(count),
      y: new Float64Array(count),
      z: new Float64Array(count),
      df: new Float64Array(count),
      r1: new Float64Array(count),
      r2: new Float64Array(count),
      r2prime: physics.pathway ? new Float64Array(count) : void 0,
      adc: physics.pathway ? new Float64Array(count) : void 0,
      weight: new Float64Array(count),
      b1Re: new Float64Array(count),
      b1Im: new Float64Array(count),
      coils: 1,
      rxRe: new Float64Array(count).fill(1),
      rxIm: new Float64Array(count)
    };
    let c = 0;
    for (let q = 0; q < profiles; q++) {
      const e = classEntry[q];
      for (const k of slicesOfPlane.get(classPlane[q])) {
        classes.x[c] = classX[q];
        classes.y[c] = classY[q];
        classes.z[c] = slices.z[k];
        classes.df[c] = physics.df[e];
        classes.r1[c] = rate(physics.t1[e]);
        classes.r2[c] = rate(physics.t2[e]);
        if (classes.r2prime && classes.adc) {
          classes.r2prime[c] = rate(physics.t2p[e]);
          classes.adc[c] = physics.adc[e];
        }
        classes.b1Re[c] = physics.b1[e];
        classes.weight[c] = slices.weight[k];
        profileOf[c] = q;
        c++;
      }
    }
    const members = {
      count: memberCount,
      classOf,
      weight,
      foldOf,
      foldPoints: Float64Array.from(points),
      coils,
      rxRe,
      rxIm,
      profileOf,
      profiles
    };
    return { classes, members };
  }
  function stratified(count) {
    return Array.from({ length: count }, (_, a) => (a + 0.5) / count - 0.5);
  }

  // src/sim/phantom/phaseGraphModel.ts
  function phaseGraphPhantom(phantom, slices, rfStep, fineStep, budget) {
    const K = slices ? slices.z.length : 1;
    const runs = [];
    for (let j = 0; j < K; j++) {
      const plane = slices ? slices.plane[j] : -1;
      const last = runs[runs.length - 1];
      if (last && last.plane === plane) last.to = j + 1;
      else runs.push({ plane, from: j, to: j + 1 });
    }
    const voxels = occupiedVoxels(phantom);
    const cells = phantom.nx * phantom.ny;
    const [dx, dy] = phantom.voxel;
    const xs = [], ys = [], dfs = [], pds = [], froms = [], tos = [];
    const t1s = [], t2s = [], t2ps = [], adcs = [], b1s = [], cellOf = [];
    for (const v of voxels) {
      const col = v % phantom.nx, row = Math.floor(v / phantom.nx);
      for (const run of runs) {
        const maps = planeMaps(phantom, run.plane);
        const pd = maps.pd[v];
        if (!(pd > 0)) continue;
        xs.push((col - phantom.nx / 2) * dx);
        ys.push((phantom.ny / 2 - 1 - row) * dy);
        dfs.push(maps.b0 ? maps.b0[v] : 0);
        pds.push(pd);
        froms.push(run.from);
        tos.push(run.to);
        t1s.push(maps.t1[v]);
        t2s.push(maps.t2[v]);
        t2ps.push(maps.t2prime ? maps.t2prime[v] : Infinity);
        adcs.push(maps.adc && maps.adc[v] > 0 ? maps.adc[v] : 0);
        b1s.push(maps.b1 ? maps.b1[v] : 1);
        cellOf.push(v);
      }
    }
    const count = xs.length;
    let binning = { t: 0, b1: 0, df: rfStep };
    let assignment = assign(binning);
    while (assignment.keys.size > budget) {
      binning = binning.t === 0 ? { t: fineStep.t, b1: fineStep.b1, df: rfStep } : { t: 2 * binning.t, b1: 2 * binning.b1, df: 2 * binning.df };
      assignment = assign(binning);
      if (binning.t > 1) break;
    }
    const classOf = assignment.classOf;
    const C = assignment.keys.size;
    const S = 7;
    const sum = new Float64Array(S * C);
    for (let i2 = 0; i2 < count; i2++) {
      const c = classOf[i2], w = pds[i2];
      sum[S * c] += w;
      sum[S * c + 1] += w * finiteOr(t1s[i2], 1e6);
      sum[S * c + 2] += w * finiteOr(t2s[i2], 1e6);
      sum[S * c + 3] += w * b1s[i2];
      sum[S * c + 4] += w * dfs[i2];
      sum[S * c + 5] += w * (Number.isFinite(t2ps[i2]) && t2ps[i2] > 0 ? 1 / t2ps[i2] : 0);
      sum[S * c + 6] += w * adcs[i2];
    }
    const classes = [];
    for (let c = 0; c < C; c++) {
      const w = sum[S * c], rate2 = sum[S * c + 5] / w;
      classes.push({
        t1: sum[S * c + 1] / w,
        t2: sum[S * c + 2] / w,
        b1Re: sum[S * c + 3] / w,
        b1Im: 0,
        df: sum[S * c + 4] / w,
        t2prime: rate2 > 0 ? 1 / rate2 : Infinity,
        adc: sum[S * c + 6] / w
      });
    }
    const coils = phantom.coils?.count ?? 1;
    const rxRe = new Float64Array(coils * count), rxIm = new Float64Array(coils * count);
    for (let i2 = 0; i2 < count; i2++) {
      for (let c = 0; c < coils; c++) {
        rxRe[c * count + i2] = phantom.coils ? phantom.coils.re[c * cells + cellOf[i2]] : 1;
        rxIm[c * count + i2] = phantom.coils ? phantom.coils.im[c * cells + cellOf[i2]] : 0;
      }
    }
    return {
      classes,
      sources: {
        count,
        x: Float64Array.from(xs),
        y: Float64Array.from(ys),
        df: Float64Array.from(dfs),
        classOf,
        sliceFrom: Int32Array.from(froms),
        sliceTo: Int32Array.from(tos),
        pd: Float64Array.from(pds),
        coils,
        rxRe,
        rxIm
      },
      binning
    };
    function assign(bins) {
      const keys = /* @__PURE__ */ new Map();
      const classOf2 = new Int32Array(count);
      const logStep = (step) => Math.log1p(step);
      const timeKey = (t) => !(Number.isFinite(t) && t > 0) ? "inf" : bins.t > 0 ? String(Math.round(Math.log(t) / logStep(bins.t))) : String(t);
      for (let i2 = 0; i2 < count; i2++) {
        const key = `${timeKey(t1s[i2])}|${timeKey(t2s[i2])}|${timeKey(t2ps[i2])}|${timeKey(adcs[i2])}|${bins.b1 > 0 ? Math.round(b1s[i2] / bins.b1) : b1s[i2]}|${Math.round(dfs[i2] / bins.df)}`;
        let c = keys.get(key);
        if (c === void 0) {
          c = keys.size;
          keys.set(key, c);
        }
        classOf2[i2] = c;
      }
      return { keys, classOf: classOf2 };
    }
  }
  function finiteOr(value, fallback) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  // src/sim/phantom/builtin.ts
  var TISSUES = {
    skin: { name: "skin", pd: 0.9, t1: 0.25, t2: 0.07, t2prime: 0.07, adc: 5e-10 },
    whiteMatter: { name: "white matter", pd: 0.69, t1: 0.83, t2: 0.08, t2prime: 0.15, adc: 7e-10 },
    greyMatter: { name: "grey matter", pd: 0.8, t1: 1.33, t2: 0.11, t2prime: 0.17, adc: 8e-10 },
    csf: { name: "CSF", pd: 1, t1: 4, t2: 2, t2prime: 0.5, adc: 3e-9 },
    lesion: { name: "lesion", pd: 0.85, t1: 1.6, t2: 0.25, t2prime: 0.12, adc: 14e-10 }
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
  var SHEPP_LOGAN_3D = [
    { a: 0.69, b: 0.92, c: 0.9, x0: 0, y0: 0, z0: 0, deg: 0, tissue: TISSUES.skin },
    { a: 0.6624, b: 0.874, c: 0.88, x0: 0, y0: 0, z0: 0, deg: 0, tissue: TISSUES.whiteMatter },
    { a: 0.41, b: 0.16, c: 0.21, x0: -0.22, y0: 0, z0: -0.25, deg: 108, tissue: TISSUES.csf },
    { a: 0.31, b: 0.11, c: 0.22, x0: 0.22, y0: 0, z0: -0.25, deg: 72, tissue: TISSUES.csf },
    { a: 0.21, b: 0.25, c: 0.5, x0: 0, y0: 0.35, z0: -0.25, deg: 0, tissue: TISSUES.greyMatter },
    { a: 0.046, b: 0.046, c: 0.046, x0: 0, y0: 0.1, z0: -0.25, deg: 0, tissue: TISSUES.greyMatter },
    { a: 0.046, b: 0.023, c: 0.02, x0: -0.08, y0: -0.65, z0: -0.25, deg: 0, tissue: TISSUES.lesion },
    { a: 0.046, b: 0.023, c: 0.02, x0: 0.06, y0: -0.65, z0: -0.25, deg: 90, tissue: TISSUES.lesion },
    { a: 0.056, b: 0.04, c: 0.1, x0: 0.06, y0: -0.105, z0: 0.625, deg: 90, tissue: TISSUES.lesion },
    { a: 0.056, b: 0.056, c: 0.1, x0: 0, y0: 0.1, z0: 0.625, deg: 0, tissue: TISSUES.csf }
  ];
  function sheppLoganVolume(n, nz, fov) {
    if (!(n >= 2) || !Number.isInteger(n) || !(nz >= 1) || !Number.isInteger(nz)) {
      throw new Error(`phantom size must be integers n \u2265 2 and nz \u2265 1, got ${n} \xD7 ${n} \xD7 ${nz}`);
    }
    const size = n * n * nz;
    const maps = {
      pd: new Float32Array(size),
      t1: new Float32Array(size).fill(Infinity),
      t2: new Float32Array(size).fill(Infinity),
      t2prime: new Float32Array(size).fill(Infinity),
      adc: new Float32Array(size)
    };
    const rotations = SHEPP_LOGAN_3D.map((e) => [Math.cos(e.deg * Math.PI / 180), Math.sin(e.deg * Math.PI / 180)]);
    for (let k = 0; k < nz; k++) {
      const w = 2 * (k - nz / 2) / nz;
      for (let j = 0; j < n; j++) {
        const v = 2 * (j - n / 2) / n;
        for (let i2 = 0; i2 < n; i2++) {
          const u = 2 * (i2 - n / 2) / n;
          let tissue = null;
          SHEPP_LOGAN_3D.forEach((e, index2) => {
            const [cos, sin] = rotations[index2];
            const dx = u - e.x0, dy = v - e.y0;
            const xr = dx * cos + dy * sin, yr = -dx * sin + dy * cos;
            if ((xr / e.a) ** 2 + (yr / e.b) ** 2 + ((w - e.z0) / e.c) ** 2 <= 1) tissue = e.tissue;
          });
          if (!tissue) continue;
          const t = tissue;
          const index = (k * n + j) * n + i2;
          maps.pd[index] = t.pd;
          maps.t1[index] = t.t1;
          maps.t2[index] = t.t2;
          maps.t2prime[index] = t.t2prime;
          maps.adc[index] = t.adc;
        }
      }
    }
    return {
      shape: [n, n, nz],
      voxel: [fov[0] / n, fov[1] / n, fov[2] / nz],
      maps,
      source: `Shepp\u2013Logan 3-D ${n}\xD7${n}\xD7${nz}`,
      notes: []
    };
  }
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
      t2: new Float32Array(size).fill(Infinity),
      t2prime: new Float32Array(size).fill(Infinity),
      adc: new Float32Array(size)
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
        grid.t2prime[index] = tissue.t2prime;
        grid.adc[index] = tissue.adc;
      }
    }
    return grid;
  }
  function sheppLoganPhantom2D(n, fovX, fovY) {
    const grid = sheppLoganPhantom(n, fovX, fovY);
    return {
      nx: n,
      ny: n,
      voxel: [fovX / n, fovY / n, 0],
      maps: { pd: grid.pd, t1: grid.t1, t2: grid.t2, t2prime: grid.t2prime, adc: grid.adc },
      source: `Shepp\u2013Logan ${n}\xB2`,
      notes: []
    };
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
        for (let i2 = 0; i2 < ga.length; i2++) if (ga[i2] !== 0 || gb[i2] !== 0) rfGradientAxes |= 1 << i2 % 3;
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
    return extent > 0.5 + 1e-3 ? Math.ceil(4 * extent - 0.05) : 1;
  }
  function intervalCycles(analysis, axis, voxel) {
    return analysis.intervalArea[axis] * voxel;
  }

  // src/sim/plan/probe.ts
  var POWER_OF_TWO_COUNTS = Array.from({ length: 13 }, (_, i2) => 2 ** i2);
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
    const list = options.candidates ?? CANDIDATES;
    const first = options.candidates ? list.find((n) => n >= minimum) ?? maximum : minimum;
    const candidates = [first, ...list.filter((n) => n > first && n <= maximum)];
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
    const rate2 = (time) => Number.isFinite(time) && time > 0 ? 1 / time : 0;
    return {
      count,
      x: positions[0],
      y: positions[1],
      z: positions[2],
      df: new Float64Array(count),
      r1: new Float64Array(count).fill(rate2(tissue.t1)),
      r2: new Float64Array(count).fill(rate2(tissue.t2)),
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
    for (let i2 = 0; i2 < signal.length; i2++) sum += signal[i2] * signal[i2];
    return Math.sqrt(sum);
  }
  function distance(a, b) {
    let sum = 0;
    for (let i2 = 0; i2 < a.length; i2++) sum += (a[i2] - b[i2]) ** 2;
    return Math.sqrt(sum);
  }

  // src/sim/plan/slices.ts
  var Z_LIMIT = 0.25;
  var MIN_EXTENT = 2;
  var CANDIDATE_LEVEL = 1e-4;
  var SUPPORT_LEVEL = 2e-3;
  var EDGE_LEVEL = 1e-3;
  var COARSE_POINTS = 16384;
  var FINE_POINTS = 4096;
  var FINE_PER_CELL = 4;
  var FINE_MIN_POINTS = 64;
  var SPECTRAL_POINTS = 1024;
  var SPECTRAL_ENERGY = 0.995;
  var TIERS = [0.1, 0.02, 4e-3];
  var FREQUENCY_LIMIT = 5e4;
  function measurePulses(program, options = {}) {
    const found = /* @__PURE__ */ new Map();
    for (const segment of program.segments()) {
      if (segment.kind !== "rf") continue;
      const use = segment.use || "u";
      const entry = found.get(segment.key);
      if (entry) {
        entry.events++;
        entry.uses.add(use);
      } else {
        found.set(segment.key, { segment, events: 1, uses: /* @__PURE__ */ new Set([use]) });
      }
    }
    const alike = /* @__PURE__ */ new Map();
    for (const [key, entry] of found) {
      const cells = rfCells(entry.segment, 0);
      const signature = zSignature(cells);
      const twin = alike.get(signature);
      if (twin) {
        twin.keys.push(key);
        twin.events += entry.events;
        for (const use of entry.uses) twin.uses.add(use);
      } else {
        alike.set(signature, { segment: entry.segment, cells, keys: [key], events: entry.events, uses: entry.uses });
      }
    }
    return [...alike.values()].map((entry) => measurePulse(entry.segment, entry.cells, entry.keys, roleOf(entry.uses), entry.events, options));
  }
  function zSignature(cells) {
    const n = cells.count;
    const values = new Float64Array(4 * n + 1);
    values[0] = cells.freq;
    for (let j = 0; j < n; j++) {
      values[1 + 4 * j] = cells.width[j];
      values[2 + 4 * j] = cells.b1Re[j];
      values[3 + 4 * j] = cells.b1Im[j];
      values[4 + 4 * j] = cells.grad[3 * j + 2];
    }
    const words = new Uint32Array(values.buffer);
    let h1 = 2166136261, h2 = 2654435769;
    for (let i2 = 0; i2 < words.length; i2++) {
      h1 = Math.imul(h1 ^ words[i2], 16777619);
      h2 = Math.imul(h2 ^ words[i2], 1540483477) ^ h2 >>> 15;
    }
    return `${n}:${(h1 >>> 0).toString(16)}:${(h2 >>> 0).toString(16)}`;
  }
  function roleOf(uses) {
    if (uses.has("e") || uses.has("u")) return "excitation";
    if (uses.has("r")) return "refocusing";
    if (uses.has("p") || uses.has("o")) return "other";
    if (uses.has("i")) return "inversion";
    if (uses.has("s")) return "saturation";
    return "other";
  }
  function geometry(cells) {
    const n = cells.count;
    let duration = 0;
    for (let j = 0; j < n; j++) duration += cells.width[j];
    const kappa = new Float64Array(n), tau = new Float64Array(n);
    let tail = 0, lo = 0, hi = 0, end = duration;
    for (let j = n - 1; j >= 0; j--) {
      const w = cells.width[j], g = cells.grad[3 * j + 2];
      kappa[j] = tail + 0.5 * g * w;
      tau[j] = end - 0.5 * w;
      tail += g * w;
      end -= w;
      lo = Math.min(lo, tail);
      hi = Math.max(hi, tail);
    }
    return { cells, duration, kappa, tau, extentZ: hi - lo };
  }
  function measurePulse(segment, cells, keys, role, events, options) {
    const shape = geometry(cells);
    const { duration, extentZ } = shape;
    const selective = extentZ >= MIN_EXTENT;
    const resolution = selective ? 1 / extentZ : 1 / Math.max(duration, 1e-6);
    let limit;
    if (selective) {
      limit = options.zLimit ?? Z_LIMIT;
    } else {
      let narrowest = Infinity;
      for (let j = 0; j < cells.count; j++) narrowest = Math.min(narrowest, cells.width[j]);
      limit = Math.min(FREQUENCY_LIMIT, 0.5 / narrowest);
    }
    const slope = selective ? shape.kappa : shape.tau;
    const small = smallTip(cells, slope, shape.tau, -limit, limit, resolution);
    let regions;
    let scan;
    if (selective) {
      regions = candidateRegions(small, resolution, -limit, limit);
      scan = fineScan(cells, true, regions, resolution, limit);
    } else {
      const [from, to] = energyWindow(small);
      const pad = Math.max(0.25 * (to - from), 4 * resolution);
      regions = [[Math.max(-limit, Math.min(0, from) - pad), Math.min(limit, Math.max(0, to) + pad)]];
      const points = Math.max(128, Math.min(SPECTRAL_POINTS, Math.ceil((regions[0][1] - regions[0][0]) / (resolution / FINE_PER_CELL)) + 1));
      scan = uniformScan(cells, false, regions[0][0], regions[0][1], points);
    }
    let peak = 0;
    for (let i2 = 0; i2 < scan.mz.length; i2++) peak = Math.max(peak, activity(scan.mz[i2]));
    return {
      keys,
      role,
      events,
      firstTime: segment.t0,
      duration,
      freq: cells.freq,
      peakFlipDeg: 2 * Math.asin(Math.min(1, peak)) * 180 / Math.PI,
      extentZ: selective ? extentZ : 0,
      axis: selective ? "z" : "frequency",
      offsets: scan.offsets,
      mx: scan.mx,
      my: scan.my,
      mz: scan.mz,
      regions,
      bands: selective ? findBands(scan, role, resolution) : []
    };
  }
  function activity(mz) {
    return Math.sqrt(Math.max(0, 0.5 * (1 - mz)));
  }
  function smallTip(cells, slope, tau, from, to, resolution) {
    const points = Math.max(256, Math.min(COARSE_POINTS, Math.ceil((to - from) / (0.25 * resolution)) + 1));
    const step = (to - from) / (points - 1);
    const sumRe = new Float64Array(points), sumIm = new Float64Array(points);
    const twoPi = 2 * Math.PI;
    for (let j = 0; j < cells.count; j++) {
      const cr = cells.b1Re[j] * cells.width[j], ci = cells.b1Im[j] * cells.width[j];
      if (cr === 0 && ci === 0) continue;
      const stepCycles = slope[j] * step;
      const sr = Math.cos(twoPi * (stepCycles - Math.round(stepCycles)));
      const si = Math.sin(twoPi * (stepCycles - Math.round(stepCycles)));
      let er = 0, ei = 0;
      for (let i2 = 0; i2 < points; i2++) {
        if (i2 % 256 === 0) {
          const cycles = slope[j] * (from + i2 * step) - cells.freq * tau[j];
          const angle = twoPi * (cycles - Math.round(cycles));
          er = Math.cos(angle);
          ei = Math.sin(angle);
        } else {
          const nr = er * sr - ei * si;
          ei = er * si + ei * sr;
          er = nr;
        }
        sumRe[i2] += cr * er - ci * ei;
        sumIm[i2] += cr * ei + ci * er;
      }
    }
    const magnitude = new Float64Array(points);
    for (let i2 = 0; i2 < points; i2++) magnitude[i2] = Math.hypot(sumRe[i2], sumIm[i2]);
    return { from, step, magnitude };
  }
  function candidateRegions(small, resolution, lo, hi) {
    const { from, step, magnitude } = small;
    let peak = 0;
    for (let i2 = 0; i2 < magnitude.length; i2++) peak = Math.max(peak, magnitude[i2]);
    if (!(peak > 0)) return [];
    const runs = [];
    for (let i2 = 0; i2 < magnitude.length; i2++) {
      if (magnitude[i2] < CANDIDATE_LEVEL * peak) continue;
      const u = from + i2 * step;
      const last = runs[runs.length - 1];
      if (last && u - last[1] <= 2 * resolution + step) last[1] = u;
      else runs.push([u, u]);
    }
    return mergeIntervals(runs.map(([a, b]) => [Math.max(lo, a - 4 * resolution), Math.min(hi, b + 4 * resolution)]));
  }
  function energyWindow(small) {
    const { from, step, magnitude } = small;
    let total = 0;
    for (let i2 = 0; i2 < magnitude.length; i2++) total += magnitude[i2] * magnitude[i2];
    if (!(total > 0)) return [0, 0];
    const cut = 0.5 * (1 - SPECTRAL_ENERGY) * total;
    let lo = 0, hi = magnitude.length - 1, sum = 0;
    while (lo < hi && sum + magnitude[lo] ** 2 <= cut) sum += magnitude[lo++] ** 2;
    sum = 0;
    while (hi > lo && sum + magnitude[hi] ** 2 <= cut) sum += magnitude[hi--] ** 2;
    return [from + lo * step, from + hi * step];
  }
  function uniformScan(cells, selective, from, to, points) {
    const offsets = new Float64Array(points);
    for (let i2 = 0; i2 < points; i2++) offsets[i2] = points > 1 ? from + (to - from) * i2 / (points - 1) : 0.5 * (from + to);
    const [mx, my, mz] = respond(cells, selective, offsets);
    return { offsets, mx, my, mz, spacing: new Float64Array(points).fill(points > 1 ? (to - from) / (points - 1) : 0) };
  }
  function fineScan(cells, selective, regions, resolution, limit) {
    const total = regions.reduce((sum, [a, b]) => sum + (b - a), 0);
    const spacingFor = (width) => {
      const wanted = resolution / FINE_PER_CELL;
      const budget = total > 0 ? total / FINE_POINTS : wanted;
      return Math.min(Math.max(wanted, budget), width / (FINE_MIN_POINTS - 1));
    };
    const parts = [];
    let peak = 0;
    const scanRegion = (a, b) => {
      const h = spacingFor(Math.max(b - a, resolution));
      const count = Math.max(FINE_MIN_POINTS, Math.round((b - a) / h) + 1);
      const offsets2 = new Float64Array(count);
      for (let i2 = 0; i2 < count; i2++) offsets2[i2] = count > 1 ? a + (b - a) * i2 / (count - 1) : 0.5 * (a + b);
      const m = respond(cells, selective, offsets2);
      for (let i2 = 0; i2 < count; i2++) peak = Math.max(peak, activity(m[2][i2]));
      return { offsets: offsets2, m, spacing: count > 1 ? (b - a) / (count - 1) : resolution };
    };
    for (const region of regions) {
      let [a, b] = region;
      let part = scanRegion(a, b);
      for (let grow = 0; grow < 4; grow++) {
        const n = part.offsets.length;
        const left = activity(part.m[2][0]), right = activity(part.m[2][n - 1]);
        const widen = Math.max(b - a, 8 * resolution);
        const growLeft = left > EDGE_LEVEL * peak && a > -limit;
        const growRight = right > EDGE_LEVEL * peak && b < limit;
        if (!growLeft && !growRight) break;
        if (growLeft) a = Math.max(-limit, a - widen);
        if (growRight) b = Math.min(limit, b + widen);
        part = scanRegion(a, b);
      }
      region[0] = a;
      region[1] = b;
      parts.push(part);
    }
    regions.splice(0, regions.length, ...mergeIntervals(regions));
    parts.sort((p, q) => p.offsets[0] - q.offsets[0]);
    const offsets = [], mx = [], my = [], mz = [], spacing = [];
    for (const part of parts) {
      for (let i2 = 0; i2 < part.offsets.length; i2++) {
        if (offsets.length && part.offsets[i2] <= offsets[offsets.length - 1]) continue;
        offsets.push(part.offsets[i2]);
        mx.push(part.m[0][i2]);
        my.push(part.m[1][i2]);
        mz.push(part.m[2][i2]);
        spacing.push(part.spacing);
      }
    }
    return {
      offsets: Float64Array.from(offsets),
      mx: Float64Array.from(mx),
      my: Float64Array.from(my),
      mz: Float64Array.from(mz),
      spacing: Float64Array.from(spacing)
    };
  }
  function respond(cells, selective, offsets) {
    const n = offsets.length;
    const zeros = new Float64Array(n);
    const spins = {
      count: n,
      x: zeros,
      y: zeros,
      z: selective ? offsets : zeros,
      df: selective ? zeros : offsets,
      r1: zeros,
      r2: zeros,
      weight: new Float64Array(n).fill(1),
      b1Re: new Float64Array(n).fill(1),
      b1Im: zeros,
      coils: 1,
      rxRe: new Float64Array(n).fill(1),
      rxIm: zeros
    };
    const mx = new Float64Array(n), my = new Float64Array(n), mz = new Float64Array(n);
    for (let i2 = 0; i2 < n; i2++) [mx[i2], my[i2], mz[i2]] = stepRfVector(cells, spins, i2, 0, 0, 1);
    return [mx, my, mz];
  }
  function findBands(scan, role, resolution) {
    const n = scan.offsets.length;
    const level = new Float64Array(n);
    let peak = 0;
    for (let i2 = 0; i2 < n; i2++) {
      level[i2] = activity(scan.mz[i2]);
      peak = Math.max(peak, level[i2]);
    }
    if (!(peak > 1e-9)) return [];
    const runs = [];
    for (let i2 = 0; i2 < n; i2++) {
      if (level[i2] < SUPPORT_LEVEL * peak) continue;
      const last = runs[runs.length - 1];
      if (last && scan.offsets[i2] - scan.offsets[last[1]] <= 2 * resolution + scan.spacing[i2]) last[1] = i2;
      else runs.push([i2, i2]);
    }
    const excites = role === "excitation" || role === "other";
    const action = (i2) => excites ? Math.hypot(scan.mx[i2], scan.my[i2]) : 0.5 * (1 - scan.mz[i2]);
    return runs.map(([first, last]) => {
      let top = first, topValue = -1, sum = 0, moment = 0;
      for (let i2 = first; i2 <= last; i2++) {
        const value = action(i2);
        sum += value;
        moment += value * scan.offsets[i2];
        if (value > topValue) {
          topValue = value;
          top = i2;
        }
      }
      const half = topValue / 2;
      const crossing = (step) => {
        let i2 = top;
        while (i2 + step >= first && i2 + step <= last && action(i2 + step) >= half) i2 += step;
        const j = i2 + step;
        if (j < first || j > last) return scan.offsets[i2];
        const t = (action(i2) - half) / (action(i2) - action(j));
        return scan.offsets[i2] + t * (scan.offsets[j] - scan.offsets[i2]);
      };
      return {
        from: scan.offsets[first] - scan.spacing[first],
        to: scan.offsets[last] + scan.spacing[last],
        centre: sum > 0 ? moment / sum : scan.offsets[top],
        thickness: Math.abs(crossing(1) - crossing(-1))
      };
    });
  }
  function planSlices(pulses, options = {}) {
    const density = Math.max(0.25, options.density ?? 2);
    const maxSlices = Math.max(4, Math.floor(options.maxSlices ?? 512));
    const selective = pulses.filter((p) => p.axis === "z" && p.bands.length);
    const volume2 = options.volume && options.volume[1] > options.volume[0] ? options.volume : null;
    if (!selective.length && !volume2) return null;
    const planeStep = volume2 && options.planeThickness && options.planeThickness > 0 ? options.planeThickness : Infinity;
    const encodingStep = !options.boxes && options.encodingZ && options.encodingZ > 0 ? 1 / (4 * options.encodingZ) : Infinity;
    const excites = (p) => p.role === "excitation" || p.role === "other";
    const offResonance = Math.abs(options.offResonance ?? 0);
    const widened = selective.map((p) => {
      const margin = offResonance > 0 ? offResonance * p.duration / p.extentZ : 0;
      let peak = 0;
      for (let i2 = 0; i2 < p.mz.length; i2++) peak = Math.max(peak, activity(p.mz[i2]));
      return { pulse: p, margin, peak, bands: p.bands.map((b) => [b.from - margin, b.to + margin]) };
    });
    let ranges;
    let reference;
    let extent;
    if (volume2 && (!selective.length || pulses.some((p) => p.role === "excitation" && p.axis !== "z"))) {
      ranges = [volume2];
      reference = options.planeThickness && options.planeThickness > 0 ? options.planeThickness : volume2[1] - volume2[0];
      extent = "volume";
    } else if (pulses.some((p) => p.role === "excitation" && p.axis !== "z")) {
      const thickness = options.planeThickness ?? 0;
      if (!(thickness > 0)) return null;
      ranges = [[-thickness / 2, thickness / 2]];
      reference = thickness;
      extent = "plane";
    } else {
      ranges = mergeIntervals(widened.filter((w) => excites(w.pulse)).flatMap((w) => w.bands));
      if (!ranges.length) return null;
      const thicknesses = selective.filter(excites).flatMap((p) => p.bands.map((b) => b.thickness)).filter((t) => t > 0);
      reference = thicknesses.length ? Math.max(...thicknesses) : ranges.reduce((sum, [a, b]) => sum + (b - a), 0);
      extent = "pulses";
    }
    const cap2 = Math.min(options.boxes ? Infinity : planeStep, encodingStep);
    const finest = Math.min(cap2, ...selective.map((p) => 1 / p.extentZ));
    const fallback = Number.isFinite(finest) ? finest : options.boxes && Number.isFinite(planeStep) ? planeStep * density : (ranges[0][1] - ranges[0][0]) / 8;
    const stepAt = (z, scale2) => {
      let best = cap2;
      for (const w of widened) {
        if (!w.bands.some(([a, b]) => z >= a && z <= b)) continue;
        const level = Math.max(activityAt(w.pulse, z), activityAt(w.pulse, z - w.margin), activityAt(w.pulse, z + w.margin));
        let tier = 1;
        for (const threshold of TIERS) if (level < threshold * w.peak) tier *= 2;
        best = Math.min(best, tier / w.pulse.extentZ);
      }
      const step = (Number.isFinite(best) ? best : fallback) * scale2 / density;
      return options.boxes ? Math.min(step, planeStep * scale2) : step;
    };
    const pitch = volume2 && options.planeThickness && options.planeThickness > 0 ? options.planeThickness : 0;
    for (let scale2 = 1, attempt = 0; attempt < 40; attempt++, scale2 *= 1.25) {
      let cells = layout(ranges, (z) => stepAt(z, scale2), maxSlices + 1, pitch);
      if (pitch > 0 && cells.length <= maxSlices) cells = splitAtPlanes(cells, pitch);
      if (cells.length <= maxSlices) {
        const centres = cells.map(([a, b]) => 0.5 * (a + b)), widths = cells.map(([a, b]) => b - a);
        return {
          z: Float64Array.from(centres),
          width: Float64Array.from(widths),
          weight: Float64Array.from(widths, (w) => w / reference),
          density,
          reference,
          ranges,
          extent,
          coarsened: scale2 > 1
        };
      }
    }
    throw new Error("Could not fit the slab into the sub-slice budget.");
  }
  function splitAtPlanes(cells, pitch) {
    const out = [];
    for (const [a, b] of cells) {
      let from = a;
      for (let k = Math.ceil(a / pitch - 0.5); (k + 0.5) * pitch < b; k++) {
        const boundary = (k + 0.5) * pitch;
        if (boundary - from > 1e-9 * pitch) out.push([from, boundary]);
        from = Math.max(from, boundary);
      }
      if (b - from > 1e-9 * pitch) out.push([from, b]);
    }
    return out;
  }
  function layout(ranges, stepAt, limit, pitch = 0) {
    const cells = [];
    for (const [a, b] of ranges) {
      let middle = 0.5 * (a + b);
      if (pitch > 0) middle = Math.min(b, Math.max(a, (Math.round(middle / pitch - 0.5) + 0.5) * pitch));
      for (const direction of [1, -1]) {
        const end = direction > 0 ? b : a;
        let z = middle;
        while (direction * (end - z) > 1e-12 && cells.length < limit) {
          let step = stepAt(z);
          step = Math.min(step, stepAt(z + 0.5 * direction * step), stepAt(z + direction * step));
          const remaining = direction * (end - z);
          if (remaining < 1.5 * step) step = remaining;
          const next = z + direction * step;
          cells.push(direction > 0 ? [z, next] : [next, z]);
          z = next;
        }
      }
    }
    return cells.sort((p, q) => p[0] - q[0]);
  }
  function activityAt(pulse, z) {
    if (!pulse.regions.some(([a, b]) => z >= a && z <= b)) return 0;
    const offsets = pulse.offsets;
    let lo = 0, hi = offsets.length - 1;
    if (!(z >= offsets[lo] && z <= offsets[hi])) return 0;
    while (hi - lo > 1) {
      const mid = lo + hi >> 1;
      if (offsets[mid] <= z) lo = mid;
      else hi = mid;
    }
    const span = offsets[hi] - offsets[lo];
    const t = span > 0 ? (z - offsets[lo]) / span : 0;
    return (1 - t) * activity(pulse.mz[lo]) + t * activity(pulse.mz[hi]);
  }
  function probeSliceDensity(program, pulses, tissues, options) {
    const densities = options.densities ?? [1, 2, 4, 8, 16];
    const tolerance = options.tolerance ?? 0.02;
    const horizon = Math.min(program.totalDuration, options.horizon ?? 4);
    const countY = Math.max(1, Math.floor(options.countY ?? 1));
    const spinLimit = options.spinLimit ?? 4e5;
    const plans = /* @__PURE__ */ new Map();
    const planAt = (density) => {
      if (!plans.has(density)) plans.set(density, planSlices(pulses, { ...options, density }));
      return plans.get(density);
    };
    const first = planAt(densities[0]);
    if (!first) return null;
    const order = tissues.slice().sort((a, b) => lifetime2(b) - lifetime2(a));
    const signals = /* @__PURE__ */ new Map();
    const signalOf = (plan, t) => {
      const key = `${plan.density}|${t}`;
      let signal = signals.get(key);
      if (!signal) {
        signal = simulateReference(program, probeColumn(plan, order[t], options.voxel, countY), { until: horizon }).signal;
        signals.set(key, signal);
      }
      return signal;
    };
    const tested = [];
    let chosen = first;
    for (const density of densities) {
      const plan = planAt(density), finer = planAt(2 * density);
      const spins = (p) => Math.max(...order.map((t) => t.countX)) * countY * p.z.length;
      if (finer.coarsened || spins(finer) > spinLimit) {
        return { plan: chosen, error: tested.length ? tested[tested.length - 1].error : NaN, capped: true, tested };
      }
      let error = 0;
      for (let t = 0; t < order.length && error <= tolerance; t++) {
        const reference = signalOf(finer, t);
        const scale2 = norm2(reference);
        if (!(scale2 > 0)) continue;
        error = Math.max(error, distance2(signalOf(plan, t), reference) / scale2);
      }
      tested.push({ density, slices: plan.z.length, error });
      if (error <= tolerance) return { plan, error, capped: false, tested };
      chosen = finer;
    }
    return { plan: chosen, error: tested[tested.length - 1].error, capped: true, tested };
  }
  function probeColumn(plan, tissue, voxel, countY) {
    const countX = Math.max(1, tissue.countX);
    const perSlice = countX * countY;
    const count = perSlice * plan.z.length;
    const x2 = new Float64Array(count), y = new Float64Array(count), z = new Float64Array(count);
    const weight = new Float64Array(count);
    let i2 = 0;
    for (let k = 0; k < plan.z.length; k++) {
      for (let ay = 0; ay < countY; ay++) {
        for (let ax = 0; ax < countX; ax++) {
          x2[i2] = ((ax + 0.5) / countX - 0.5) * voxel[0];
          y[i2] = countY > 1 ? ((ay + 0.5) / countY - 0.5) * voxel[1] : 0;
          z[i2] = plan.z[k];
          weight[i2] = plan.weight[k] / perSlice;
          i2++;
        }
      }
    }
    const rate2 = (time) => Number.isFinite(time) && time > 0 ? 1 / time : 0;
    return {
      count,
      x: x2,
      y,
      z,
      df: new Float64Array(count),
      r1: new Float64Array(count).fill(rate2(tissue.t1)),
      r2: new Float64Array(count).fill(rate2(tissue.t2)),
      weight,
      b1Re: new Float64Array(count).fill(1),
      b1Im: new Float64Array(count),
      coils: 1,
      rxRe: new Float64Array(count).fill(1),
      rxIm: new Float64Array(count)
    };
  }
  function lifetime2(tissue) {
    const t2 = Number.isFinite(tissue.t2) ? tissue.t2 : 1e9;
    const t1 = Number.isFinite(tissue.t1) ? tissue.t1 : 1e9;
    return t2 + 1e-6 * t1;
  }
  function norm2(signal) {
    let sum = 0;
    for (let i2 = 0; i2 < signal.length; i2++) sum += signal[i2] * signal[i2];
    return Math.sqrt(sum);
  }
  function distance2(a, b) {
    let sum = 0;
    for (let i2 = 0; i2 < a.length; i2++) sum += (a[i2] - b[i2]) ** 2;
    return Math.sqrt(sum);
  }
  function mergeIntervals(intervals) {
    const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [a, b] of sorted) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    return merged;
  }

  // src/sim/recon/cartesian.ts
  function reconstructCartesian(trajectory, signal, coils, options = {}) {
    const maxSize = options.maxSize ?? 512;
    const maxFrames = options.maxFrames ?? 64;
    const warnings = [];
    const k = trajectory.k;
    const totalSamples = k.length / 3;
    const extent = [0, 0, 0], within = [0, 0, 0];
    for (let s = 0; s < totalSamples; s++) {
      for (let a = 0; a < 3; a++) extent[a] = Math.max(extent[a], Math.abs(k[3 * s + a]));
    }
    for (let r = 0; r < trajectory.readouts; r++) {
      const first = trajectory.offsets[r], last = first + trajectory.samples[r] - 1;
      for (let a = 0; a < 3; a++) {
        let lo = Infinity, hi = -Infinity;
        for (let s = first; s <= last; s++) {
          lo = Math.min(lo, k[3 * s + a]);
          hi = Math.max(hi, k[3 * s + a]);
        }
        if (hi > lo) within[a] = Math.max(within[a], hi - lo);
      }
    }
    const ranked = [0, 1, 2].sort((a, b) => extent[b] - extent[a]);
    const encoded = (axis) => extent[axis] >= Math.max(1, 0.01 * extent[ranked[1]]);
    let third = ranked[2];
    if (encoded(ranked[2])) {
      const still = [0, 1, 2].filter((axis) => within[axis] <= 0.01 * Math.max(...within));
      const narrower = (a, b) => Math.abs(extent[a] - extent[b]) <= 0.01 * Math.max(extent[a], extent[b]) ? b - a : extent[a] - extent[b];
      if (still.length) third = still.sort(narrower)[0];
    }
    const axes = [0, 1, 2].filter((axis) => axis !== third);
    const delta = axes.map((axis) => {
      const fov = options.fov?.[axis];
      if (fov && fov > 0) return 1 / fov;
      return estimateStep(trajectory, axis, 2 * extent[axis]);
    });
    const offset = axes.map((axis, i2) => gridOffset(k, axis, delta[i2]));
    const size = axes.map((axis, i2) => {
      const n = 2 * Math.round(extent[axis] / delta[i2] + (offset[i2] ? 0.5 : 0));
      return Math.max(2, Math.min(maxSize, n));
    });
    const [nu, nv] = size;
    let wAxis = -1, nw = 1, deltaW = 0, offsetW = 0;
    if (encoded(third)) {
      const fov = options.fov?.[third];
      const step = fov && fov > 0 ? 1 / fov : estimateStep(trajectory, third, 2 * extent[third]);
      const lattice = gridOffset(k, third, step);
      const planes = /* @__PURE__ */ new Set();
      for (let r = 0; r < trajectory.readouts; r++) {
        const centre = trajectory.offsets[r] + (trajectory.samples[r] >> 1);
        planes.add(Math.round(k[3 * centre + third] / step - lattice));
      }
      if (planes.size >= 2) {
        wAxis = third;
        deltaW = step;
        offsetW = lattice;
        nw = Math.max(2, Math.min(options.maxPlanes ?? 256, 2 * Math.round(extent[third] / step + (lattice ? 0.5 : 0))));
      }
    }
    const planeOf = (index) => wAxis < 0 ? 0 : Math.round(k[3 * index + wAxis] / deltaW - offsetW) + (nw >> 1);
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
      const row = Math.round(k[3 * centre + axes[1]] / delta[1] - offset[1]) * (nw + 1) + planeOf(centre);
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
    const plane = nu * nv;
    const cells = plane * nw;
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
        const iw = planeOf(index);
        if (iu < 0 || iu >= nu || iv < 0 || iv >= nv || iw < 0 || iw >= nw) continue;
        const cell = (iw * nv + iv) * nu + iu;
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
    const complexSize = options.complex ? frames * coils * cells : 0;
    const coilImages = options.complex ? { re: new Float32Array(complexSize), im: new Float32Array(complexSize) } : void 0;
    const coilKspace = options.complex ? { re: new Float32Array(complexSize), im: new Float32Array(complexSize) } : void 0;
    const twiddleU = centredTwiddles(nu, offset[0]);
    const twiddleV = centredTwiddles(nv, offset[1]);
    const twiddleW = nw > 1 ? centredTwiddles(nw, offsetW) : null;
    const workRe = new Float64Array(cells), workIm = new Float64Array(cells);
    const lineRe = new Float64Array(nw), lineIm = new Float64Array(nw);
    for (let frame = 0; frame < frames; frame++) {
      const image = images.subarray(frame * cells, (frame + 1) * cells);
      const ks = kspace.subarray(frame * cells, (frame + 1) * cells);
      for (let c = 0; c < coils; c++) {
        const base = (frame * coils + c) * cells;
        for (let i2 = 0; i2 < cells; i2++) {
          workRe[i2] = gridRe[base + i2];
          workIm[i2] = gridIm[base + i2];
          ks[i2] += workRe[i2] * workRe[i2] + workIm[i2] * workIm[i2];
        }
        for (let iw = 0; iw < nw; iw++) {
          const at = iw * plane;
          if (coilKspace) copyTopDown(workRe.subarray(at, at + plane), workIm.subarray(at, at + plane), nu, nv, coilKspace, base + at);
          inverseDft2(workRe.subarray(at, at + plane), workIm.subarray(at, at + plane), nu, nv, twiddleU, twiddleV);
        }
        if (twiddleW) {
          for (let i2 = 0; i2 < plane; i2++) transformLine(workRe, workIm, i2, plane, nw, twiddleW, lineRe, lineIm);
        }
        for (let iw = 0; iw < nw; iw++) {
          for (let iv = 0; iv < nv; iv++) {
            const row = nv - 1 - iv;
            for (let iu = 0; iu < nu; iu++) {
              const i2 = (iw * nv + iv) * nu + iu;
              image[iw * plane + row * nu + iu] += workRe[i2] * workRe[i2] + workIm[i2] * workIm[i2];
            }
          }
          if (coilImages) copyTopDown(workRe.subarray(iw * plane, (iw + 1) * plane), workIm.subarray(iw * plane, (iw + 1) * plane), nu, nv, coilImages, base + iw * plane);
        }
      }
      for (let i2 = 0; i2 < cells; i2++) {
        image[i2] = Math.sqrt(image[i2]);
        ks[i2] = Math.sqrt(ks[i2]);
      }
      for (let iw = 0; iw < nw; iw++) flipRows(ks.subarray(iw * plane, (iw + 1) * plane), nu, nv);
    }
    let filledCount = 0;
    for (let i2 = 0; i2 < filled.length; i2++) filledCount += filled[i2];
    return {
      axes,
      nu,
      nv,
      delta,
      offset,
      wAxis,
      nw,
      deltaW,
      offsetW,
      frames,
      images,
      kspace,
      frameGroup: Int32Array.from(frameGroup.slice(0, frames)),
      frameRepeat: Int32Array.from(frameRepeat.slice(0, frames)),
      fill: frames > 0 ? filledCount / (frames * cells) : 0,
      offGridFraction,
      warnings,
      coilImages,
      coilKspace
    };
  }
  function copyTopDown(re, im, nu, nv, out, base) {
    for (let iv = 0; iv < nv; iv++) {
      const row = nv - 1 - iv;
      for (let iu = 0; iu < nu; iu++) {
        out.re[base + row * nu + iu] = re[iv * nu + iu];
        out.im[base + row * nu + iu] = im[iv * nu + iu];
      }
    }
  }
  function estimateStep(trajectory, axis, span) {
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
    for (let i2 = 1; i2 < values.length; i2++) {
      const d = values[i2] - values[i2 - 1];
      if (d > span * 1e-4 && d < step) step = d;
    }
    return Number.isFinite(step) && step > 0 ? step : 1;
  }
  function gridOffset(k, axis, delta) {
    let integer2 = 0, half = 0;
    for (let s = axis; s < k.length; s += 3) {
      const f = k[s] / delta;
      const fraction = Math.abs(f - Math.round(f));
      if (fraction < 0.1) integer2++;
      else if (Math.abs(fraction - 0.5) < 0.1) half++;
    }
    return half > integer2 ? 0.5 : 0;
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
    const t0 = [];
    const dwell = [];
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
          currentKey = String(segment.operator.freqOffset);
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
        t0.push(segment.t0);
        dwell.push(segment.dwell);
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
      excitationKey,
      t0: Float64Array.from(t0),
      dwell: Float64Array.from(dwell)
    };
  }

  // src/sim/job.ts
  var MAX_JOB_SPINS = 64e6;
  var MAX_JOB_SIMULATED = 128e6;
  var SLICE_WORK_BUDGET = 4e9;
  var MAX_JOB_COILS = 32;
  var MIN_CHUNK_SPINS = 16384;
  var MAX_CHUNK_SPINS = 262144;
  var MAX_CHUNKS = 64;
  var MAX_SLICES = 512;
  var SLICE_PROBE_TISSUES = 2;
  var PG_CLASS_BUDGET = 2048;
  var PG_LANES_PER_CHUNK = 512;
  var PG_MAX_CHUNKS = 64;
  var PG_SOURCES_PER_CHUNK = 2048;
  var REPLAY_BLOCK_LIMIT = 2e5;
  var PROBE_TISSUES = 4;
  var T2_BAND_EDGES = [0.03, 0.06, 0.12, 0.25, 0.5, 1, Infinity];
  var SimulationJob = class {
    constructor(bytes, name, settings, hooks = {}) {
      __publicField(this, "program");
      __publicField(this, "analysis");
      __publicField(this, "phantom");
      __publicField(this, "plan");
      /** Folded axes (bit 0 = x, bit 1 = y). */
      __publicField(this, "fold");
      __publicField(this, "physics");
      __publicField(this, "chunkVoxels");
      /** Spins along x per voxel when banded (indexed like the maps), else null. */
      __publicField(this, "countX");
      /** Sub-slices along z, or null for one plane at z = 0. */
      __publicField(this, "slices");
      /** The pulses as measured for this plan (empty when the sub-slices came resolved). */
      __publicField(this, "pulses");
      /** The phase-graph model and its chunks, or null for the isochromat engine. */
      __publicField(this, "pg");
      __publicField(this, "sequenceFov");
      __publicField(this, "trajectory", null);
      __publicField(this, "hooks");
      this.hooks = hooks;
      this.report("Parsing the sequence", 0);
      const seq = parseSequenceBytes(bytes, name);
      this.program = replayable(compileProgram(seq));
      this.report("Analysing gradients and pulses", 0.05);
      this.analysis = analyzeDephasing(this.program);
      if (this.analysis.adcEvents === 0) throw new Error("The sequence has no ADC events, so there is no signal to simulate.");
      const definition = seq.definitions.get("FOV");
      this.sequenceFov = definition && definition.length >= 2 && definition.every((v) => Number.isFinite(+v)) ? [+definition[0], +definition[1], definition.length > 2 ? +definition[2] : 0] : null;
      this.report("Preparing the phantom", 0.15);
      this.phantom = this.resolvePhantom(settings);
      const { nx, ny, voxel } = this.phantom;
      const fov = [nx * voxel[0], ny * voxel[1]];
      this.physics = physicsTable(this.phantom);
      this.fold = foldableAxes(this.analysis, [fov[0], fov[1], 0]) & 3;
      const voxels = occupiedVoxels(this.phantom);
      if (!voxels.length) throw new Error("The phantom plane is empty (no voxel has PD > 0).");
      if ((settings.engine ?? "isochromat") === "phase-graph") {
        const planned = this.planPhaseGraph(settings, voxels.length, fov);
        this.countX = null;
        this.slices = planned.slices;
        this.pulses = planned.pulses;
        this.chunkVoxels = [];
        this.pg = planned.pg;
        this.plan = planned.plan;
        return;
      }
      this.pg = null;
      const banded = this.planBands(voxels, voxel[0], settings);
      const axes = [0, 1].map((axis) => axis === 0 && banded ? banded.axis : this.planAxis(axis, voxel[axis], settings));
      const subSpins = [axes[0].count, axes[1].count];
      this.countX = banded ? banded.countX : null;
      if (banded) banded.resolved.y = subSpins[1];
      const units = this.chunkUnits(voxels);
      const through = this.planThroughSlice(settings, subSpins, banded?.resolved ?? null, this.countClasses(units, subSpins));
      this.slices = through.slices;
      this.pulses = through.pulses;
      const { slicesAt, planesAt } = this.presence(voxels);
      const along = (v) => (this.countX ? this.countX[v] : subSpins[0]) * subSpins[1];
      const spinsOf = (v) => along(v) * slicesAt[v];
      let spins = 0, stored = 0;
      for (const v of voxels) {
        spins += spinsOf(v);
        stored += along(v) * (this.fold ? planesAt[v] : slicesAt[v]);
      }
      if (stored > MAX_JOB_SPINS) {
        throw new Error(`${stored.toLocaleString("en-US")} spins exceed the ${MAX_JOB_SPINS.toLocaleString("en-US")} limit; use a smaller phantom matrix, fewer spins per voxel or fewer sub-slices.`);
      }
      this.report("Splitting the spins into chunks", 0.97);
      const simulated = this.countClasses(units, subSpins);
      if (simulated > MAX_JOB_SIMULATED) {
        throw new Error(`${simulated.toLocaleString("en-US")} simulated spins exceed the ${MAX_JOB_SIMULATED.toLocaleString("en-US")} limit; use a smaller phantom matrix, fewer spins per voxel or fewer sub-slices.`);
      }
      const target = Math.max(MIN_CHUNK_SPINS, Math.min(MAX_CHUNK_SPINS, Math.ceil(spins / MAX_CHUNKS)));
      this.chunkVoxels = splitUnits(units, spinsOf, target);
      const notes = through.notes.slice();
      for (const band of banded?.bands ?? []) {
        if (band.capped) {
          notes.push(`x, T2 ${(band.t2Min * 1e3).toFixed(0)}\u2013${Number.isFinite(band.t2Max) ? (band.t2Max * 1e3).toFixed(0) : "\u221E"} ms: ${band.count} spins per voxel did not reach the ${tolerancePercent(settings)} target (error ${(100 * band.error).toFixed(0)} %).`);
        }
      }
      for (const [axis, plan] of axes.entries()) {
        if (plan.probe?.capped) {
          notes.push(`${"xy"[axis]}: ${plan.count} spins per voxel did not reach the ${tolerancePercent(settings)} target (error ${(100 * plan.probe.error).toFixed(0)} %); expect residual stripes from incomplete spoiling.`);
        }
      }
      const hasT2prime = this.physics.t2p.some(Number.isFinite), hasDiffusion = this.physics.adc.some((d) => d > 0);
      if (hasT2prime || hasDiffusion) {
        notes.push(`${hasT2prime && hasDiffusion ? "T2\u2032 and diffusion follow" : hasT2prime ? "T2\u2032 follows" : "Diffusion follows"} the main echo pathway (from each excitation, reversed by each refocusing pulse): exact for gradient and spin echoes, CPMG trains and diffusion-weighted EPI; approximate where other pathways carry signal (balanced SSFP, stimulated echoes, spoiled steady states). The phase-graph engine is exact for every pathway.`);
      }
      for (const note of this.phantom.notes) notes.push(note);
      for (const feature of this.program.ignoredFeatures) notes.push(`Not simulated: ${IGNORED_FEATURE_TEXT[feature]}.`);
      this.plan = {
        engine: "isochromat",
        phaseGraph: null,
        blocks: this.program.blockCount,
        duration: this.program.totalDuration,
        rfEvents: this.analysis.rfEvents,
        adcEvents: this.analysis.adcEvents,
        adcSamples: this.analysis.adcSamples,
        phantom: {
          source: this.phantom.source,
          nx,
          ny,
          fov,
          voxels: voxels.length,
          tissues: this.physics.t1.length,
          maps: Object.keys(this.phantom.maps).filter((key) => this.phantom.maps[key])
        },
        axes,
        subSpins,
        bands: banded ? banded.bands : null,
        resolved: banded ? banded.resolved : subSpins,
        slices: through.summary,
        resolvedSlices: through.resolved,
        spins,
        simulated,
        chunks: this.chunkVoxels.length,
        coils: this.phantom.coils?.count ?? 1,
        b0: this.program.b0,
        gamma: this.program.gamma,
        notes
      };
    }
    report(message, fraction) {
      this.hooks.onPlanProgress?.(message, fraction);
    }
    /** Simulate one chunk; returns its delivered signal (see SimulationResult.signal). */
    simulateChunk(index, options = {}) {
      if (this.pg) return this.simulatePhaseGraphChunk(index, options);
      const voxels = this.chunkVoxels[index];
      if (!voxels) throw new Error(`No chunk ${index} (the job has ${this.chunkVoxels.length}).`);
      const spinOptions = { subSpins: this.plan.subSpins, voxels, countX: this.countX ?? void 0, slices: this.slices ?? void 0 };
      if (!this.fold) return simulateReference(this.program, phantomSpins(this.phantom, spinOptions), options).signal;
      const { classes, members } = foldedPhantomSpins(this.phantom, this.physics, spinOptions, this.fold);
      return simulateReference(this.program, classes, { ...options, members }).signal;
    }
    simulatePhaseGraphChunk(index, options) {
      const pg = this.pg;
      const classes = pg.chunkClasses[index], members = pg.chunkSources[index];
      if (!classes) throw new Error(`No chunk ${index} (the job has ${pg.chunkClasses.length}).`);
      const all = pg.phantom.sources;
      const local = new Int32Array(pg.phantom.classes.length).fill(-1);
      classes.forEach((c, i2) => {
        local[c] = i2;
      });
      const n = members.length, coils = all.coils;
      const pick = (array) => Float64Array.from(members, (i2) => array[i2]);
      const rxRe = new Float64Array(coils * n), rxIm = new Float64Array(coils * n);
      for (let c = 0; c < coils; c++) {
        for (let j = 0; j < n; j++) {
          rxRe[c * n + j] = all.rxRe[c * all.count + members[j]];
          rxIm[c * n + j] = all.rxIm[c * all.count + members[j]];
        }
      }
      const sources = {
        count: n,
        x: pick(all.x),
        y: pick(all.y),
        df: pick(all.df),
        pd: pick(all.pd),
        classOf: Int32Array.from(members, (i2) => local[all.classOf[i2]]),
        sliceFrom: Int32Array.from(members, (i2) => all.sliceFrom[i2]),
        sliceTo: Int32Array.from(members, (i2) => all.sliceTo[i2]),
        coils,
        rxRe,
        rxIm
      };
      const model = {
        classes: Array.from(classes, (c) => pg.phantom.classes[c]),
        slices: pg.slices,
        sources,
        voxel: [this.phantom.voxel[0], this.phantom.voxel[1]]
      };
      return simulatePhaseGraph(this.program, model, {
        prune: pg.prune,
        maxStates: pg.maxStates,
        onProgress: options.onProgress,
        progressInterval: options.progressInterval,
        isCancelled: options.isCancelled,
        until: options.until
      }).signal;
    }
    /**
     * The phase-graph plan: sub-slices at a density set by the accuracy
     * target (configuration states need no spins per voxel, and their slab
     * integral converges within a few sub-slices per resolution cell), tissue
     * classes and their sources, and chunks of whole classes.
     */
    planPhaseGraph(settings, voxelCount, fov) {
      if (this.analysis.rfGradientAxes & 3) {
        throw new Error("The phase-graph engine cannot simulate this sequence: its RF pulses play gradients along x or y (in-plane selective or oblique excitation). Use the isochromat engine.");
      }
      const tolerance = settings.tolerance ?? 0.02;
      const preset = phaseGraphPreset(tolerance);
      const tuning = { ...preset, ...settings.phaseGraphTuning };
      const through = this.planThroughSlice(settings, [1, 1], null, 0, tuning.density, true);
      this.report("Grouping the phantom into tissue classes", 0.95);
      const phantom = phaseGraphPhantom(this.phantom, through.slices, tuning.rfStep, tuning.fine, PG_CLASS_BUDGET);
      const K = through.slices ? through.slices.z.length : 1;
      const C = phantom.classes.length;
      if (!phantom.sources.count) throw new Error("The phantom plane is empty (no voxel has PD > 0).");
      const slices = through.slices && through.resolved !== "off" ? { z: through.slices.z, weight: through.slices.weight, reference: through.resolved.reference } : { z: Float64Array.of(0), weight: Float64Array.of(1), reference: 1 };
      const perChunk = Math.max(1, Math.min(Math.floor(PG_LANES_PER_CHUNK / K) || 1, Math.ceil(C / PG_MAX_CHUNKS)));
      const chunkClasses = [];
      for (let c = 0; c < C; c += perChunk) chunkClasses.push(Int32Array.from({ length: Math.min(perChunk, C - c) }, (_, i2) => c + i2));
      const chunkOf = new Int32Array(C);
      chunkClasses.forEach((list, i2) => list.forEach((c) => {
        chunkOf[c] = i2;
      }));
      const lists = chunkClasses.map(() => []);
      for (let i2 = 0; i2 < phantom.sources.count; i2++) lists[chunkOf[phantom.sources.classOf[i2]]].push(i2);
      const finalClasses = [], chunkSources = [];
      lists.forEach((list, i2) => {
        const pieces = Math.max(1, Math.ceil(list.length / PG_SOURCES_PER_CHUNK));
        const size = Math.ceil(list.length / pieces);
        for (let p = 0; p < pieces; p++) {
          finalClasses.push(chunkClasses[i2]);
          chunkSources.push(Int32Array.from(list.slice(p * size, (p + 1) * size)));
        }
      });
      chunkClasses.length = 0;
      chunkClasses.push(...finalClasses);
      const notes = through.notes.slice();
      notes.push(`Phase graph: ${C} tissue classes \xD7 ${K} sub-slices; states below ${tuning.prune} are dropped (at most ${tuning.maxStates} of each kind). Voxels are uniform boxes; each voxel's own B0 enters exactly through the states' dephasing time.`);
      if (phantom.binning.t > 0 || phantom.binning.b1 > 0) {
        notes.push(`Continuous maps were binned into ${C} classes: T1 and T2 to ${+(100 * phantom.binning.t).toFixed(2)} %, B1+ to ${+(100 * phantom.binning.b1).toFixed(2)} %.`);
      }
      if (phantom.sources.df.some((v) => v !== 0)) {
        notes.push(`Pulses act at off-resonance rounded to ${phantom.binning.df} Hz; free precession uses each voxel's exact B0.`);
      }
      if (phantom.classes.some((c) => c.t2prime !== void 0 && Number.isFinite(c.t2prime))) notes.push("T2\u2032 is exact: each configuration decays by e^{\u2212|\u03C4|/T2\u2032} (a Lorentzian line).");
      if (phantom.classes.some((c) => (c.adc ?? 0) > 0)) {
        notes.push("Diffusion is exact: each configuration decays by e^{\u2212bD}, b from its own gradient history (isotropic D).");
      }
      for (const note of this.phantom.notes) notes.push(note);
      for (const feature of this.program.ignoredFeatures) notes.push(`Not simulated: ${IGNORED_FEATURE_TEXT[feature]}.`);
      const none = { count: 1, reason: "none", folded: false };
      const plan = {
        engine: "phase-graph",
        phaseGraph: {
          classes: C,
          lanes: C * K,
          sources: phantom.sources.count,
          prune: tuning.prune,
          maxStates: tuning.maxStates,
          binning: phantom.binning
        },
        blocks: this.program.blockCount,
        duration: this.program.totalDuration,
        rfEvents: this.analysis.rfEvents,
        adcEvents: this.analysis.adcEvents,
        adcSamples: this.analysis.adcSamples,
        phantom: {
          source: this.phantom.source,
          nx: this.phantom.nx,
          ny: this.phantom.ny,
          fov,
          voxels: voxelCount,
          tissues: C,
          maps: Object.keys(this.phantom.maps).filter((key) => this.phantom.maps[key])
        },
        axes: [none, { ...none }],
        subSpins: [1, 1],
        bands: null,
        resolved: [1, 1],
        slices: through.summary,
        resolvedSlices: through.resolved,
        spins: phantom.sources.count * K,
        simulated: C * K,
        chunks: chunkClasses.length,
        coils: this.phantom.coils?.count ?? 1,
        b0: this.program.b0,
        gamma: this.program.gamma,
        notes
      };
      return {
        plan,
        slices: through.slices,
        pulses: through.pulses,
        pg: { phantom, slices, chunkClasses, chunkSources, prune: tuning.prune, maxStates: tuning.maxStates }
      };
    }
    reconstruct(signal) {
      return reconstructCartesian(this.adcTrajectory(), signal, this.plan.coils, { fov: this.sequenceFov, complex: true });
    }
    rawLayout() {
      const trajectory = this.adcTrajectory();
      const labels = evaluateAdcLabels(this.program.sequence);
      if (labels.count !== trajectory.readouts) {
        throw new Error(`Internal error: ${labels.count} labelled ADCs but ${trajectory.readouts} readouts.`);
      }
      return {
        acquisitions: trajectory.readouts,
        coils: this.plan.coils,
        samples: trajectory.samples,
        offsets: trajectory.offsets,
        t0: trajectory.t0,
        dwell: trajectory.dwell,
        k: Float32Array.from(trajectory.k),
        excitation: trajectory.excitation,
        labels: { names: labels.names, kinds: labels.kinds, values: labels.values }
      };
    }
    /** The FOV definition of the sequence, if it has one [m]. */
    get fieldOfView() {
      return this.sequenceFov;
    }
    adcTrajectory() {
      this.trajectory ?? (this.trajectory = adcTrajectory(this.program));
      return this.trajectory;
    }
    resolvePhantom(settings) {
      const source = settings.phantom;
      let phantom;
      if (source.kind === "shepp-logan") {
        const size = Math.round(source.size);
        if (!(size >= 2 && size <= 1024)) throw new Error(`Phantom size must be between 2 and 1024, got ${source.size}.`);
        const fov = source.fov ?? (this.sequenceFov && this.sequenceFov[0] > 0 && this.sequenceFov[1] > 0 ? [this.sequenceFov[0], this.sequenceFov[1]] : [0.256, 0.256]);
        phantom = sheppLoganPhantom2D(size, fov[0], fov[1]);
      } else {
        phantom = source.phantom;
        const cells = phantom.nx * phantom.ny;
        if (!(phantom.nx >= 1 && phantom.ny >= 1) || phantom.maps.pd.length !== cells) {
          throw new Error("The phantom maps do not match its matrix size.");
        }
      }
      const coils = Math.round(settings.coils ?? 1);
      if (!(coils >= 1 && coils <= MAX_JOB_COILS)) throw new Error(`Coils must be between 1 and ${MAX_JOB_COILS}, got ${settings.coils}.`);
      for (const plane of phantom.planes ?? []) {
        if (plane.maps.pd.length !== phantom.nx * phantom.ny) throw new Error("A phantom plane does not match the phantom matrix size.");
      }
      if (!phantom.coils && coils > 1) phantom = { ...phantom, coils: syntheticCoils(phantom.nx, phantom.ny, phantom.voxel, coils) };
      return phantom;
    }
    /**
     * Sub-slices along z (plan/slices.ts): resolved by another worker, or
     * measured from the pulses with a density probed on one voxel of the
     * longest-lived tissues, at the in-plane spins this plan chose.
     */
    planThroughSlice(settings, subSpins, bands, flatClasses, fixedDensity, boxes = false) {
      const mode = settings.throughSlice ?? "auto";
      const flat = "one plane at z = 0, so slice profiles and through-slice dephasing are not simulated";
      if (mode === "off") {
        return { slices: null, summary: null, resolved: "off", pulses: [], notes: [`Through-slice sampling is off: ${flat}.`] };
      }
      let plan;
      let probe = null;
      let pulses = [];
      let budgetNote = "";
      if (mode !== "auto") {
        plan = mode;
      } else {
        this.report("Measuring the RF pulses along z", 0.9);
        pulses = measurePulses(this.program);
        const options = {
          offResonance: this.largestOffResonance(),
          planeThickness: this.phantom.voxel[2],
          maxSlices: MAX_SLICES,
          volume: volumeExtent(this.phantom) ?? void 0,
          encodingZ: encodingExtent(this.adcTrajectory(), 2),
          boxes
        };
        const selective = pulses.some((p) => p.axis === "z" && p.bands.length);
        if (!planSlices(pulses, { ...options, density: 1 })) {
          const why = selective ? "An excitation is not selective along z and the phantom plane has no thickness" : "No pulse is selective along z";
          return { slices: null, summary: null, resolved: "off", pulses, notes: [`${why}: ${flat}.`] };
        }
        this.report("Probing the sub-slice spacing", 0.93);
        const tissues = representativeTissues(this.physics).slice(0, SLICE_PROBE_TISSUES).map((tissue) => ({
          ...tissue,
          countX: this.fold & 1 ? 1 : bands ? bandCount(bands, tissue.t2) : subSpins[0]
        }));
        const fixed = fixedDensity !== void 0 ? planSlices(pulses, { ...options, density: fixedDensity }) : null;
        const result = fixed ? { plan: fixed, error: NaN, capped: false, tested: [] } : probeSliceDensity(this.program, pulses, tissues, {
          ...options,
          voxel: [this.phantom.voxel[0], this.phantom.voxel[1]],
          countY: this.fold & 2 ? 1 : subSpins[1],
          tolerance: settings.tolerance
        });
        probe = fixed ? null : { error: result.error, capped: result.capped, tested: result.tested };
        let chosen = result.plan;
        const work = (slices2) => flatClasses * slices2 * Math.max(1, this.analysis.rfEvents);
        if (work(chosen.z.length) > SLICE_WORK_BUDGET) {
          const fitting = result.tested.filter((t) => work(t.slices) <= SLICE_WORK_BUDGET);
          const pick = fitting.length ? fitting[fitting.length - 1] : result.tested[0];
          if (pick && pick.density < chosen.density) {
            chosen = planSlices(pulses, { ...options, density: pick.density });
            budgetNote = `Through-slice: ${chosen.z.length} sub-slices instead of ${result.plan.z.length} to keep the run affordable (about ${(100 * pick.error).toFixed(0)} % signal error from the z sampling; choose Fast or Draft accuracy to make that the default).`;
          }
        }
        plan = {
          kind: "slices",
          z: Array.from(chosen.z),
          weight: Array.from(chosen.weight),
          density: chosen.density,
          reference: chosen.reference,
          ranges: chosen.ranges,
          extent: chosen.extent,
          coarsened: chosen.coarsened
        };
      }
      const z = Float64Array.from(plan.z);
      const slices = { z, weight: Float64Array.from(plan.weight), plane: assignPlanes(this.phantom, z) };
      const planes = new Set(Array.from(slices.plane)).size;
      const summary = {
        count: z.length,
        ranges: plan.ranges,
        density: plan.density,
        reference: plan.reference,
        extent: plan.extent,
        coarsened: plan.coarsened,
        planes,
        probe
      };
      const mm = (value) => +(value * 1e3).toFixed(2);
      const notes = [];
      const span = plan.ranges.map(([a, b]) => `${mm(a)}\u2026${mm(b)}`).join(", ");
      notes.push(plan.extent === "plane" ? `An excitation is not selective along z: ${z.length} sub-slices span only the phantom plane's ${mm(this.phantom.voxel[2])} mm.` : plan.extent === "volume" ? `The excitation reaches the whole phantom along z: ${z.length} sub-slices over z = ${span} mm.` : `Through-slice: ${z.length} sub-slices over z = ${span} mm (slice ${mm(plan.reference)} mm FWHM).`);
      notes.push(this.phantom.planes?.length ? `${planes} phantom planes along z, ${mm(this.phantom.voxel[2])} mm apart.` : "The 2-D phantom is extruded along z: every sub-slice sees the same plane.");
      if (plan.coarsened) notes.push(`The sub-slice spacing was widened to stay within ${MAX_SLICES} sub-slices.`);
      if (budgetNote) notes.push(budgetNote);
      if (probe?.capped) {
        notes.push(`Through-slice: the z sampling had not converged to the ${tolerancePercent(settings)} target at the finest spacing tried (${Number.isFinite(probe.error) ? (100 * probe.error).toFixed(0) : "?"} % between the two finest). Gradients along z such as crushers around refocusing pulses or diffusion lobes dephase faster than the sub-slices resolve, so some signal from pathways they should remove remains.`);
      }
      return { slices, summary, resolved: plan, pulses, notes };
    }
    /** Largest |B0 offset| among the phantom's occupied voxels [Hz]. */
    largestOffResonance() {
      let largest = 0;
      for (const maps of [this.phantom.maps, ...(this.phantom.planes ?? []).map((plane) => plane.maps)]) {
        if (!maps.b0) continue;
        for (let i2 = 0; i2 < maps.b0.length; i2++) if (maps.pd[i2] > 0) largest = Math.max(largest, Math.abs(maps.b0[i2]));
      }
      return largest;
    }
    /** Sub-slices and distinct planes with PD > 0 at each voxel. */
    presence(voxels) {
      const cells = this.phantom.nx * this.phantom.ny;
      const slicesAt = new Int32Array(cells), planesAt = new Int32Array(cells);
      const planeOf = this.slices ? Array.from(this.slices.plane) : [-1];
      const used = [...new Set(planeOf)];
      for (const v of voxels) {
        for (const plane of planeOf) if (planeMaps(this.phantom, plane).pd[v] > 0) slicesAt[v]++;
        for (const plane of used) if (planeMaps(this.phantom, plane).pd[v] > 0) planesAt[v]++;
      }
      return { slicesAt, planesAt };
    }
    planAxis(axis, voxel, settings) {
      const folded = (this.fold & 1 << axis) !== 0;
      if (Array.isArray(settings.subSpins)) {
        return { count: clampCount(settings.subSpins[axis]), reason: "manual", folded };
      }
      if (settings.subSpins !== "auto") {
        return { count: clampCount(settings.subSpins.y), reason: "manual", folded };
      }
      const resolution = resolutionCount(this.analysis, axis, voxel);
      if (folded || intervalCycles(this.analysis, axis, voxel) <= 0.05) {
        return { count: resolution, reason: resolution > 1 ? "resolution" : "none", folded };
      }
      this.report(`Probing spins per voxel along ${"xy"[axis]}`, 0.2 + 0.4 * axis);
      const probe = probeSubSpins(this.program, axis, voxel, representativeTissues(this.physics), {
        minimum: resolution,
        maximum: settings.maxSubSpins,
        tolerance: settings.tolerance,
        intervalCycles: intervalCycles(this.analysis, axis, voxel)
      });
      return {
        count: probe.count,
        reason: probe.count > resolution ? "spoiling" : resolution > 1 ? "resolution" : "none",
        folded,
        probe: { error: probe.error, reference: probe.reference, capped: probe.capped, tested: probe.tested }
      };
    }
    /**
     * Spins per voxel along a spoiled x axis, per T2 band. Long-T2 tissue keeps
     * transverse pathways for many TRs and needs hundreds of spins; white and
     * grey matter lose them in a few. Probing each band's longest-lived tissue
     * (its largest T2 with its largest T1, which bounds the band) and giving
     * each voxel its band's count cuts BrainWeb-like phantoms several-fold.
     * Counts are powers of two, so every voxel's spins lie on one lattice
     * (folding and lattice synthesis need that).
     *
     * Null when x is not spoiled or the settings fix the counts uniformly.
     */
    planBands(voxels, voxel, settings) {
      const folded = (this.fold & 1) !== 0;
      const { t1, t2 } = this.longestTimes();
      const bandOf = (v, edges2) => {
        const time = Number.isFinite(t2[v]) && t2[v] > 0 ? t2[v] : Infinity;
        let b = 0;
        while (time > edges2[b]) b++;
        return b;
      };
      let edges;
      let counts;
      let bands;
      let y;
      if (settings.subSpins !== "auto" && !Array.isArray(settings.subSpins)) {
        ({ edges, counts, y } = settings.subSpins);
        bands = [];
      } else {
        if (settings.subSpins !== "auto" || folded || intervalCycles(this.analysis, 0, voxel) <= 0.05) return null;
        const resolution = resolutionCount(this.analysis, 0, voxel);
        edges = T2_BAND_EDGES;
        const members = edges.map(() => []);
        for (const v of voxels) members[bandOf(v, edges)].push(v);
        counts = edges.map(() => 0);
        bands = [];
        const occupied = members.filter((list) => list.length).length;
        let probed = 0;
        for (let b = 0; b < edges.length; b++) {
          if (!members[b].length) continue;
          const range = `${b ? Math.round(edges[b - 1] * 1e3) : 0}\u2013${Number.isFinite(edges[b]) ? Math.round(edges[b] * 1e3) + " ms" : "\u221E"}`;
          this.report(`Probing spins per voxel: T2 ${range} (band ${++probed} of ${occupied})`, 0.2 + 0.7 * (probed - 1) / occupied);
          let t1Max = 0, t2Max = 0;
          for (const v of members[b]) {
            const time1 = Number.isFinite(t1[v]) ? t1[v] : 1e9;
            const time2 = Number.isFinite(t2[v]) ? t2[v] : 1e9;
            t1Max = Math.max(t1Max, time1);
            t2Max = Math.max(t2Max, time2);
          }
          const probe = probeSubSpins(this.program, 0, voxel, [{ t1: t1Max, t2: t2Max }], {
            minimum: resolution,
            maximum: settings.maxSubSpins,
            tolerance: settings.tolerance,
            intervalCycles: intervalCycles(this.analysis, 0, voxel),
            candidates: POWER_OF_TWO_COUNTS
          });
          counts[b] = probe.count;
          bands.push({
            t2Min: b ? edges[b - 1] : 0,
            t2Max: edges[b],
            count: probe.count,
            error: probe.error,
            capped: probe.capped,
            voxels: members[b].length
          });
        }
        y = 0;
      }
      const finest = Math.max(...counts);
      for (const count of counts) {
        if (count && (finest % count !== 0 || (count & count - 1) !== 0)) throw new Error("Banded spin counts must be powers of two.");
      }
      const countX = new Int32Array(this.phantom.nx * this.phantom.ny);
      for (const v of voxels) countX[v] = counts[bandOf(v, edges)] || finest;
      const worst = bands.reduce((max2, band) => Math.max(max2, band.error), 0);
      const axis = {
        count: finest,
        reason: bands.length ? "spoiling" : "manual",
        folded,
        probe: bands.length ? { error: worst, reference: 0, capped: bands.some((b) => b.capped), tested: [] } : void 0
      };
      return { axis, countX, bands, resolved: { kind: "bands", edges, counts, y } };
    }
    /** Per voxel, the longest T1 and T2 among the planes where it has PD (the own plane's maps without planes). */
    longestTimes() {
      const planes = this.phantom.planes ?? [];
      if (!planes.length) return { t1: this.phantom.maps.t1, t2: this.phantom.maps.t2 };
      const cells = this.phantom.nx * this.phantom.ny;
      const t1 = new Float32Array(cells), t2 = new Float32Array(cells);
      const life = (time) => Number.isFinite(time) && time > 0 ? time : Infinity;
      for (const maps of [this.phantom.maps, ...planes.map((plane) => plane.maps)]) {
        for (let v = 0; v < cells; v++) {
          if (!(maps.pd[v] > 0)) continue;
          t1[v] = Math.max(t1[v], life(maps.t1[v]));
          t2[v] = Math.max(t2[v], life(maps.t2[v]));
        }
      }
      return { t1, t2 };
    }
    /** Voxels grouped into the units chunks are cut from (see the file comment). */
    chunkUnits(voxels) {
      const nx = this.phantom.nx;
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
      const planeOf = this.slices ? Array.from(this.slices.plane) : [-1];
      const slicesOfPlane = /* @__PURE__ */ new Map();
      for (const plane of planeOf) slicesOfPlane.set(plane, (slicesOfPlane.get(plane) ?? 0) + 1);
      const along = (v) => this.countX ? this.countX[v] : subSpins[0];
      if (!this.fold) {
        let total2 = 0;
        for (const unit of units) {
          for (const v of unit) {
            for (const [plane, count] of slicesOfPlane) if (planeMaps(this.phantom, plane).pd[v] > 0) total2 += along(v) * subSpins[1] * count;
          }
        }
        return total2;
      }
      if (this.fold === 3) {
        let total2 = 0;
        for (const [plane, count] of slicesOfPlane) {
          const entries = /* @__PURE__ */ new Set();
          const of = plane < 0 ? this.physics.of : this.physics.ofPlanes[plane];
          for (const unit of units) for (const v of unit) if (of[v] >= 0) entries.add(of[v]);
          total2 += entries.size * count;
        }
        return total2;
      }
      let total = 0;
      for (const unit of units) {
        const seen = /* @__PURE__ */ new Map();
        for (const v of unit) {
          const positions = this.fold & 1 ? 1 : along(v);
          for (const [plane, count] of slicesOfPlane) {
            const of = plane < 0 ? this.physics.of : this.physics.ofPlanes[plane];
            if (of[v] < 0) continue;
            seen.set(`${of[v]}|${positions}|${plane}`, positions * (this.fold & 2 ? 1 : subSpins[1]) * count);
          }
        }
        for (const count of seen.values()) total += count;
      }
      return total;
    }
  };
  function tolerancePercent(settings) {
    return `${+(100 * (settings.tolerance ?? 0.02)).toFixed(1)} %`;
  }
  var IGNORED_FEATURE_TEXT = {
    "trigger": "trigger events",
    "nco": "NCO frequency and phase events",
    "dynamic-ptx-rf": "dynamic pTx RF (per-channel waveforms)",
    "rf-shims": "RF shims (static pTx). Phantoms have no per-channel B1+ maps yet, so the shim weights are not applied"
  };
  function bandCount(bands, t2) {
    const time = Number.isFinite(t2) && t2 > 0 ? t2 : Infinity;
    let b = 0;
    while (b < bands.edges.length - 1 && time > bands.edges[b]) b++;
    return bands.counts[b] || Math.max(...bands.counts);
  }
  function clampCount(value) {
    const n = Math.floor(value);
    if (!(n >= 1 && n <= 4096)) throw new Error(`Spins per voxel must be between 1 and 4096 per axis, got ${value}.`);
    return n;
  }
  function representativeTissues(physics) {
    const indices = physics.t1.map((_, i2) => i2);
    if (indices.length <= PROBE_TISSUES) return indices.map((i2) => ({ t1: physics.t1[i2], t2: physics.t2[i2] }));
    const life = (time) => Number.isFinite(time) && time > 0 ? time : 0;
    const byT2 = indices.slice().sort((a, b) => life(physics.t2[b]) - life(physics.t2[a]) || life(physics.t1[b]) - life(physics.t1[a]));
    const byT1 = indices.slice().sort((a, b) => life(physics.t1[b]) - life(physics.t1[a]));
    const chosen = /* @__PURE__ */ new Set([byT2[0], byT1[0], byT2[Math.floor(byT2.length / 2)], byT2[1]]);
    return [...chosen].slice(0, PROBE_TISSUES).map((i2) => ({ t1: physics.t1[i2], t2: physics.t2[i2] }));
  }
  function volumeExtent(phantom) {
    const dz = phantom.voxel[2];
    if (!phantom.planes?.length || !(dz > 0)) return null;
    let lo = 0, hi = 0;
    for (const plane of phantom.planes) {
      lo = Math.min(lo, plane.offset);
      hi = Math.max(hi, plane.offset);
    }
    return [(lo - 0.5) * dz, (hi + 0.5) * dz];
  }
  function encodingExtent(trajectory, axis) {
    let largest = 0;
    for (let s = axis; s < trajectory.k.length; s += 3) largest = Math.max(largest, Math.abs(trajectory.k[s]));
    return largest;
  }
  function phaseGraphPreset(tolerance) {
    if (tolerance <= 0.02) return { prune: 1e-5, maxStates: 2e3, density: 2, rfStep: 5, fine: { t: 5e-3, b1: 25e-4 } };
    if (tolerance <= 0.05) return { prune: 3e-4, maxStates: 2e3, density: 1.5, rfStep: 10, fine: { t: 0.01, b1: 5e-3 } };
    if (tolerance <= 0.1) return { prune: 1e-3, maxStates: 2e3, density: 1, rfStep: 20, fine: { t: 0.02, b1: 0.01 } };
    return { prune: 0.01, maxStates: 2e3, density: 0.5, rfStep: 40, fine: { t: 0.04, b1: 0.02 } };
  }
  function splitUnits(units, spinsOf, target) {
    const chunks = [];
    let current = [];
    let spins = 0;
    for (const unit of units) {
      let unitSpins = 0;
      for (const v of unit) unitSpins += spinsOf(v);
      if (current.length && spins + unitSpins > target) {
        chunks.push(Int32Array.from(current));
        current = [];
        spins = 0;
      }
      for (const v of unit) current.push(v);
      spins += unitSpins;
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

  // src/sim/io/mat5.ts
  var miINT8 = 1;
  var miUINT8 = 2;
  var miINT16 = 3;
  var miUINT16 = 4;
  var miINT32 = 5;
  var miUINT32 = 6;
  var miINT64 = 12;
  var miUINT64 = 13;
  var miMATRIX = 14;
  var miCOMPRESSED = 15;
  var miUTF8 = 16;
  var miUTF16 = 17;
  var miUTF32 = 18;
  var NUMERIC_STORAGE = {
    [miINT8]: "i1",
    [miUINT8]: "u1",
    [miINT16]: "i2",
    [miUINT16]: "u2",
    [miINT32]: "i4",
    [miUINT32]: "u4",
    7: "f4",
    9: "f8",
    [miINT64]: "i8",
    [miUINT64]: "u8"
  };
  var CLASS_NAMES = [
    "unknown",
    "cell",
    "struct",
    "object",
    "char",
    "sparse",
    "double",
    "single",
    "int8",
    "uint8",
    "int16",
    "uint16",
    "int32",
    "uint32",
    "int64",
    "uint64",
    "function_handle",
    "opaque"
  ];
  var CLASS_PRECISION = {
    double: "f8",
    single: "f4",
    int8: "f4",
    uint8: "f4",
    int16: "f4",
    uint16: "f4",
    int32: "f8",
    uint32: "f8",
    int64: "f8",
    uint64: "f8",
    logical: "f4"
  };
  var SKIP_REASONS = {
    cell: "cell arrays are not supported; save each cell as its own variable",
    struct: "structs are not supported; save the fields as variables (save(file, '-struct', 's'))",
    object: "MATLAB objects are not supported",
    sparse: "sparse matrices are not supported; save full(x) instead",
    function_handle: "function handles are not supported"
  };
  var MAT_V73_MESSAGE = "MAT v7.3 files are HDF5; save with -v7 or use .npz.";
  function readMat5(bytes) {
    const littleEndian = readHeader(bytes);
    const variables = [];
    let pos = 128;
    for (let index = 1; bytes.length - pos >= 8; index++) {
      const what = `MAT variable ${index}`;
      const tag = readTag(bytes, pos, bytes.length, littleEndian, what);
      let variable;
      if (tag.type === miCOMPRESSED) {
        const inner = unzlib(
          bytes.subarray(tag.start, tag.start + tag.length),
          8,
          (prefix) => compressedSize(prefix, littleEndian, what),
          what
        );
        const element = readTag(inner, 0, inner.length, littleEndian, what);
        variable = readVariable(inner, element, littleEndian, what);
      } else {
        variable = readVariable(bytes, tag, littleEndian, what);
      }
      if (variable) variables.push(variable);
      pos = tag.start + tag.length;
    }
    return variables;
  }
  function readHeader(bytes) {
    if (isHdf5(bytes, 0) || isHdf5(bytes, 512)) throw new Error(MAT_V73_MESSAGE);
    if (isMat4(bytes)) throw new Error("MAT v4 (Level 4) files are not supported; save with -v7.");
    if (bytes.length < 128) throw new Error("Not a MAT-file: shorter than the 128-byte header.");
    const indicator = String.fromCharCode(bytes[126], bytes[127]);
    if (indicator !== "IM" && indicator !== "MI") throw new Error("Not a MAT-file: the endian indicator is missing.");
    const littleEndian = indicator === "IM";
    const major = littleEndian ? bytes[125] : bytes[124];
    if (major === 2) throw new Error(MAT_V73_MESSAGE);
    if (major !== 1) throw new Error(`Unsupported MAT-file version ${major} (Level 5 files are version 1).`);
    return littleEndian;
  }
  function isMat4(bytes) {
    if (bytes.length < 20) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, 20);
    return [true, false].some((littleEndian) => {
      const [mopt, rows, columns, imagf, nameLength] = [0, 4, 8, 12, 16].map((p) => view.getInt32(p, littleEndian));
      return mopt >= 0 && mopt <= 4052 && Math.floor(mopt / 100) % 10 === 0 && Math.floor(mopt / 10) % 10 <= 5 && mopt % 10 <= 2 && rows >= 0 && columns >= 0 && (imagf === 0 || imagf === 1) && nameLength >= 1 && nameLength <= 65536;
    });
  }
  function isHdf5(bytes, offset) {
    const signature = [137, 72, 68, 70, 13, 10, 26, 10];
    return bytes.length >= offset + 8 && signature.every((byte, i2) => bytes[offset + i2] === byte);
  }
  function readTag(bytes, pos, end, littleEndian, what) {
    if (pos + 8 > end) throw new Error(`${what}: the MAT-file is truncated (an element tag is cut off).`);
    const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 8);
    const first = view.getUint32(0, littleEndian);
    const small = first >>> 16;
    if (small !== 0) {
      if (small > 4) throw new Error(`${what}: corrupt MAT-file (small data element of ${small} bytes).`);
      return { type: first & 65535, start: pos + 4, length: small, next: pos + 8 };
    }
    const length = view.getUint32(4, littleEndian);
    const start = pos + 8;
    if (start + length > end) {
      throw new Error(`${what}: the MAT-file is truncated (an element needs ${length} bytes, ${end - start} remain).`);
    }
    return { type: first, start, length, next: Math.min(start + Math.ceil(length / 8) * 8, end) };
  }
  function compressedSize(prefix, littleEndian, what) {
    if (prefix.length < 8) throw new Error(`${what}: the compressed variable is empty or corrupt.`);
    const view = new DataView(prefix.buffer, prefix.byteOffset, 8);
    const first = view.getUint32(0, littleEndian);
    return first >>> 16 ? 8 : 8 + view.getUint32(4, littleEndian);
  }
  function readVariable(bytes, element, littleEndian, what) {
    if (element.type !== miMATRIX) {
      throw new Error(`${what}: expected a MATLAB array (miMATRIX), found data element type ${element.type}; the file is corrupt.`);
    }
    const end = element.start + element.length;
    if (element.length === 0) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const flagsTag = readTag(bytes, element.start, end, littleEndian, what);
    if (flagsTag.type !== miUINT32 || flagsTag.length < 4) throw new Error(`${what}: corrupt MAT-file (no array flags).`);
    const flags = view.getUint32(flagsTag.start, littleEndian);
    const classCode = flags & 255;
    const complex = (flags & 2048) !== 0, logical = (flags & 512) !== 0;
    const mclass = CLASS_NAMES[classCode] ?? "unknown";
    if (mclass === "opaque") {
      const nameTag2 = readTag(bytes, flagsTag.next, end, littleEndian, what);
      const name2 = latin12(bytes, nameTag2);
      if (!name2) return null;
      let className = "object";
      try {
        const systemTag = readTag(bytes, nameTag2.next, end, littleEndian, what);
        className = latin12(bytes, readTag(bytes, systemTag.next, end, littleEndian, what)) || className;
      } catch {
      }
      return {
        kind: "skipped",
        name: name2,
        class: "opaque",
        shape: [],
        reason: `MATLAB ${className} objects are not supported; convert to a numeric or char array (e.g. char(x)) before saving`
      };
    }
    const dimsTag = readTag(bytes, flagsTag.next, end, littleEndian, what);
    if (dimsTag.type !== miINT32 || dimsTag.length % 4 !== 0 || dimsTag.length === 0) {
      throw new Error(`${what}: corrupt MAT-file (invalid dimensions).`);
    }
    const shape = [];
    for (let p = dimsTag.start; p < dimsTag.start + dimsTag.length; p += 4) shape.push(view.getInt32(p, littleEndian));
    if (shape.some((size) => size < 0)) throw new Error(`${what}: corrupt MAT-file (negative dimension).`);
    const nameTag = readTag(bytes, dimsTag.next, end, littleEndian, what);
    const name = latin12(bytes, nameTag);
    if (!name) return null;
    const label = `${what} ('${name}')`;
    const dataStart = nameTag.next;
    if (classCode >= 6 && classCode <= 15) {
      const cls = logical ? "logical" : mclass;
      const count = elementCount(shape);
      const precision = CLASS_PRECISION[cls];
      const real = readNumeric(bytes, dataStart, end, littleEndian, count, shape, precision, `${label}, real part`);
      const array = { kind: "array", name, class: cls, dtype: cls, shape, order: "F", data: real.data };
      if (complex) array.imag = readNumeric(bytes, real.next, end, littleEndian, count, shape, precision, `${label}, imaginary part`).data;
      return array;
    }
    if (mclass === "char") return readText(bytes, dataStart, end, littleEndian, name, shape, label);
    return {
      kind: "skipped",
      name,
      class: mclass,
      shape,
      reason: SKIP_REASONS[mclass] ?? `unknown MATLAB class ${classCode}`
    };
  }
  function readNumeric(bytes, pos, end, littleEndian, count, shape, precision, what) {
    const tag = readTag(bytes, pos, end, littleEndian, what);
    const type = NUMERIC_STORAGE[tag.type];
    if (!type) throw new Error(`${what}: unsupported storage type ${tag.type}.`);
    if (tag.length !== count * ELEMENT_SIZE[type]) {
      throw new Error(`${what}: ${tag.length} bytes of ${type} data do not fit dimensions [${shape.join(", ")}].`);
    }
    return { data: decodeElements(bytes, tag.start, count, type, littleEndian, precision), next: tag.next };
  }
  function readText(bytes, pos, end, littleEndian, name, shape, what) {
    const tag = readTag(bytes, pos, end, littleEndian, what);
    const raw = bytes.subarray(tag.start, tag.start + tag.length);
    let text2;
    if (tag.type === miUTF8) {
      text2 = new TextDecoder("utf-8").decode(raw);
    } else if (tag.type === miUINT8 || tag.type === miINT8) {
      text2 = latin12(bytes, tag);
    } else if (tag.type === miUINT16 || tag.type === miUTF16 || tag.type === miINT16) {
      text2 = fromCodes(decodeElements(bytes, tag.start, tag.length >> 1, "u2", littleEndian, "f4"), String.fromCharCode);
    } else if (tag.type === miUTF32 || tag.type === miUINT32) {
      const codes = Array.from(
        decodeElements(bytes, tag.start, tag.length >> 2, "u4", littleEndian, "f8"),
        (code) => code <= 1114111 ? code : 65533
      );
      text2 = fromCodes(codes, String.fromCodePoint);
    } else {
      return { kind: "skipped", name, class: "char", shape, reason: `char data stored as unsupported type ${tag.type}` };
    }
    const count = elementCount(shape);
    let rows;
    if (text2.length !== count) {
      rows = [text2];
    } else {
      const height = shape[0], width = shape.length > 1 ? shape[1] : 1;
      const pages = height * width > 0 ? count / (height * width) : 0;
      rows = [];
      for (let page = 0; page < pages; page++) {
        for (let i2 = 0; i2 < height; i2++) {
          let row = "";
          for (let j = 0; j < width; j++) row += text2[page * height * width + j * height + i2];
          rows.push(row);
        }
      }
      if (pages === 0 && height > 0 && width === 0) rows = new Array(height).fill("");
    }
    return { kind: "text", name, class: "char", shape, rows, value: rows.join("\n") };
  }
  function fromCodes(codes, convert) {
    let text2 = "";
    for (let i2 = 0; i2 < codes.length; i2 += 8192) {
      text2 += convert(...Array.from({ length: Math.min(8192, codes.length - i2) }, (_, k) => codes[i2 + k]));
    }
    return text2;
  }
  function latin12(bytes, tag) {
    let text2 = "";
    for (let i2 = tag.start; i2 < tag.start + tag.length; i2++) text2 += String.fromCharCode(bytes[i2]);
    return text2;
  }

  // src/sim/io/nifti.ts
  var DATATYPES = {
    2: { name: "uint8", element: "u1", complex: false },
    4: { name: "int16", element: "i2", complex: false },
    8: { name: "int32", element: "i4", complex: false },
    16: { name: "float32", element: "f4", complex: false },
    32: { name: "complex64", element: "f4", complex: true },
    64: { name: "float64", element: "f8", complex: false },
    256: { name: "int8", element: "i1", complex: false },
    512: { name: "uint16", element: "u2", complex: false },
    768: { name: "uint32", element: "u4", complex: false },
    1024: { name: "int64", element: "i8", complex: false },
    1280: { name: "uint64", element: "u8", complex: false },
    1792: { name: "complex128", element: "f8", complex: true }
  };
  var UNSUPPORTED_DATATYPES = {
    0: "unknown",
    1: "binary (1 bit)",
    128: "RGB24",
    1536: "float128",
    2048: "complex256",
    2304: "RGBA32"
  };
  var SPATIAL_UNITS = {
    0: ["unknown", 1e-3],
    1: ["meter", 1],
    2: ["mm", 1e-3],
    3: ["micron", 1e-6]
  };
  var TEMPORAL_UNITS = {
    0: "unknown",
    8: "sec",
    16: "msec",
    24: "usec",
    32: "hz",
    40: "ppm",
    48: "rads"
  };
  function readNifti(bytes) {
    const file = isGzip(bytes) ? gunzip(bytes, 544, (prefix) => {
      const h = parseHeader(prefix);
      return h.voxOffset + h.dataBytes;
    }, "NIfTI") : bytes;
    const header = parseHeader(file);
    const available = file.length - header.voxOffset;
    if (header.dataBytes > available) {
      throw new Error(`NIfTI data is truncated: ${header.shape.join("\xD7")} ${header.type.name} voxels need ${header.dataBytes} bytes after offset ${header.voxOffset}, ${Math.max(0, available)} remain.`);
    }
    const { element, complex } = header.type;
    const count = elementCount(header.shape);
    const precision = outputPrecision(element);
    const data = decodeElements(file, header.voxOffset, count, element, header.littleEndian, precision, complex ? 2 : 1);
    const imag = complex ? decodeElements(file, header.voxOffset + ELEMENT_SIZE[element], count, element, header.littleEndian, precision, 2) : void 0;
    const { sclSlope: slope, sclInter: inter } = header;
    const scaled = Number.isFinite(slope) && slope !== 0;
    if (scaled && !Number.isFinite(inter)) throw new Error(`NIfTI header has scl_slope ${slope} but an invalid scl_inter (${inter}).`);
    if (scaled && (slope !== 1 || inter !== 0)) {
      for (let i2 = 0; i2 < count; i2++) data[i2] = data[i2] * slope + inter;
      if (imag) for (let i2 = 0; i2 < count; i2++) imag[i2] *= slope;
    }
    const [spatialUnits, metres] = SPATIAL_UNITS[header.xyztUnits & 7] ?? SPATIAL_UNITS[0];
    const step = (k) => {
      const value = header.pixdim[k];
      return value !== 0 && Number.isFinite(value) ? value : 1;
    };
    const { affine, source } = worldAffine(header, step, metres * 1e3);
    const image = {
      dtype: header.type.name,
      shape: header.shape,
      order: "F",
      data,
      version: header.version,
      littleEndian: header.littleEndian,
      datatype: header.datatype,
      pixdim: header.pixdim,
      spatialUnits,
      temporalUnits: TEMPORAL_UNITS[header.xyztUnits & 56] ?? "unknown",
      voxelSize: [Math.abs(step(1)) * metres, Math.abs(step(2)) * metres, Math.abs(step(3)) * metres],
      affine,
      affineSource: source,
      qformCode: header.qformCode,
      sformCode: header.sformCode,
      sclSlope: slope,
      sclInter: inter,
      scaled,
      intentCode: header.intentCode,
      intentName: header.intentName,
      description: header.description
    };
    if (imag) image.imag = imag;
    return image;
  }
  function worldAffine(header, step, toMm) {
    let rows;
    let source;
    if (header.sformCode > 0) {
      rows = header.srow.slice();
      source = "sform";
    } else if (header.qformCode > 0) {
      rows = quaternionAffine(header);
      source = "qform";
    } else {
      rows = [step(1), 0, 0, 0, 0, step(2), 0, 0, 0, 0, step(3), 0];
      source = "pixdim";
    }
    return { affine: [...rows.map((value) => value * toMm), 0, 0, 0, 1], source };
  }
  function quaternionAffine(header) {
    let [b, c, d] = header.quatern;
    let a = 1 - (b * b + c * c + d * d);
    if (a < 1e-7) {
      const norm3 = 1 / Math.sqrt(b * b + c * c + d * d);
      b *= norm3;
      c *= norm3;
      d *= norm3;
      a = 0;
    } else {
      a = Math.sqrt(a);
    }
    const positive = (value) => value > 0 ? value : 1;
    const dx = positive(header.pixdim[1]), dy = positive(header.pixdim[2]);
    const dz = positive(header.pixdim[3]) * (header.pixdim[0] < 0 ? -1 : 1);
    const [qx, qy, qz] = header.qoffset;
    return [
      (a * a + b * b - c * c - d * d) * dx,
      2 * (b * c - a * d) * dy,
      2 * (b * d + a * c) * dz,
      qx,
      2 * (b * c + a * d) * dx,
      (a * a + c * c - b * b - d * d) * dy,
      2 * (c * d - a * b) * dz,
      qy,
      2 * (b * d - a * c) * dx,
      2 * (c * d + a * b) * dy,
      (a * a + d * d - c * c - b * b) * dz,
      qz
    ];
  }
  function parseHeader(bytes) {
    if (bytes.length < 4) throw new Error("Not a NIfTI file: too short.");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let littleEndian = true;
    let size = view.getInt32(0, true);
    if (size !== 348 && size !== 540) {
      littleEndian = false;
      size = view.getInt32(0, false);
    }
    if (size !== 348 && size !== 540) throw new Error("Not a NIfTI file: sizeof_hdr is neither 348 (NIfTI-1) nor 540 (NIfTI-2).");
    const version = size === 348 ? 1 : 2;
    if (bytes.length < size) throw new Error(`NIfTI file is truncated inside its ${size}-byte header.`);
    const magic = text(bytes, version === 1 ? 344 : 4, 4);
    const single = version === 1 ? "n+1" : "n+2", pair = version === 1 ? "ni1" : "ni2";
    if (magic === pair) {
      throw new Error("This is the header of a NIfTI .hdr/.img pair; only single-file .nii or .nii.gz images are supported. Convert it first, e.g. nibabel.save(nibabel.load('x.hdr'), 'x.nii') or fslchfiletype NIFTI x.");
    }
    if (magic !== single) {
      throw new Error(`Not a single-file NIfTI-${version} image (magic '${magic.replace(/[^\x20-\x7e]/g, "?")}'); Analyze 7.5 and .hdr/.img pairs are not supported.`);
    }
    const i16 = (p) => view.getInt16(p, littleEndian);
    const i322 = (p) => view.getInt32(p, littleEndian);
    const f32 = (p) => view.getFloat32(p, littleEndian);
    const f64 = (p) => view.getFloat64(p, littleEndian);
    const i64 = (p) => {
      const low = littleEndian ? p : p + 4, high = littleEndian ? p + 4 : p;
      return view.getInt32(high, littleEndian) * 4294967296 + view.getUint32(low, littleEndian);
    };
    const n1 = version === 1;
    const dim = Array.from({ length: 8 }, (_, k) => n1 ? i16(40 + 2 * k) : i64(16 + 8 * k));
    const pixdim = Array.from({ length: 8 }, (_, k) => n1 ? f32(76 + 4 * k) : f64(104 + 8 * k));
    const datatype = n1 ? i16(70) : i16(12);
    const rank = dim[0];
    if (!(rank >= 1 && rank <= 7)) throw new Error(`NIfTI header has an invalid dim[0] = ${rank}.`);
    const shape = dim.slice(1, rank + 1);
    if (shape.some((extent) => extent < 0)) throw new Error(`NIfTI header has a negative dimension: [${shape.join(", ")}].`);
    const type = DATATYPES[datatype];
    if (!type) {
      const what = UNSUPPORTED_DATATYPES[datatype];
      throw new Error(`NIfTI datatype ${datatype}${what ? ` (${what})` : ""} is not supported; use an integer, float32/64 or complex type.`);
    }
    const voxelBytes = ELEMENT_SIZE[type.element] * (type.complex ? 2 : 1);
    const storedOffset = n1 ? f32(108) : i64(168);
    if (!(storedOffset >= 0 && Number.isFinite(storedOffset))) throw new Error(`NIfTI header has an invalid vox_offset (${storedOffset}).`);
    const voxOffset = Math.max(Math.floor(storedOffset), size + 4);
    const srow = n1 ? Array.from({ length: 12 }, (_, k) => f32(280 + 4 * k)) : Array.from({ length: 12 }, (_, k) => f64(400 + 8 * k));
    return {
      version,
      littleEndian,
      datatype,
      type,
      shape,
      pixdim,
      voxOffset,
      dataBytes: elementCount(shape) * voxelBytes,
      sclSlope: n1 ? f32(112) : f64(176),
      sclInter: n1 ? f32(116) : f64(184),
      xyztUnits: n1 ? bytes[123] : i322(500),
      qformCode: n1 ? i16(252) : i322(344),
      sformCode: n1 ? i16(254) : i322(348),
      quatern: n1 ? [f32(256), f32(260), f32(264)] : [f64(352), f64(360), f64(368)],
      qoffset: n1 ? [f32(268), f32(272), f32(276)] : [f64(376), f64(384), f64(392)],
      srow,
      intentCode: n1 ? i16(68) : i322(504),
      intentName: text(bytes, n1 ? 328 : 508, 16),
      description: text(bytes, n1 ? 148 : 240, 80)
    };
  }
  function text(bytes, offset, length) {
    let result = "";
    for (let i2 = offset; i2 < offset + length && bytes[i2] !== 0; i2++) result += String.fromCharCode(bytes[i2]);
    return result;
  }

  // src/sim/phantom/files.ts
  var MRZERO_NPZ_FOV = 0.192;
  var MRZERO_MAT_SIZE = [0.2, 0.2, 8e-3];
  var MRZERO_MAT_T2DASH = 0.03;
  var MRZERO_MAT_ADC = 1e-9;
  var DEFAULT_FOV = 0.2;
  var ALIASES = {
    pd: ["pd", "rho", "m0", "density", "protondensity"],
    t1: ["t1"],
    t2: ["t2"],
    t2prime: ["t2prime", "t2dash", "t2'", "t2p"],
    adc: ["adc", "d"],
    b0: ["b0", "db0", "df", "deltab0"],
    b1: ["b1", "b1+", "b1plus", "b1p"]
  };
  function loadPhantomFiles(files) {
    if (!files.length) throw new Error("No phantom file given.");
    const lower = files.map((file) => file.name.toLowerCase());
    let volume2;
    if (lower.every((name) => name.endsWith(".nii") || name.endsWith(".nii.gz"))) {
      volume2 = fromNifti(files);
    } else if (files.length === 1 && lower[0].endsWith(".npz")) {
      volume2 = fromArrays(readNpz(files[0].bytes), files[0].name);
    } else if (files.length === 1 && lower[0].endsWith(".mat")) {
      volume2 = fromMat(files[0]);
    } else if (files.length === 1 && lower[0].endsWith(".npy")) {
      volume2 = fromStack(readNpy(files[0].bytes), files[0].name, null);
    } else if (lower.some((name) => name.endsWith(".json"))) {
      throw new Error("MRzero NIfTI phantoms (.json + .nii.gz) are not supported yet; load the maps as separate NIfTI files.");
    } else {
      throw new Error("Load one .npz, .mat or .npy file, or one or more NIfTI (.nii, .nii.gz) maps.");
    }
    return sanitise(volume2);
  }
  function fromArrays(arrays, source) {
    const found = /* @__PURE__ */ new Map();
    const used = [];
    for (const [key, array] of arrays) {
      const name = mapNameOf(key);
      if (name && !found.has(name)) {
        found.set(name, array);
        used.push(key);
      }
    }
    if (!found.has("pd")) {
      const keys = [...arrays.keys()].join(", ") || "none";
      throw new Error(`No proton-density map (PD, PD_map, rho, M0, density) among the arrays: ${keys}.`);
    }
    const mrzero = arrays.has("PD_map") && arrays.has("T1_map");
    const notes = [];
    const pd = found.get("pd");
    const shape = spatialShape(pd, source);
    const fovArray = arrays.get("FOV") ?? arrays.get("fov");
    let fov;
    if (fovArray) {
      fov = vector3(fovArray, "FOV");
      if (Math.max(...fov) > 2) {
        fov = fov.map((v) => v / 1e3);
        notes.push("FOV looked like millimetres and was converted to metres.");
      }
    } else if (mrzero) {
      fov = [MRZERO_NPZ_FOV, MRZERO_NPZ_FOV, MRZERO_NPZ_FOV];
    } else {
      fov = [DEFAULT_FOV, DEFAULT_FOV, shape[2] > 1 ? DEFAULT_FOV : 0];
      notes.push(`No FOV in the file: assumed ${DEFAULT_FOV * 1e3} mm.`);
    }
    const maps = {};
    for (const [name, array] of found) {
      const values = toVolume(array, shape, `${name.toUpperCase()} map`);
      maps[name] = name === "adc" && mrzero ? scale(values, 1e-9) : values;
    }
    if (!maps.t1 || !maps.t2) throw new Error("The phantom needs T1 and T2 maps (T1, T2 or T1_map, T2_map).");
    if (!mrzero && maps.adc) notes.push("ADC map taken as m\xB2/s.");
    return {
      shape,
      voxel: voxelOf(fov, shape),
      maps,
      source: `${baseName(source)} (${mrzero ? "MRzero" : used.join(", ")})`,
      notes
    };
  }
  function fromMat(file) {
    const variables = readMat5(file.bytes).filter((v) => v.kind === "array" && v.data.length > 0);
    const arrays = new Map(variables.map((v) => [v.name, v]));
    const stacked = variables.filter((v) => v.shape.length >= 3 && v.shape[v.shape.length - 1] === 5);
    if (stacked.length === 1 && ![...arrays.keys()].some((key) => mapNameOf(key) === "pd")) {
      return fromStack(stacked[0], file.name, stacked[0].name);
    }
    return fromArrays(arrays, file.name);
  }
  function fromStack(array, source, variable) {
    const channels = array.shape[array.shape.length - 1];
    if (array.shape.length < 3 || channels < 3 || channels > 5) {
      throw new Error(`Expected an array [x, y, (z,) 5] of PD, T1, T2, B0, B1 (MRzero layout); got [${array.shape.join(", ")}].`);
    }
    const spatial = array.shape.slice(0, -1);
    const shape = [spatial[0], spatial[1], spatial[2] ?? 1];
    const channel = (c) => toVolume(channelOf(array, c), shape, ["PD", "T1", "T2", "B0", "B1"][c]);
    const maps = { pd: channel(0), t1: channel(1), t2: channel(2) };
    if (channels > 3) maps.b0 = channel(3);
    if (channels > 4) maps.b1 = channel(4);
    const n = shape[0] * shape[1] * shape[2];
    maps.t2prime = new Float32Array(n).fill(MRZERO_MAT_T2DASH);
    maps.adc = new Float32Array(n).fill(MRZERO_MAT_ADC);
    const size = shape[2] > 1 ? [MRZERO_MAT_SIZE[0], MRZERO_MAT_SIZE[1], MRZERO_MAT_SIZE[0]] : MRZERO_MAT_SIZE;
    return {
      shape,
      voxel: voxelOf(size, shape),
      maps,
      source: `${baseName(source)} (MRzero${variable ? ` ${variable}` : ""})`,
      notes: [`MRzero .mat layout: FOV ${size.map((v) => v * 1e3).join(" \xD7 ")} mm, T2\u2032 30 ms and ADC 1e-9 m\xB2/s everywhere (MRzero's defaults).`]
    };
  }
  function fromNifti(files) {
    const maps = {};
    let shape = null;
    let voxel = [1e-3, 1e-3, 1e-3];
    const names = [];
    for (const file of files) {
      const image = readNifti(file.bytes);
      const name = niftiMapName(file.name);
      if (!name) throw new Error(`Cannot tell which map ${file.name} holds; name it like brain_T1.nii.gz (PD, T1, T2, T2prime, ADC, B0, B1).`);
      if (maps[name]) throw new Error(`Two files hold the ${name.toUpperCase()} map.`);
      const own = spatialShape(image, file.name);
      if (shape && own.some((v, i2) => v !== shape[i2])) throw new Error(`${file.name} is ${own.join("\xD7")}, the other maps ${shape.join("\xD7")}.`);
      shape = own;
      maps[name] = toVolume(image, own, file.name);
      voxel = image.voxelSize;
      names.push(name.toUpperCase());
    }
    if (!maps.pd) throw new Error("No proton-density NIfTI (e.g. brain.nii.gz, brain_PD.nii.gz or brain_density.nii.gz).");
    if (!maps.t1 || !maps.t2) throw new Error("NIfTI phantoms need T1 and T2 maps as well (brain_T1.nii.gz, brain_T2.nii.gz).");
    return { shape, voxel, maps, source: `NIfTI (${names.join(", ")})`, notes: [] };
  }
  function niftiMapName(fileName) {
    const stem = baseName(fileName).replace(/\.nii(\.gz)?$/i, "");
    const cut = stem.lastIndexOf("_");
    if (cut < 0) return "pd";
    return mapNameOf(stem.slice(cut + 1)) ?? (/^(pd|density)$/i.test(stem.slice(cut + 1)) ? "pd" : null);
  }
  function mapNameOf(key) {
    const normalised = key.toLowerCase().replace(/_map$/, "");
    for (const name of Object.keys(ALIASES)) {
      if (ALIASES[name].includes(normalised)) return name;
    }
    return null;
  }
  function spatialShape(array, what) {
    const shape = array.shape.slice();
    while (shape.length > 3 && shape[shape.length - 1] === 1) shape.pop();
    if (shape.length < 2 || shape.length > 3) {
      throw new Error(`${baseName(what)}: expected a 2-D or 3-D map, got [${array.shape.join(", ")}].`);
    }
    return [shape[0], shape[1], shape[2] ?? 1];
  }
  function toVolume(array, shape, what) {
    const [nx, ny, nz] = shape;
    const n = nx * ny * nz;
    if (array.data.length < n) throw new Error(`${what}: ${array.data.length} values for a ${nx}\xD7${ny}\xD7${nz} grid.`);
    const out = new Float32Array(n);
    if (array.order === "F" || ny === 1 && nz === 1) {
      for (let i2 = 0; i2 < n; i2++) out[i2] = array.data[i2];
      return out;
    }
    for (let x2 = 0; x2 < nx; x2++) {
      for (let y = 0; y < ny; y++) {
        const row = (x2 * ny + y) * nz;
        for (let z = 0; z < nz; z++) out[x2 + nx * (y + ny * z)] = array.data[row + z];
      }
    }
    return out;
  }
  function channelOf(array, c) {
    const spatial = array.shape.slice(0, -1);
    const n = spatial.reduce((a, b) => a * b, 1);
    const channels = array.shape[array.shape.length - 1];
    const data = new Float32Array(n);
    if (array.order === "F") {
      for (let i2 = 0; i2 < n; i2++) data[i2] = array.data[c * n + i2];
    } else {
      for (let i2 = 0; i2 < n; i2++) data[i2] = array.data[i2 * channels + c];
    }
    return { dtype: array.dtype, shape: spatial, order: array.order, data };
  }
  function vector3(array, what) {
    const v = Array.from(array.data);
    if (v.length < 2 || v.some((x2) => !(x2 > 0))) throw new Error(`${what} must hold 2 or 3 positive numbers.`);
    return [v[0], v[1], v[2] ?? v[0]];
  }
  function voxelOf(fov, shape) {
    return [0, 1, 2].map((i2) => fov[i2] > 0 ? fov[i2] / shape[i2] : 1e-3);
  }
  function scale(values, factor) {
    for (let i2 = 0; i2 < values.length; i2++) values[i2] *= factor;
    return values;
  }
  function sanitise(volume2) {
    const { maps, notes } = volume2;
    for (let i2 = 0; i2 < maps.pd.length; i2++) if (!(maps.pd[i2] > 0)) maps.pd[i2] = 0;
    for (const name of ["t1", "t2", "t2prime"]) {
      const map = maps[name];
      if (!map) continue;
      let max2 = 0;
      for (let i2 = 0; i2 < map.length; i2++) if (maps.pd[i2] > 0 && map[i2] > max2) max2 = map[i2];
      if (max2 > 50) {
        scale(map, 1e-3);
        notes.push(`${name.toUpperCase()} looked like milliseconds (max ${max2.toFixed(0)}) and was converted to seconds.`);
      }
    }
    if (maps.b1) {
      let max2 = 0;
      for (let i2 = 0; i2 < maps.b1.length; i2++) if (maps.pd[i2] > 0 && maps.b1[i2] > max2) max2 = maps.b1[i2];
      if (max2 > 10) {
        scale(maps.b1, 0.01);
        notes.push("B1 looked like percent and was converted to a relative factor.");
      }
    }
    return volume2;
  }
  function withFieldMode(volume2, fields) {
    if (fields === "none") {
      const maps = { ...volume2.maps };
      delete maps.b0;
      delete maps.b1;
      return { ...volume2, maps };
    }
    if (fields === "mrzero" && (!volume2.maps.b0 || !volume2.maps.b1)) {
      const generated = mrzeroFieldMaps(volume2);
      const maps = { ...volume2.maps, b0: volume2.maps.b0 ?? generated.b0, b1: volume2.maps.b1 ?? generated.b1 };
      return { ...volume2, maps, notes: [...volume2.notes, "B0/B1 generated as MRzero does for files without them."] };
    }
    return volume2;
  }
  function baseName(path) {
    const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return cut >= 0 ? path.slice(cut + 1) : path;
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
  var volume = null;
  var previewSession = null;
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
  function phantomBuffers(phantom) {
    const buffers = /* @__PURE__ */ new Set();
    for (const maps of [phantom.maps, ...(phantom.planes ?? []).map((plane) => plane.maps)]) {
      for (const map of Object.values(maps)) if (map) buffers.add(map.buffer);
    }
    if (phantom.coils) {
      buffers.add(phantom.coils.re.buffer);
      buffers.add(phantom.coils.im.buffer);
    }
    return [...buffers];
  }
  function volumeSummary(v) {
    return {
      shape: v.shape,
      voxel: v.voxel,
      source: v.source,
      notes: v.notes,
      maps: Object.keys(v.maps).filter((key) => v.maps[key])
    };
  }
  function loadPhantom(request) {
    if (request.kind === "shepp-logan") {
      let fov = [0.256, 0.256];
      if (request.sequence) {
        const definition = parseSequenceBytes(new Uint8Array(request.sequence), request.name ?? "").definitions.get("FOV");
        if (definition && definition.length >= 2 && +definition[0] > 0 && +definition[1] > 0) fov = [+definition[0], +definition[1]];
      }
      return { volume: null, phantom: sheppLoganPhantom2D(request.size, fov[0], fov[1]) };
    }
    if (request.kind === "files") {
      volume = loadPhantomFiles(request.files.map((file) => ({ name: file.name, bytes: new Uint8Array(file.bytes) })));
    } else if (request.kind === "shepp-logan-3d") {
      volume = sheppLogan3d(request.size, request.sequence ? sequenceFov(request.sequence, request.name ?? "") : null);
    } else if (!volume) {
      throw new Error("Load a phantom file first.");
    }
    const fielded = withFieldMode(volume, request.fields);
    const slice = { ...request.slice };
    if (request.sequence) {
      const neighbours = neighbourRange(fielded, slice, new Uint8Array(request.sequence), request.name ?? "");
      if (neighbours) slice.neighbours = neighbours;
    }
    const phantom = sliceVolume(fielded, slice);
    return { volume: volumeSummary(volume), phantom };
  }
  function sequenceFov(bytes, name) {
    const definition = parseSequenceBytes(new Uint8Array(bytes), name).definitions.get("FOV");
    if (!definition || definition.length < 2) return null;
    const fov = Array.from(definition, Number);
    return fov.slice(0, 2).every((v) => v > 0) ? fov : null;
  }
  function sheppLogan3d(size, fov) {
    const fx = fov ? fov[0] : 0.256, fy = fov ? fov[1] : 0.256;
    const fz = fov && fov.length > 2 && fov[2] >= 0.25 * fx ? fov[2] : fx;
    const nz = Math.max(2, Math.min(64, Math.round(size * fz / fx)));
    return sheppLoganVolume(size, nz, [fx, fy, fz]);
  }
  function neighbourRange(v, slice, sequence, name) {
    const plane = slice.plane ?? "xy";
    const normal = plane === "xy" ? 2 : plane === "xz" ? 1 : 0;
    const planes = v.shape[normal];
    if (planes < 2) return void 0;
    const spacing = v.voxel[normal];
    const index = Math.round(slice.index ?? Math.floor(planes / 2));
    let offResonance = 0;
    if (v.maps.b0) {
      for (let i2 = 0; i2 < v.maps.b0.length; i2++) if (v.maps.pd[i2] > 0) offResonance = Math.max(offResonance, Math.abs(v.maps.b0[i2]));
    }
    const program = compileProgram(parseSequenceBytes(sequence, name));
    const plan = planSlices(measurePulses(program), {
      density: 1,
      planeThickness: spacing,
      offResonance,
      volume: [(-index - 0.5) * spacing, (planes - 1 - index + 0.5) * spacing],
      encodingZ: encodingExtent(adcTrajectory(program), normal)
    });
    if (plan?.extent === "volume") return [-index, planes - 1 - index];
    if (!plan || plan.extent === "plane" || !(spacing > 0)) return void 0;
    const lo = Math.min(...plan.ranges.map((r) => Math.round(r[0] / spacing)));
    const hi = Math.max(...plan.ranges.map((r) => Math.round(r[1] / spacing)));
    return lo === 0 && hi === 0 ? void 0 : [lo, hi];
  }
  function pulseBuffers(pulses) {
    return pulses.flatMap((p) => [p.offsets, p.mx, p.my, p.mz].map((a) => a.buffer));
  }
  function handle(request) {
    switch (request.type) {
      case "phantom": {
        const result = loadPhantom(request.request);
        port.post({ type: "phantom", id: request.id, ...result }, phantomBuffers(result.phantom));
        return;
      }
      case "pulses": {
        const pulses = measurePulses(compileProgram(parseSequenceBytes(new Uint8Array(request.bytes), request.name)));
        port.post({ type: "pulses", id: request.id, pulses }, pulseBuffers(pulses));
        return;
      }
      case "open": {
        jobs.clear();
        let last = -Infinity;
        const job = new SimulationJob(new Uint8Array(request.bytes), request.name, request.settings, {
          onPlanProgress: (message, fraction) => {
            const t = now();
            if (t - last < PROGRESS_SPACING_MS) return;
            last = t;
            port.post({ type: "planProgress", job: request.job, message, fraction }, []);
          }
        });
        jobs.set(request.job, job);
        const layout2 = request.layout ? job.rawLayout() : void 0;
        port.post({ type: "plan", job: request.job, plan: job.plan, layout: layout2 }, layout2 ? [layout2.k.buffer] : []);
        return;
      }
      case "previewOpen": {
        const seq = parseSequenceBytes(new Uint8Array(request.bytes), request.name);
        const definition = seq.definitions.get("FOV");
        const fov = definition && definition.length >= 2 && definition.every((v) => Number.isFinite(+v)) ? [+definition[0], +definition[1], definition.length > 2 ? +definition[2] : 0] : null;
        previewSession = { id: request.id, trajectory: adcTrajectory(compileProgram(seq)), fov };
        return;
      }
      case "preview": {
        if (!previewSession || previewSession.id !== request.id) throw new Error("No preview session for this run.");
        const recon = reconstructCartesian(previewSession.trajectory, request.signal, request.coils, { fov: previewSession.fov });
        port.post({
          type: "preview",
          id: request.id,
          recon: {
            axes: recon.axes,
            nu: recon.nu,
            nv: recon.nv,
            delta: recon.delta,
            frames: recon.frames,
            wAxis: recon.wAxis,
            nw: recon.nw,
            deltaW: recon.deltaW,
            images: recon.images,
            kspace: recon.kspace
          }
        }, [recon.images.buffer, recon.kspace.buffer]);
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
        const layout2 = job.rawLayout();
        const transfer = [recon.images.buffer, recon.kspace.buffer];
        for (const stack of [recon.coilImages, recon.coilKspace]) {
          if (stack) transfer.push(stack.re.buffer, stack.im.buffer);
        }
        transfer.push(layout2.k.buffer);
        port.post({
          type: "recon",
          job: request.job,
          recon: {
            axes: recon.axes,
            nu: recon.nu,
            nv: recon.nv,
            delta: recon.delta,
            wAxis: recon.wAxis,
            nw: recon.nw,
            deltaW: recon.deltaW,
            frames: recon.frames,
            images: recon.images,
            kspace: recon.kspace,
            coilImages: recon.coilImages,
            coilKspace: recon.coilKspace,
            fill: recon.fill,
            offGridFraction: recon.offGridFraction,
            warnings: recon.warnings
          },
          // The phantom the job simulated (resolved coils included), for the Phantom view.
          phantom: job.phantom,
          layout: layout2
        }, transfer);
        return;
      }
      case "export": {
        const job = jobFor(request.job);
        const file = buildExport(job, request.signal, request.format);
        port.post({ type: "export", job: request.job, id: request.id, ...file }, [file.bytes.buffer]);
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
      const ids = request;
      port.post({ type: "error", job: ids.job ?? -1, id: ids.id ?? -1, message: errorMessage(error) }, []);
    }
  });
})();
