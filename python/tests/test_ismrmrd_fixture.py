"""
Reads the ISMRMRD raw-data fixtures written by the simulator's TypeScript
exporter (src/sim/io/ismrmrd.ts) with ismrmrd-python and h5py, so a change in
the writer, or in the readers, that breaks interchange fails here.

The fixtures live in test/fixtures/ismrmrd; regenerate them with
``UPDATE_FIXTURES=1 npx vitest run test/sim/io``. expected.json lists every
value: 64-bit integers as decimal strings, floats as the stored float32 values.

Set ISMRMRD_XSD to a copy of ismrmrd.xsd (and install xmlschema) to also
validate the XML header against the schema.
"""
from __future__ import annotations

import ctypes
import hashlib
import io
import json
import os
import shutil
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")
h5py = pytest.importorskip("h5py")
ismrmrd = pytest.importorskip("ismrmrd")
pytest.importorskip("ismrmrd.serialization")
pytest.importorskip("ismrmrd.xsd")

FIXTURES = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "ismrmrd"
if not (FIXTURES / "expected.json").exists():
    pytest.skip("the ISMRMRD fixtures are only in the source tree", allow_module_level=True)

EXPECTED = json.loads((FIXTURES / "expected.json").read_text(encoding="utf-8"))
ACQUISITIONS = EXPECTED["acquisitions"]
XML = EXPECTED["xml"]


def expected_head_bytes(head: dict) -> bytes:
    """The 340 bytes of ISMRMRD_AcquisitionHeader that `head` describes."""
    record = np.zeros((), dtype=ismrmrd.hdf5.acquisition_header_dtype)
    for name in record.dtype.names:
        value = head[name]
        if name == "idx":
            for counter in record["idx"].dtype.names:
                record["idx"][counter] = value[counter]
        elif name == "flags":
            record[name] = int(value)
        elif name == "channel_mask":
            record[name] = [int(word) for word in value]
        else:
            record[name] = value
    return record.tobytes()


def check_acquisition(acquisition, expected: dict, where: str) -> None:
    head = expected["head"]
    assert bytes(acquisition.getHead()) == expected_head_bytes(head), where
    # Field by field too, through the library's own accessors.
    assert acquisition.version == head["version"]
    assert acquisition.flags == int(head["flags"])
    assert acquisition.measurement_uid == head["measurement_uid"]
    assert acquisition.scan_counter == head["scan_counter"]
    assert acquisition.number_of_samples == head["number_of_samples"]
    assert acquisition.active_channels == head["active_channels"]
    assert acquisition.available_channels == head["available_channels"]
    assert acquisition.trajectory_dimensions == head["trajectory_dimensions"]
    assert acquisition.center_sample == head["center_sample"]
    assert [int(word) for word in acquisition.channel_mask] == [int(word) for word in head["channel_mask"]]
    assert list(acquisition.physiology_time_stamp) == head["physiology_time_stamp"]
    assert list(acquisition.position) == head["position"]
    assert list(acquisition.read_dir) == head["read_dir"]
    assert list(acquisition.user_int) == head["user_int"]
    assert list(acquisition.user_float) == head["user_float"]
    idx = acquisition.idx
    for counter in ("kspace_encode_step_1", "kspace_encode_step_2", "average", "slice", "contrast",
                    "phase", "repetition", "set", "segment"):
        assert getattr(idx, counter) == head["idx"][counter], (where, counter)
    assert list(idx.user) == head["idx"]["user"]

    channels, samples, dims = head["active_channels"], head["number_of_samples"], head["trajectory_dimensions"]
    data = np.asarray(acquisition.data)
    assert data.dtype == np.complex64
    assert data.shape == (channels, samples)
    # Interleaved re, im; channel-major.
    want = np.array(expected["data"], dtype=np.float32).view(np.complex64).reshape(channels, samples)
    np.testing.assert_array_equal(data, want)
    traj = np.asarray(acquisition.traj)
    assert traj.shape == (samples, dims)
    np.testing.assert_array_equal(traj, np.array(expected["traj"], dtype=np.float32).reshape(samples, dims))


@pytest.fixture
def h5_copy(tmp_path: Path) -> Path:
    # ismrmrd.Dataset(create_if_needed=False) opens read-write, so never on the committed file.
    path = tmp_path / "small.h5"
    shutil.copy(FIXTURES / "small.h5", path)
    return path


def test_dataset_reads_header_and_every_acquisition(h5_copy: Path):
    before = hashlib.sha256(h5_copy.read_bytes()).hexdigest()
    dataset = ismrmrd.Dataset(str(h5_copy), "dataset", create_if_needed=False)
    try:
        xml = dataset.read_xml_header()
        assert (xml.decode("utf-8") if isinstance(xml, bytes) else xml) == XML
        assert dataset.number_of_acquisitions() == len(ACQUISITIONS)
        for i, expected in enumerate(ACQUISITIONS):
            check_acquisition(dataset.read_acquisition(i), expected, f"acquisition {i}")
        last = dataset.read_acquisition(len(ACQUISITIONS) - 1)
        assert last.is_flag_set(ismrmrd.ACQ_LAST_IN_MEASUREMENT)
        assert last.is_flag_set(ismrmrd.ACQ_USER8)
        assert dataset.read_acquisition(0).is_flag_set(ismrmrd.ACQ_IS_NOISE_MEASUREMENT)
    finally:
        dataset.close()
    # Opening read-write and closing without changes leaves the file as written.
    assert hashlib.sha256(h5_copy.read_bytes()).hexdigest() == before


def test_flag_bits_match_the_library():
    for name, bit in EXPECTED["flags"].items():
        assert getattr(ismrmrd, f"ACQ_{name}") == bit, name


def test_h5py_sees_the_ismrmrd_types():
    with h5py.File(FIXTURES / "small.h5", "r") as f:
        assert list(f.keys()) == ["dataset"]
        assert sorted(f["dataset"].keys()) == ["data", "xml"]
        data = f["dataset/data"]
        assert data.shape == (len(ACQUISITIONS),)
        assert data.dtype.names == ("head", "traj", "data")
        assert data.dtype["head"] == ismrmrd.hdf5.acquisition_header_dtype
        assert data.dtype["head"]["idx"] == ismrmrd.hdf5.encoding_counters_dtype
        assert data.dtype["head"].itemsize == 340
        assert h5py.check_vlen_dtype(data.dtype["traj"]) == np.dtype("float32")
        assert h5py.check_vlen_dtype(data.dtype["data"]) == np.dtype("float32")
        rows = data[()]
        for row, expected in zip(rows, ACQUISITIONS):
            assert row["head"].tobytes() == expected_head_bytes(expected["head"])
            np.testing.assert_array_equal(row["traj"], np.array(expected["traj"], dtype=np.float32))
            np.testing.assert_array_equal(row["data"], np.array(expected["data"], dtype=np.float32))

        xml = f["dataset/xml"]
        assert xml.shape == (1,)
        info = h5py.check_string_dtype(xml.dtype)
        assert info is not None and info.length is None and info.encoding == "ascii"
        value = xml[0]
        assert (value.decode("utf-8") if isinstance(value, bytes) else value) == XML


def test_reads_as_the_c_library_reads():
    """
    The ISMRMRD C library reads into its own structs: HDF5_Acquisition (head,
    then hvl_t traj and data at offsets 344 and 360, size 376) and a char* for
    the XML through an ASCII H5T_C_S1 string type. libhdf5 converts by member
    name and refuses ASCII <-> UTF-8 string conversion, so both must work.
    """
    c_layout = np.dtype({
        "names": ["head", "traj", "data"],
        "formats": [ismrmrd.hdf5.acquisition_header_dtype, h5py.vlen_dtype(np.float32), h5py.vlen_dtype(np.float32)],
        "offsets": [0, 344, 360],
        "itemsize": 376,
    })
    with h5py.File(FIXTURES / "small.h5", "r") as f:
        rows = f["dataset/data"].astype(c_layout)[()]
        for row, expected in zip(rows, ACQUISITIONS):
            assert row["head"].tobytes() == expected_head_bytes(expected["head"])
            np.testing.assert_array_equal(row["data"], np.array(expected["data"], dtype=np.float32))

        c_string = h5py.h5t.C_S1.copy()
        c_string.set_size(h5py.h5t.VARIABLE)
        c_string.set_cset(h5py.h5t.CSET_ASCII)
        pointer = np.zeros((1,), dtype=np.uintp)
        f["dataset/xml"].id.read(h5py.h5s.ALL, h5py.h5s.ALL, pointer, mtype=c_string)
        assert ctypes.string_at(int(pointer[0])).decode("ascii") == XML


def acquisition_messages(stream: bytes) -> bytes:
    """The stream after its header message, up to (not including) the close message."""
    length = int.from_bytes(stream[2:6], "little")
    return stream[6 + length:-2]


def test_stream_round_trip():
    from ismrmrd.serialization import ProtocolDeserializer, ProtocolSerializer

    stream = (FIXTURES / "small.stream").read_bytes()
    assert int.from_bytes(stream[:2], "little") == 3  # HEADER
    assert int.from_bytes(stream[-2:], "little") == 4  # CLOSE
    with ProtocolDeserializer(io.BytesIO(stream)) as reader:
        messages = list(reader.deserialize())
    header, acquisitions = messages[0], messages[1:]
    assert isinstance(header, ismrmrd.xsd.ismrmrdHeader)
    assert header.experimentalConditions.H1resonanceFrequency_Hz == 123259792
    assert len(acquisitions) == len(ACQUISITIONS)
    for i, (acquisition, expected) in enumerate(zip(acquisitions, ACQUISITIONS)):
        assert isinstance(acquisition, ismrmrd.Acquisition)
        check_acquisition(acquisition, expected, f"stream acquisition {i}")

    # ProtocolSerializer writes the same acquisition messages and close message.
    out = io.BytesIO()
    with ProtocolSerializer(out) as writer:
        for acquisition in acquisitions:
            writer.serialize(acquisition)
    reserialized = out.getvalue()
    assert reserialized[:-2] == acquisition_messages(stream)
    assert reserialized[-2:] == stream[-2:]


def test_xml_header_parses_with_the_schema_bindings():
    header = ismrmrd.xsd.CreateFromDocument(XML)
    assert header.version is None
    assert header.experimentalConditions.H1resonanceFrequency_Hz == 123259792
    system = header.acquisitionSystemInformation
    assert (system.systemVendor, system.systemModel, system.receiverChannels) == ("SeqEyes", "Bloch simulator", 2)
    assert system.systemFieldStrength_T == pytest.approx(2.89362)
    measurement = header.measurementInformation
    assert measurement.patientPosition.value == "HFS"
    assert measurement.protocolName == "SeqEyes <fixture> & \"radial\" 'test'"
    (encoding,) = header.encoding
    assert (encoding.encodedSpace.matrixSize.x, encoding.encodedSpace.matrixSize.y, encoding.encodedSpace.matrixSize.z) == (16, 3, 1)
    assert encoding.reconSpace.fieldOfView_mm.x == pytest.approx(128.5)
    assert encoding.trajectory.value == "radial"
    limits = encoding.encodingLimits
    assert (limits.kspace_encoding_step_1.minimum, limits.kspace_encoding_step_1.maximum,
            limits.kspace_encoding_step_1.center) == (0, 2, 1)
    assert limits.kspace_encoding_step_2 is None
    sequence = header.sequenceParameters
    assert sequence.TR == [8.5] and sequence.TE == [3.1, 6.2] and sequence.flipAngle_deg == [15.0]
    assert sequence.sequence_type == "Flash"
    user = header.userParameters
    assert [(p.name, p.value) for p in user.userParameterLong] == [("seed", 2026), ("big", 9007199254740993)]
    assert [(p.name, p.value) for p in user.userParameterDouble] == [("B0_T", 2.89362)]
    assert [(p.name, p.value) for p in user.userParameterString] == [("sequence", "radial é.seq")]


@pytest.mark.skipif(not os.environ.get("ISMRMRD_XSD"), reason="set ISMRMRD_XSD to ismrmrd.xsd to validate against the schema")
def test_xml_header_is_valid_against_the_xsd():
    xmlschema = pytest.importorskip("xmlschema")
    schema = xmlschema.XMLSchema(os.environ["ISMRMRD_XSD"])
    schema.validate(XML)


def test_libhdf5_can_modify_the_file(h5_copy: Path):
    """Rewriting an acquisition and the header and adding images exercises heap and header growth."""
    replacement = ismrmrd.Acquisition.from_array(
        (np.arange(80, dtype=np.float32).reshape(2, 40) + 1j).astype(np.complex64),
        np.zeros((40, 2), dtype=np.float32),
        scan_counter=99,
    )
    with ismrmrd.Dataset(str(h5_copy), "dataset", create_if_needed=False) as dataset:
        dataset.write_acquisition(replacement, 1)
        dataset.write_xml_header(XML.replace("Flash", "Flash" * 100).encode("ascii"))
        image = ismrmrd.Image.from_array(np.ones((4, 4), dtype=np.float32))
        dataset.append_image("image_0", image)
        dataset.append_image("image_0", image)
    with ismrmrd.Dataset(str(h5_copy), "dataset", create_if_needed=False) as dataset:
        assert dataset.number_of_acquisitions() == len(ACQUISITIONS)
        rewritten = dataset.read_acquisition(1)
        assert rewritten.scan_counter == 99
        np.testing.assert_array_equal(rewritten.data, replacement.data)
        for i in (0, 2, 3):
            check_acquisition(dataset.read_acquisition(i), ACQUISITIONS[i], f"acquisition {i}")
        assert b"FlashFlash" in dataset.read_xml_header()
        assert dataset.number_of_images("image_0") == 2
