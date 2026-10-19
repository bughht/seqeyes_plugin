"""Generate the phantom-reader fixtures in this directory and expected.json.

    python test/fixtures/phantom-io/make_fixtures.py

Needs numpy, scipy, nibabel and h5py. The files are written by the reference
libraries themselves (np.save/np.savez, scipy.io.savemat, nibabel, h5py)
wherever those can produce the case; the rest are crafted here byte by byte:
big-endian MAT files, MATLAB's habit of storing a double array as miUINT8,
small data elements, object variables, ZIP64 central directories. Every
crafted file is read back with the reference library before its expected
values are recorded, so expected.json always holds what NumPy, SciPy or
nibabel make of the file, never what this script meant to write.

Output is deterministic (no randomness; zip, gzip and MAT timestamps are
pinned), so re-running it leaves git clean.
"""

import gzip
import io
import json
import math
import os
import struct
import time
import zipfile
import zlib
from contextlib import contextmanager
from unittest import mock

import h5py
import nibabel as nib
import numpy as np
import scipy.io
import scipy.sparse

HERE = os.path.dirname(os.path.abspath(__file__))
expected = {"npy": {}, "npz": {}, "mat": {}, "nifti": {}}


def path_of(name):
    return os.path.join(HERE, name)


def write_bytes(name, data):
    with open(path_of(name), "wb") as f:
        f.write(data)


def num(value):
    """A JSON-safe number: non-finite values become the strings JS's Number() parses."""
    value = float(value)
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    return value


def flat(values, order):
    return [num(v) for v in np.asarray(values).ravel(order=order)]


def array_entry(a, order, dtype):
    a = np.asarray(a)
    entry = {"dtype": dtype, "shape": list(a.shape), "order": order}
    if np.iscomplexobj(a):
        entry["data"] = flat(a.real, order)
        entry["imag"] = flat(a.imag, order)
    else:
        entry["data"] = flat(a.astype(np.float64), order)
    return entry


@contextmanager
def pinned_clock():
    """zipfile stamps members with time.localtime(time.time()); pin it to 2026-01-01."""
    fixed = time.struct_time((2026, 1, 1, 0, 0, 0, 3, 1, 0))
    with mock.patch("time.time", return_value=1767225600.0), mock.patch("time.localtime", return_value=fixed):
        yield


# ─── NPY ────────────────────────────────────────────────────────────────


def npy(name, a, version=None):
    buf = io.BytesIO()
    np.lib.format.write_array(buf, a, version=version)
    write_bytes(name, buf.getvalue())
    loaded = np.load(path_of(name))
    order = "F" if loaded.flags.f_contiguous and not loaded.flags.c_contiguous else "C"
    values = loaded
    if loaded.dtype == np.bool_:
        values = loaded.view(np.uint8) != 0
    expected["npy"][name] = array_entry(values, order, loaded.dtype.str)


def crafted_npy(name, header_text, data):
    """A version 1.0 file with a hand-written header dict, padded like NumPy pads."""
    header = header_text.encode("latin1")
    pad = 64 - (10 + len(header) + 1) % 64
    header += b" " * pad + b"\n"
    write_bytes(name, b"\x93NUMPY\x01\x00" + struct.pack("<H", len(header)) + header + data)


def make_npy():
    a = (np.arange(12) * 0.25 - 1.5).reshape(3, 4)
    npy("f8_c_2d.npy", a)
    npy("f4_f_3d.npy", np.asfortranarray((np.arange(60, dtype=np.float32) * 0.5 - 7).reshape(3, 4, 5)))
    npy("f8_be_specials.npy", np.array(
        [0.0, -0.0, 1.5, -2.25, np.nan, np.inf, -np.inf, 5e-324, 1.7976931348623157e308, 1 / 3], dtype=">f8"))
    npy("i2_be_2d.npy", np.array([[-32768, -1, 0], [1, 1234, 32767]], dtype=">i2"))
    npy("u1.npy", np.array([0, 1, 127, 128, 255], dtype="u1"))
    npy("i1.npy", np.array([-128, -1, 0, 1, 127], dtype="i1"))
    npy("u2.npy", np.array([0, 1, 65535, 40000], dtype="<u2"))
    npy("i4.npy", np.array([-2**31, -1, 0, 1, 2**31 - 1, 16777217], dtype="<i4"))
    npy("u4_be.npy", np.array([0, 1, 2**32 - 1, 3000000000], dtype=">u4"))
    npy("i8.npy", np.array([-2**63, -1, 0, 2**53 + 1, 2**63 - 1, 123456789012345], dtype="<i8"))
    npy("u8_be.npy", np.array([0, 2**64 - 1, 2**53, 42], dtype=">u8"))
    # NumPy treats any non-zero byte as True, including 2 and 255.
    npy("b1.npy", np.frombuffer(bytes([0, 1, 2, 255]), dtype=np.bool_).reshape(2, 2))
    npy("f2.npy", np.array(
        [0, -0.0, 1, -2, 0.5, 65504, 6.1e-5, 6e-8, np.inf, -np.inf, np.nan, 0.1], dtype="<f2"))
    npy("c8.npy", (np.arange(6) * 0.5 - 1 + 1j * (2 - np.arange(6) * 0.25)).astype("<c8").reshape(2, 3))
    npy("c16_be_f.npy", np.asfortranarray(
        (np.arange(12) * 0.75 - 4 - 1j * np.arange(12) * 0.125).reshape(2, 3, 2).astype(">c16")))
    npy("scalar.npy", np.array(3.5))
    npy("empty.npy", np.zeros((0, 3), dtype="<f4"))
    npy("v2_i2.npy", np.array([[1, -2], [3, -4]], dtype="<i2"), version=(2, 0))
    npy("v3_f8.npy", np.array([0.5, 1.5, 2.5]), version=(3, 0))

    # Headers NumPy itself does not write today: native '=' byte order, and a
    # Python 2 era header with long-integer suffixes and u'' strings.
    data = (np.arange(12) * 0.25 - 1.5).astype("<f8").tobytes()
    crafted_npy("native_order.npy", "{'descr': '=f8', 'fortran_order': False, 'shape': (3, 4), }", data)
    crafted_npy("py2_header.npy", "{u'descr': u'<f8', u'fortran_order': False, u'shape': (3L, 4L)}", data)
    # NumPy reads both (format._filter_header drops the L suffixes).
    expected["npy"]["native_order.npy"] = array_entry(np.load(path_of("native_order.npy")), "C", "=f8")
    expected["npy"]["py2_header.npy"] = array_entry(np.load(path_of("py2_header.npy")), "C", "<f8")

    # Unsupported dtypes, for the error paths.
    np.save(path_of("unicode.npy"), np.array(["ab", "c"]))
    np.save(path_of("object.npy"), np.array([1, "a", None], dtype=object), allow_pickle=True)
    np.save(path_of("structured.npy"), np.zeros(2, dtype=[("x", "<f4"), ("y", "<i2")]))
    np.save(path_of("datetime.npy"), np.array(["2020-01-01"], dtype="datetime64[D]"))


# ─── NPZ ────────────────────────────────────────────────────────────────


def npz_arrays():
    return {
        "PD_map": (np.arange(24) * 0.125).reshape(4, 3, 2),
        "T1_map": np.asfortranarray((np.arange(24, dtype=np.float32) * 0.25 + 0.5).reshape(4, 3, 2)),
        "mask": (np.arange(12) % 3 == 0).reshape(4, 3),
        "labels": np.array([-3, 0, 2, 7, 300], dtype=np.int16),
        "coil": (np.array([[1, 2], [3, 4]]) * 0.5 + 1j * np.array([[0, -1], [2, -3]])).astype(np.complex64),
        "FOV": np.array([0.2, 0.22, 0.004]),
        "B0": np.array(-12.5),
    }


def npz_entry(name):
    arrays = {}
    with np.load(path_of(name)) as loaded:
        for key in loaded.files:
            a = loaded[key]
            if not isinstance(a, np.ndarray):
                continue   # NpzFile hands back non-.npy members as raw bytes
            order = "F" if a.flags.f_contiguous and not a.flags.c_contiguous else "C"
            arrays[key] = array_entry(a.view(np.uint8) != 0 if a.dtype == np.bool_ else a, order, a.dtype.str)
    expected["npz"][name] = {"keys": list(arrays), "arrays": arrays}


def deflate_raw(data):
    c = zlib.compressobj(6, zlib.DEFLATED, -15)
    return c.compress(data) + c.flush()


def npy_bytes(a):
    buf = io.BytesIO()
    np.lib.format.write_array(buf, a)
    return buf.getvalue()


def zip64_archive(members):
    """Every central-directory size and offset in a ZIP64 extra field, and a
    ZIP64 end record, as writers produce for archives beyond 4 GB."""
    out = bytearray()
    central = bytearray()
    for name, payload, method in members:
        name = name.encode()
        crc = zlib.crc32(payload)
        data = payload if method == 0 else deflate_raw(payload)
        offset = len(out)
        local_extra = struct.pack("<HHQQ", 1, 16, len(payload), len(data))
        out += struct.pack("<IHHHHHIIIHH", 0x04034B50, 45, 0, method, 0, 0x21, crc,
                           0xFFFFFFFF, 0xFFFFFFFF, len(name), len(local_extra))
        out += name + local_extra + data
        cd_extra = struct.pack("<HHQQQ", 1, 24, len(payload), len(data), offset)
        central += struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 45, 45, 0, method, 0, 0x21, crc,
                               0xFFFFFFFF, 0xFFFFFFFF, len(name), len(cd_extra), 0, 0, 0, 0, 0xFFFFFFFF)
        central += name + cd_extra
    cd_offset = len(out)
    out += central
    record = len(out)
    out += struct.pack("<IQHHIIQQQQ", 0x06064B50, 44, 45, 45, 0, 0, len(members), len(members), len(central), cd_offset)
    out += struct.pack("<IIQI", 0x07064B50, 0, record, 1)
    out += struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, 0xFFFF, 0xFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0)
    return bytes(out)


def make_npz():
    with pinned_clock():
        np.savez(path_of("maps_stored.npz"), **npz_arrays())
        np.savez_compressed(path_of("maps_deflated.npz"), **npz_arrays())
    npz_entry("maps_stored.npz")
    npz_entry("maps_deflated.npz")

    write_bytes("zip64.npz", zip64_archive([
        ("a.npy", npy_bytes(np.array([[1.5, -2.0], [0.25, 8.0]])), 0),
        ("b.npy", npy_bytes(np.array([7, -8, 9], dtype=np.int16)), 8),
    ]))
    npz_entry("zip64.npz")

    # Non-.npy members (a directory, a text file) are ignored; a UTF-8 name is kept.
    stamp = (1980, 1, 1, 0, 0, 0)
    with zipfile.ZipFile(path_of("with_extras.npz"), "w") as z:
        z.writestr(zipfile.ZipInfo("PD_map.npy", stamp), npy_bytes(np.array([0.5, 1.0])))
        z.writestr(zipfile.ZipInfo("sub/", stamp), b"")
        z.writestr(zipfile.ZipInfo("notes.txt", stamp), b"not an array")
        z.writestr(zipfile.ZipInfo("µ_map.npy", stamp), npy_bytes(np.array([[3.0]])), compress_type=zipfile.ZIP_DEFLATED)
    npz_entry("with_extras.npz")

    with zipfile.ZipFile(path_of("bzip2.npz"), "w") as z:
        z.writestr(zipfile.ZipInfo("x.npy", stamp), npy_bytes(np.arange(4.0)), compress_type=zipfile.ZIP_BZIP2)


# ─── MAT ────────────────────────────────────────────────────────────────

MAT_HEADER_TEXT = b"MATLAB 5.0 MAT-file, Platform: fixture, Created on: Thu Jan  1 00:00:00 2026"


def savemat(name, variables, compress):
    scipy.io.savemat(path_of(name), variables, do_compression=compress)
    # The header text carries the platform and time of writing; pin both.
    with open(path_of(name), "r+b") as f:
        f.write(MAT_HEADER_TEXT.ljust(116, b" "))


def mat_variables():
    return {
        "dbl": (np.arange(12) * 0.5 - 2).reshape(3, 4),
        "sgl3": (np.arange(60, dtype=np.float32) * 0.25 - 3).reshape(3, 4, 5),
        "i16": np.array([[-300, 0, 7], [32767, -32768, 12]], dtype=np.int16),
        "u8": np.array([[0, 255, 7]], dtype=np.uint8),
        "i64": np.array([[-2**62, 2**53 + 1, 5]], dtype=np.int64),
        "u32": np.array([[4000000000, 1]], dtype=np.uint32),
        "mask": np.array([[True, False], [False, True], [True, True]]),
        "cplx": (np.arange(6) * 0.5 + 1j * (2 - np.arange(6))).reshape(2, 3),
        "csgl": (np.array([[1.5, -2], [0, 4]]) + 1j * np.array([[0.25, 0], [-1, 3]])).astype(np.complex64),
        "greeting": "hello",
        "rows": np.array(["ab", "cd", "ef"]),
        "empty": np.zeros((0, 0)),
        "x": np.array([[1.25]]),
        "i8s": np.int8(-5),
        "st": {"a": 1.0, "b": np.arange(3.0)},
        "cel": np.array([np.arange(2.0), "txt"], dtype=object),
        "sp": scipy.sparse.csc_matrix(np.eye(3)),
    }


def mat_entry(name, kinds):
    """Expected variables, as scipy.io.loadmat reads them back."""
    loaded = scipy.io.loadmat(path_of(name), squeeze_me=False, chars_as_strings=False, mat_dtype=False)
    variables = []
    for var, shape, cls in scipy.io.whosmat(path_of(name)):
        kind = kinds.get(var, "array")
        if kind == "skipped":
            variables.append({"name": var, "kind": "skipped", "class": cls})
            continue
        value = loaded[var]
        if kind == "text":
            # whosmat folds the string length away; the char array has MATLAB's shape.
            chars = np.asarray(value)
            rows = ["".join(r) for r in chars.reshape(chars.shape[0], -1)] if chars.size else []
            variables.append({"name": var, "kind": "text", "shape": list(chars.shape), "rows": rows})
            continue
        if value.dtype == np.bool_:
            cls = "logical"
        variables.append({"name": var, **array_entry(value.view(np.uint8) if value.dtype == np.bool_ else value, "F", cls),
                          "kind": "array", "class": cls})
    expected["mat"][name] = {"variables": variables}


MI = {"INT8": 1, "UINT8": 2, "INT16": 3, "UINT16": 4, "INT32": 5, "UINT32": 6, "SINGLE": 7, "DOUBLE": 9,
      "INT64": 12, "UINT64": 13, "MATRIX": 14, "COMPRESSED": 15, "UTF8": 16}
MX = {"cell": 1, "struct": 2, "char": 4, "double": 6, "single": 7, "uint8": 9, "int32": 12, "uint64": 15,
      "function_handle": 16, "opaque": 17}


def element(e, mtype, payload, small=True):
    """A data element; payloads of up to 4 bytes use the small format when allowed."""
    n = len(payload)
    if small and n <= 4:
        tag = struct.pack("<HH", mtype, n) if e == "<" else struct.pack(">HH", n, mtype)
        return tag + payload.ljust(4, b"\0")
    return struct.pack(e + "II", mtype, n) + payload + b"\0" * (-n % 8)


def matrix(e, name, cls, dims, parts=(), flags=0, compress=False, extra=b""):
    body = element(e, MI["UINT32"], struct.pack(e + "II", MX[cls] | flags, 0), small=False)
    if cls != "opaque":
        body += element(e, MI["INT32"], struct.pack(e + f"{len(dims)}i", *dims), small=False)
    body += element(e, MI["INT8"], name.encode())
    for mtype, payload in parts:
        body += element(e, MI[mtype], payload)
    body += extra
    out = struct.pack(e + "II", MI["MATRIX"], len(body)) + body
    if compress:
        packed = zlib.compress(out)
        out = struct.pack(e + "II", MI["COMPRESSED"], len(packed)) + packed
    return out


def mat_header(e):
    return MAT_HEADER_TEXT.ljust(116, b" ") + b"\0" * 8 + struct.pack(e + "H", 0x0100) + (b"IM" if e == "<" else b"MI")


def crafted_mat_variables(e, compress):
    """MATLAB-style storage: values in the smallest exact type, small elements, UTF-16 text."""
    p = lambda fmt, *values: struct.pack(e + fmt, *values)  # noqa: E731
    return [
        matrix(e, "dbl_u8", "double", [2, 3], [("UINT8", bytes([0, 1, 2, 253, 254, 255]))], compress=compress),
        matrix(e, "dbl_i16", "double", [1, 2], [("INT16", p("2h", -2, 300))], compress=compress),
        matrix(e, "cplx_mixed", "double", [2, 2],
               [("INT8", p("4b", -1, 2, -3, 4)), ("DOUBLE", p("4d", 0.5, -0.5, 1.5, 2.5))], flags=0x800, compress=compress),
        matrix(e, "sgl", "single", [2, 2], [("SINGLE", p("4f", 1.5, -0.25, 3.0, 1e-3))], compress=compress),
        matrix(e, "i32_as_i16", "int32", [1, 3], [("INT16", p("3h", -7, 0, 30000))], compress=compress),
        matrix(e, "u64", "uint64", [1, 2], [("UINT64", p("2Q", 2**64 - 1, 7))], compress=compress),
        matrix(e, "lg", "uint8", [1, 3], [("UINT8", bytes([1, 0, 1]))], flags=0x200, compress=compress),
        matrix(e, "txt", "char", [1, 4], [("UINT16", p("4H", 0xB5, 0x73, 0x20, 0x3A9))], compress=compress),
        matrix(e, "txt2", "char", [2, 3], [("UTF8", b"adbecf")], compress=compress),
    ]


def crafted_expected():
    variables = [
        {"name": "dbl_u8", "kind": "array", "class": "double", "dtype": "double", "shape": [2, 3], "order": "F",
         "data": [0, 1, 2, 253, 254, 255]},
        {"name": "dbl_i16", "kind": "array", "class": "double", "dtype": "double", "shape": [1, 2], "order": "F",
         "data": [-2, 300]},
        {"name": "cplx_mixed", "kind": "array", "class": "double", "dtype": "double", "shape": [2, 2], "order": "F",
         "data": [-1, 2, -3, 4], "imag": [0.5, -0.5, 1.5, 2.5]},
        {"name": "sgl", "kind": "array", "class": "single", "dtype": "single", "shape": [2, 2], "order": "F",
         "data": [num(np.float32(v)) for v in (1.5, -0.25, 3.0, 1e-3)]},
        {"name": "i32_as_i16", "kind": "array", "class": "int32", "dtype": "int32", "shape": [1, 3], "order": "F",
         "data": [-7, 0, 30000]},
        {"name": "u64", "kind": "array", "class": "uint64", "dtype": "uint64", "shape": [1, 2], "order": "F",
         "data": [num(2**64 - 1), 7]},
        {"name": "lg", "kind": "array", "class": "logical", "dtype": "logical", "shape": [1, 3], "order": "F",
         "data": [1, 0, 1]},
        {"name": "txt", "kind": "text", "shape": [1, 4], "rows": ["µs Ω"]},
        {"name": "txt2", "kind": "text", "shape": [2, 3], "rows": ["abc", "def"]},
    ]
    return variables


def check_crafted(name, variables, byte_order):
    """SciPy must read the crafted file to the values recorded for it.

    MATLAB chars are UTF-16 code units; SciPy decodes miUINT16 char data with
    `uint16_codec`, whose default (the system codec, low bytes only) loses
    anything beyond ASCII, so the file's own UTF-16 flavour is passed. Without
    mat_dtype, complex values keep their imaginary part.
    """
    codec = "utf-16-be" if byte_order == ">" else "utf-16-le"
    loaded = scipy.io.loadmat(path_of(name), squeeze_me=False, chars_as_strings=False, uint16_codec=codec)
    for v in variables:
        got = np.asarray(loaded[v["name"]])
        if v["kind"] == "text":
            rows = ["".join(r) for r in got]
            assert rows == v["rows"], (name, v["name"], ascii(rows))
            continue
        assert list(got.shape) == v["shape"], (name, v["name"], got.shape)
        real = (got.real if np.iscomplexobj(got) else got).astype(np.float64).ravel(order="F")
        want = np.array([float(x) for x in v["data"]])
        assert np.array_equal(real, want), (name, v["name"], real, want)
        if "imag" in v:
            assert np.array_equal(got.imag.ravel(order="F"), np.array(v["imag"])), (name, v["name"])


def make_mat():
    variables = mat_variables()
    kinds = {"greeting": "text", "rows": "text", "st": "skipped", "cel": "skipped", "sp": "skipped"}
    savemat("vars_v5.mat", variables, compress=False)
    savemat("vars_v7.mat", variables, compress=True)
    mat_entry("vars_v5.mat", kinds)
    mat_entry("vars_v7.mat", kinds)

    for name, e, compress in (("crafted_be.mat", ">", False), ("crafted_le_zlib.mat", "<", True)):
        write_bytes(name, mat_header(e) + b"".join(crafted_mat_variables(e, compress)))
        check_crafted(name, crafted_expected(), e)
        expected["mat"][name] = {"variables": crafted_expected()}

    # Variables the reader lists as skipped, MATLAB's unnamed subsystem
    # element (left out), and a plain variable after them.
    e = "<"
    after = matrix(e, "after", "double", [1, 1], [("DOUBLE", struct.pack("<d", 42.0))])
    empty_matrix = struct.pack("<II", MI["MATRIX"], 0)
    objects = [
        # Function handle: flags, dims, name, then the workspace (here empty).
        matrix(e, "fh", "function_handle", [1, 1], extra=empty_matrix),
        # Object (opaque class): flags, name, type system, class name, data.
        matrix(e, "obj", "opaque", [], extra=element(e, MI["INT8"], b"MCOS") + element(e, MI["INT8"], b"string") + empty_matrix),
        matrix(e, "", "uint8", [1, 8], [("UINT8", bytes(range(8)))]),
        after,
    ]
    write_bytes("objects.mat", mat_header(e) + b"".join(objects))
    # SciPy decodes these as a function handle, an opaque 'string' object, its
    # __function_workspace__ (the unnamed element) and the plain variable.
    loaded = scipy.io.loadmat(path_of("objects.mat"))
    assert isinstance(loaded["fh"], scipy.io.matlab.MatlabFunction)
    assert isinstance(loaded["obj"], scipy.io.matlab.MatlabOpaque) and loaded["obj"][0]["_Class"] == "string"
    assert loaded["__function_workspace__"].shape == (1, 8)
    assert loaded["after"].tolist() == [[42.0]]
    expected["mat"]["objects.mat"] = {"variables": [
        {"name": "fh", "kind": "skipped", "class": "function_handle"},
        {"name": "obj", "kind": "skipped", "class": "opaque"},
        {"name": "after", "kind": "array", "class": "double", "dtype": "double", "shape": [1, 1], "order": "F", "data": [42.0]},
    ]}

    # v7.3: HDF5 with MATLAB's 128-byte header in a 512-byte user block.
    with h5py.File(path_of("v73.mat"), "w", userblock_size=512) as f:
        f.create_dataset("x", data=np.arange(6.0).reshape(2, 3), track_times=False)
    with open(path_of("v73.mat"), "r+b") as f:
        text = b"MATLAB 7.3 MAT-file, Platform: fixture, Created on: Thu Jan  1 00:00:00 2026 HDF5 schema 1.00 ."
        f.write(text.ljust(116, b" ") + b"\0" * 8 + struct.pack("<H", 0x0200) + b"IM")
    scipy.io.savemat(path_of("v4.mat"), {"a": np.arange(4.0).reshape(2, 2)}, format="4")


# ─── NIfTI ──────────────────────────────────────────────────────────────

SPATIAL_TO_MM = {"unknown": 1.0, "mm": 1.0, "meter": 1000.0, "micron": 1e-3}
SPATIAL_TO_M = {"unknown": 1e-3, "mm": 1e-3, "meter": 1.0, "micron": 1e-6}


def rotation(axis, degrees):
    c, s = math.cos(math.radians(degrees)), math.sin(math.radians(degrees))
    i, j = [(1, 2), (2, 0), (0, 1)][axis]
    r = np.eye(3)
    r[i, i], r[i, j], r[j, i], r[j, j] = c, -s, s, c
    return r


def affine_of(r, zooms, offset):
    a = np.eye(4)
    a[:3, :3] = r @ np.diag(zooms)
    a[:3, 3] = offset
    return a


def write_single(name, header, data_bytes, compress=False):
    """Header, zeroed extension flag, then the voxels, as a single .nii file."""
    header["vox_offset"] = header.single_vox_offset
    buf = io.BytesIO()
    header.write_to(buf)
    buf.write(b"\0" * (header.single_vox_offset - buf.tell()))
    buf.write(data_bytes)
    write_bytes(name, buf.getvalue())
    if compress:
        write_gz(name + ".gz", buf.getvalue())


def write_gz(name, data, fname=None):
    buf = io.BytesIO()
    with gzip.GzipFile(filename=fname or "", mode="wb", fileobj=buf, mtime=0, compresslevel=6) as g:
        g.write(data)
    write_bytes(name, buf.getvalue())


def nifti_entry(name, source_file=None):
    """Expected image, as nibabel reads it (the affine converted to mm)."""
    # mmap=False: a memory-mapped file could not be removed on Windows.
    img = nib.load(path_of(source_file or name), mmap=False)
    hdr = img.header
    version = 2 if isinstance(hdr, nib.Nifti2Header) else 1
    spatial, temporal = hdr.get_xyzt_units()
    sform_code, qform_code = int(hdr["sform_code"]), int(hdr["qform_code"])
    if sform_code > 0:
        affine, source = hdr.get_sform(), "sform"
    elif qform_code > 0:
        affine, source = hdr.get_qform(), "qform"
    else:
        # Standard "method 1": pixdim scaling only (nibabel's fallback flips x).
        steps = [float(v) if float(v) != 0 else 1.0 for v in hdr["pixdim"][1:4]]
        affine, source = np.diag(steps + [1.0]), "pixdim"
    affine = np.array(affine, dtype=np.float64)
    affine[:3, :] *= SPATIAL_TO_MM[spatial]
    data = np.asarray(img.dataobj)  # scaled like get_fdata, but keeps complex
    pixdim = [float(v) for v in hdr["pixdim"]]
    steps = [abs(v) if v != 0 else 1.0 for v in pixdim[1:4]]
    # nib.load moves the scaling into img.dataobj and blanks it in img.header,
    # so read the stored scl_slope/scl_inter from a fresh copy of the header.
    with open(path_of(source_file or name), "rb") as f:
        raw = f.read()
    raw_header = type(hdr).from_fileobj(io.BytesIO(gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw))
    slope, inter = raw_header.get_slope_inter()   # (None, None) when unscaled
    entry = {
        **array_entry(data, "F", hdr.get_data_dtype().name),
        "version": version,
        "datatype": int(hdr["datatype"]),
        "littleEndian": hdr.endianness == "<",
        "pixdim": pixdim,
        "spatialUnits": spatial,
        "temporalUnits": temporal,
        "voxelSize": [s * SPATIAL_TO_M[spatial] for s in steps],
        "affine": [float(v) for v in affine.ravel()],
        "affineSource": source,
        "qformCode": qform_code,
        "sformCode": sform_code,
        "scaled": slope is not None,
        "intentName": hdr["intent_name"].item().decode("latin1"),
        "description": hdr["descrip"].item().decode("latin1"),
    }
    if slope is not None:
        entry["sclSlope"], entry["sclInter"] = float(slope), float(inter)
    expected["nifti"][name] = entry


def make_nifti():
    # NIfTI-1 float32 with a rotated, translated sform and a different qform.
    data = (np.arange(60, dtype=np.float32) * 0.5 - 10).reshape(4, 5, 3)
    sform = affine_of(rotation(2, 30) @ rotation(0, 10), [1.5, 2.0, 3.0], [-20.0, 15.5, 7.25])
    img = nib.Nifti1Image(data, sform)
    img.set_sform(sform, code=2)
    img.set_qform(affine_of(np.eye(3), [1.5, 2.0, 3.0], [1.0, 2.0, 3.0]), code=1)
    img.header.set_xyzt_units("mm", "sec")
    img.header["descrip"] = b"seqeyes fixture"
    img.header["intent_name"] = b"T1 map"
    nib.save(img, path_of("f32_sform.nii"))
    with open(path_of("f32_sform.nii"), "rb") as f:
        write_gz("f32_sform.nii.gz", f.read(), fname="f32_sform.nii")
    nifti_entry("f32_sform.nii")
    nifti_entry("f32_sform.nii.gz")

    # int16 with scl_slope/scl_inter, qform only, left-handed (qfac −1), microns.
    raw = (np.arange(24, dtype=np.int16) * 37 - 400).reshape(3, 4, 2)
    hdr = nib.Nifti1Header()
    hdr.set_data_dtype(np.int16)
    hdr.set_data_shape(raw.shape)
    left_handed = affine_of(rotation(0, 90) @ np.diag([1, 1, -1]), [250.0, 500.0, 1000.0], [-1000.0, 2500.0, 400.0])
    hdr.set_qform(left_handed, code=1)
    hdr["sform_code"] = 0
    hdr["scl_slope"], hdr["scl_inter"] = 0.5, -10.0
    hdr.set_xyzt_units("micron", "msec")
    write_single("i16_scaled_qform.nii", hdr, raw.tobytes(order="F"), compress=True)
    nifti_entry("i16_scaled_qform.nii")
    nifti_entry("i16_scaled_qform.nii.gz")

    # Big-endian NIfTI-1, 4-D float64, sform only, metres.
    vol = (np.arange(36) * 0.125 - 2).reshape(3, 2, 2, 3)
    hdr = nib.Nifti1Header(endianness=">")
    hdr.set_data_dtype(np.float64)
    hdr.set_data_shape(vol.shape)
    hdr.set_sform(affine_of(rotation(1, -20), [0.002, 0.003, 0.004], [0.1, -0.05, 0.02]), code=4)
    hdr["qform_code"] = 0
    hdr.set_zooms((0.002, 0.003, 0.004, 2.5))
    hdr.set_xyzt_units("meter", "sec")
    write_single("be_f64_4d.nii", hdr, vol.astype(">f8").tobytes(order="F"))
    nifti_entry("be_f64_4d.nii")

    # NIfTI-2 float64, sform and a different qform.
    vol2 = (np.arange(18) * 1.5 - 4).reshape(3, 3, 2)
    img2 = nib.Nifti2Image(vol2, affine_of(rotation(2, -45), [0.9, 0.9, 2.5], [5.0, -6.0, 7.0]))
    img2.set_qform(affine_of(np.eye(3), [0.9, 0.9, 2.5], [0.0, 0.0, 0.0]), code=1)
    img2.header.set_xyzt_units("mm", "unknown")
    nib.save(img2, path_of("n2_f64.nii"))
    nifti_entry("n2_f64.nii")

    # NIfTI-2, big-endian complex64, gzipped.
    cplx = ((np.arange(12) - 5) * 0.5 + 1j * (np.arange(12) * 0.25)).astype(np.complex64).reshape(2, 3, 2)
    hdr = nib.Nifti2Header(endianness=">")
    hdr.set_data_dtype(np.complex64)
    hdr.set_data_shape(cplx.shape)
    hdr.set_sform(affine_of(np.eye(3), [2.0, 2.0, 2.0], [-2.0, -3.0, -1.0]), code=1)
    hdr.set_xyzt_units("mm", "sec")
    write_single("n2_be_c64.nii", hdr, cplx.astype(">c8").tobytes(order="F"))
    with open(path_of("n2_be_c64.nii"), "rb") as f:
        write_gz("n2_be_c64.nii.gz", f.read())
    nifti_entry("n2_be_c64.nii.gz", "n2_be_c64.nii")
    os.remove(path_of("n2_be_c64.nii"))

    # 2-D uint8 without qform or sform: pixdim scaling, unknown units.
    hdr = nib.Nifti1Header()
    hdr.set_data_dtype(np.uint8)
    hdr.set_data_shape((4, 3))
    hdr["pixdim"][1:3] = [0.8, 1.2]
    hdr["qform_code"], hdr["sform_code"] = 0, 0
    write_single("u8_noaffine.nii", hdr, (np.arange(12, dtype=np.uint8) * 20).reshape(4, 3).tobytes(order="F"))
    nifti_entry("u8_noaffine.nii")

    # One small image per remaining datatype (Python ints, so uint64 values
    # beyond the int64 range do not overflow on the way in).
    base = [-3, 0, 5, 120]
    for dtype, values in (("int8", base), ("uint16", [v * 500 + 2000 for v in base]),
                          ("int32", [v * 10**7 for v in base]), ("uint32", [v * 10**7 + 3 * 10**9 for v in base]),
                          ("int64", [v * 10**15 + 1 for v in base]), ("uint64", [v * 10**15 + 2**63 for v in base]),
                          ("complex128", [v * 0.5 + 1j * (v - 1) for v in base]),
                          ("float64", [v / 3 for v in base])):
        a = np.array(values, dtype=dtype).reshape(2, 2, 1)
        img = nib.Nifti1Image(a, np.eye(4), dtype=dtype)
        nib.save(img, path_of(f"dt_{dtype}.nii"))
        nifti_entry(f"dt_{dtype}.nii")

    # Unsupported: RGB24 voxels, and the .hdr half of a .hdr/.img pair.
    rgb = np.zeros((2, 2, 1), dtype=[("R", "u1"), ("G", "u1"), ("B", "u1")])
    nib.save(nib.Nifti1Image(rgb, np.eye(4)), path_of("rgb24.nii"))
    nib.save(nib.Nifti1Pair(np.zeros((2, 2, 2), dtype=np.float32), np.eye(4)), path_of("pair.hdr"))
    os.remove(path_of("pair.img"))


def main():
    make_npy()
    make_npz()
    make_mat()
    make_nifti()
    # One line per fixture: compact, and a regenerated fixture shows up as a one-line diff.
    sections = []
    for section, entries in expected.items():
        lines = [f"  {json.dumps(name)}: {json.dumps(entry, ensure_ascii=False, allow_nan=False)}" for name, entry in entries.items()]
        sections.append(f" {json.dumps(section)}: {{\n" + ",\n".join(lines) + "\n }")
    with open(path_of("expected.json"), "w", encoding="utf-8", newline="\n") as f:
        f.write("{\n" + ",\n".join(sections) + "\n}\n")
    for name in sorted(os.listdir(HERE)):
        print(f"{os.path.getsize(path_of(name)):>8}  {name}")


if __name__ == "__main__":
    main()
