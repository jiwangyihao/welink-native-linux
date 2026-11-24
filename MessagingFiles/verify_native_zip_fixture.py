#!/usr/bin/env python3
"""Synthetic fixtures and independent readers for the native-tools ABI proof.

Requires Python 3, Info-ZIP's zip, and a sparse-capable temporary filesystem
with 2 GiB + 65,573 bytes + 64 MiB free. The source is sparse; command 18's
copy is allowed to be dense and is removed before the archive is created.
All readers use 1 MiB chunks; this subprocess has a 256 MiB address-space cap.
"""
import json
import os
from pathlib import Path
import resource
import stat
import struct
import subprocess
import sys
import zipfile
import zlib

LARGE_SIZE = (1 << 31) + 65573
CHUNK_SIZE = 1 << 20
MARKERS = (
    (0, b"native-tools sparse stream\x00\xff\n"),
    ((1 << 31) - 128, bytes(range(256))),
    (LARGE_SIZE - 20, b"past-2GiB-tail\x00\xff-end"),
)


def verify_stream(stream):
    offset = 0
    while offset < LARGE_SIZE:
        length = min(CHUNK_SIZE, LARGE_SIZE - offset)
        expected = bytearray(length)
        for position, marker in MARKERS:
            start, end = max(offset, position), min(offset + length, position + len(marker))
            if start < end:
                expected[start - offset:end - offset] = marker[start - position:end - position]
        data = stream.read(length)
        assert data == expected, f"stream content mismatch at {offset}"
        offset += len(data)
    assert stream.read(1) == b"", "unexpected trailing bytes"
    return offset


def zip64_archive(data):
    end_offset = data.rfind(b"PK\x05\x06")
    assert end_offset >= 0
    count = struct.unpack_from("<H", data, end_offset + 10)[0]
    size, offset = struct.unpack_from("<II", data, end_offset + 12)
    comment_length = struct.unpack_from("<H", data, end_offset + 20)[0]
    assert end_offset + 22 + comment_length == len(data)
    extended = struct.pack("<4sQHHIIQQQQ", b"PK\x06\x06", 44, 45, 45, 0, 0, count, count, size, offset)
    locator = struct.pack("<4sIQI", b"PK\x06\x07", 0, end_offset, 1)
    end = bytearray(data[end_offset:])
    struct.pack_into("<HHII", end, 8, 0xffff, 0xffff, 0xffffffff, 0xffffffff)
    return data[:end_offset] + extended + locator + end, end_offset


def create_fixtures(root):
    space = os.statvfs(root)
    assert space.f_bavail * space.f_frsize >= LARGE_SIZE + (64 << 20), (
        "native ZIP/copy verification needs a sparse filesystem with "
        "at least 2 GiB + 65,573 bytes + 64 MiB free; set TMPDIR accordingly"
    )
    fixtures = root / "fixtures"
    fixtures.mkdir(mode=0o700)
    first = '{"contentType":1,"sendTime":17,"text":"synthetic first message"}\n'
    second = '{"contentType":1,"sendTime":18,"text":"第二条合成消息"}\n'
    cases = {
        "trailing-directories.zip": [("messages.jsonl", first), ("empty-directory/", "")],
        "mixed-directories.zip": [
            ("leading/", ""), ("messages-1.jsonl", first), ("between/", ""),
            ("messages-2.jsonl", second), ("trailing/", ""), ("trailing/nested/", ""),
        ],
        "replacement-two-files.zip": [("messages-1.jsonl", second), ("messages-2.jsonl", first)],
        "empty.zip": [],
        "empty-comment.zip": [],
        "empty-max-comment.zip": [],
        "files-max-comment.zip": [("messages.jsonl", first), ("trailing/", "")],
        "directory-only.zip": [("empty/", ""), ("empty/nested/", "")],
        "empty-file.zip": [("empty.jsonl", ""), ("trailing/", "")],
    }
    valid = []
    comments = {
        "empty-comment.zip": b"synthetic ZIP comment",
        "empty-max-comment.zip": b"x" * 65535,
        "files-max-comment.zip": b"x" * 65535,
    }
    for name, entries in cases.items():
        with zipfile.ZipFile(fixtures / name, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.comment = comments.get(name, b"")
            for entry, content in entries:
                archive.writestr(entry, content)
        valid.append({"file": name, "streams": [content for entry, content in entries if not entry.endswith("/")]})

    # Keep headers intact so only reading the payload can detect its bad CRC.
    damaged = fixtures / "bad-crc.zip"
    with zipfile.ZipFile(damaged, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("messages.jsonl", first * 128)
        archive.writestr("trailing/", "")
    original = damaged.read_bytes()
    name_length, extra_length = struct.unpack_from("<HH", original, 26)
    data_offset = 30 + name_length + extra_length
    corrupt = bytearray(original)
    corrupt[data_offset + 7] ^= 0x40
    damaged.write_bytes(corrupt)
    with zipfile.ZipFile(damaged) as archive:
        try:
            archive.read("messages.jsonl")
        except zipfile.BadZipFile:
            pass
        else:
            raise AssertionError("bad-CRC fixture unexpectedly passed its independent reader")
    (fixtures / "truncated-payload.zip").write_bytes(original[:data_offset + 17])
    # A damaged empty-archive record must not be mistaken for clean empty EOF.
    empty = (fixtures / "empty.zip").read_bytes()
    assert len(empty) == 22, "valid minimal empty ZIP must keep its EOCD at offset zero"
    (fixtures / "truncated-empty.zip").write_bytes(empty[:10])
    end_damage = []
    for length in range(4, 22):
        if length == 10:
            continue  # Keep the originally evidenced fixture under its existing name.
        name = f"truncated-end-{length}.zip"
        (fixtures / name).write_bytes(empty[:length])
        end_damage.append(name)
    for source, name in (
        ("empty-comment.zip", "truncated-comment.zip"),
        ("empty-max-comment.zip", "truncated-max-comment.zip"),
        ("directory-only.zip", "truncated-directory-end.zip"),
        ("trailing-directories.zip", "truncated-nonempty-end.zip"),
    ):
        (fixtures / name).write_bytes((fixtures / source).read_bytes()[:-1])
        end_damage.append(name)

    directory_damage = []

    def damage(name, source, changes):
        data = bytearray(source)
        for fmt, offset, value in changes:
            struct.pack_into(fmt, data, offset, value)
        (fixtures / name).write_bytes(data)
        directory_damage.append(name)

    # A full-length footer is not enough: its directory count and extent must
    # describe real central records, including directories rather than files only.
    damage("empty-count-mismatch.zip", empty, [("<H", 8, 1), ("<H", 10, 1)])
    dirs = (fixtures / "directory-only.zip").read_bytes()
    end_offset = len(dirs) - 22
    dir_size, dir_offset = struct.unpack_from("<II", dirs, end_offset + 12)
    damage("directory-count-mismatch.zip", dirs, [("<H", end_offset + 8, 0), ("<H", end_offset + 10, 0)])
    damage("directory-count-high.zip", dirs, [("<H", end_offset + 8, 3), ("<H", end_offset + 10, 3)])
    damage("directory-size-mismatch.zip", dirs, [("<I", end_offset + 12, dir_size + 1)])
    damage("directory-offset-mismatch.zip", dirs, [("<I", end_offset + 16, dir_offset + 1)])
    damage("directory-disk-count-mismatch.zip", dirs, [("<H", end_offset + 8, 1)])

    zip64_offsets = {}
    for source, name in (
        ("empty.zip", "zip64-empty.zip"),
        ("directory-only.zip", "zip64-directory-only.zip"),
        ("mixed-directories.zip", "zip64-files.zip"),
        ("files-max-comment.zip", "zip64-long-comment.zip"),
    ):
        data, record_offset = zip64_archive((fixtures / source).read_bytes())
        (fixtures / name).write_bytes(data)
        with zipfile.ZipFile(fixtures / name) as archive:
            assert len(archive.infolist()) == len(cases[source])
            assert archive.testzip() is None
        valid.append({"file": name, "streams": [content for entry, content in cases[source] if not entry.endswith("/")]})
        zip64_offsets[name] = record_offset

    zip64_empty = (fixtures / "zip64-empty.zip").read_bytes()
    record_offset = zip64_offsets["zip64-empty.zip"]
    damage("zip64-empty-count-mismatch.zip", zip64_empty,
           [("<Q", record_offset + 24, 1), ("<Q", record_offset + 32, 1)])
    zip64_dirs = (fixtures / "zip64-directory-only.zip").read_bytes()
    record_offset = zip64_offsets["zip64-directory-only.zip"]
    damage("zip64-directory-count-mismatch.zip", zip64_dirs,
           [("<Q", record_offset + 24, 0), ("<Q", record_offset + 32, 0)])
    damage("zip64-directory-size-mismatch.zip", zip64_dirs, [("<Q", record_offset + 40, dir_size + 1)])
    damage("zip64-directory-offset-mismatch.zip", zip64_dirs, [("<Q", record_offset + 48, dir_offset + 1)])
    damage("zip64-locator-offset-mismatch.zip", zip64_dirs, [("<Q", record_offset + 56 + 8, record_offset + 1)])
    damage("zip64-record-size-mismatch.zip", zip64_dirs, [("<Q", record_offset + 4, 45)])
    damage("zip64-classic-count-mismatch.zip", zip64_dirs, [("<H", len(zip64_dirs) - 22 + 10, 1)])

    prefixed = "prepended-data.zip"
    (fixtures / prefixed).write_bytes(b"MZ" + b"\x00" * 126 + (fixtures / "trailing-directories.zip").read_bytes())
    with zipfile.ZipFile(fixtures / prefixed) as archive:
        assert archive.read("messages.jsonl") == first.encode()
        assert archive.testzip() is None
    valid.append({"file": prefixed, "streams": [first]})
    for name, file_type, content in (
        ("unsupported-link.zip", stat.S_IFLNK, "../not-a-regular-file"),
        ("unsupported-link-long-comment.zip", stat.S_IFLNK, "../not-a-regular-file"),
        ("unsupported-fifo.zip", stat.S_IFIFO, ""),
        ("unsupported-fifo-long-comment.zip", stat.S_IFIFO, ""),
        ("unsupported-character-long-comment.zip", stat.S_IFCHR, ""),
        ("unsupported-block-long-comment.zip", stat.S_IFBLK, ""),
        ("unsupported-socket-long-comment.zip", stat.S_IFSOCK, ""),
    ):
        with zipfile.ZipFile(fixtures / name, "w") as archive:
            if name.endswith("-long-comment.zip"):
                archive.comment = b"x" * 65535
            entry = zipfile.ZipInfo("link")
            entry.create_system = 3
            entry.external_attr = (file_type | 0o777) << 16
            archive.writestr(entry, content)
    zip64_link, _ = zip64_archive((fixtures / "unsupported-link-long-comment.zip").read_bytes())
    (fixtures / "unsupported-link-zip64-long-comment.zip").write_bytes(zip64_link)

    # The local filename alone says "regular file"; only the central Unix mode
    # identifies this trailing directory. Long comments must not change its type.
    central_types = "central-types-long-comment.zip"
    with zipfile.ZipFile(fixtures / central_types, "w") as archive:
        archive.comment = b"x" * 65535
        archive.writestr("messages.jsonl", first)
        directory = zipfile.ZipInfo("directory-without-slash")
        directory.create_system = 3
        directory.external_attr = (stat.S_IFDIR | 0o755) << 16
        archive.writestr(directory, "")
    with zipfile.ZipFile(fixtures / central_types) as archive:
        assert stat.S_ISDIR(archive.getinfo("directory-without-slash").external_attr >> 16)
        assert archive.read("messages.jsonl") == first.encode()
        assert archive.testzip() is None
    valid.append({"file": central_types, "streams": [first]})

    legacy_modes = "legacy-modes-long-comment.zip"
    legacy_entries = (
        ("unix-zero-mode.jsonl", 3, 0x20, first),
        ("unix-permissions.jsonl", 3, 0o600 << 16, second),
        ("unix-regular.jsonl", 3, (stat.S_IFREG | 0o600) << 16, first),
        ("unix-legacy-directory/", 3, 0o700 << 16, ""),
        ("dos-regular.jsonl", 0, ((stat.S_IFIFO | 0o600) << 16) | 0x20, second),
        ("dos-directory", 0, ((stat.S_IFIFO | 0o700) << 16) | 0x10, ""),
        ("legacy-os.jsonl", 10, ((stat.S_IFIFO | 0o600) << 16) | 0x20, first),
    )
    with zipfile.ZipFile(fixtures / legacy_modes, "w") as archive:
        archive.comment = b"x" * 65535
        for name, creator, attributes, content in legacy_entries:
            entry = zipfile.ZipInfo(name)
            entry.create_system = creator
            entry.external_attr = attributes
            archive.writestr(entry, content)
    # ZipFile supplies default permissions for an entirely zero attribute word.
    # Clear the first central record's attributes explicitly to retain that case.
    legacy_data = bytearray((fixtures / legacy_modes).read_bytes())
    end_offset = len(legacy_data) - 65535 - 22
    central_offset = struct.unpack_from("<I", legacy_data, end_offset + 16)[0]
    struct.pack_into("<I", legacy_data, central_offset + 38, 0)
    (fixtures / legacy_modes).write_bytes(legacy_data)
    with zipfile.ZipFile(fixtures / legacy_modes) as archive:
        assert archive.getinfo("unix-zero-mode.jsonl").external_attr == 0
        assert archive.testzip() is None
    legacy_streams = [first, second, first, second, first]
    valid.append({"file": legacy_modes, "streams": legacy_streams})
    legacy_zip64, _ = zip64_archive(bytes(legacy_data))
    (fixtures / "legacy-modes-zip64-long-comment.zip").write_bytes(legacy_zip64)
    with zipfile.ZipFile(fixtures / "legacy-modes-zip64-long-comment.zip") as archive:
        assert archive.testzip() is None
    valid.append({"file": "legacy-modes-zip64-long-comment.zip", "streams": legacy_streams})

    password = "synthetic-native-zip-password"
    (fixtures / "protected.jsonl").write_text(first, encoding="utf-8")
    subprocess.run(
        ["zip", "-q", "-P", password, "protected.zip", "protected.jsonl"],
        cwd=fixtures, check=True, timeout=15,
    )
    with zipfile.ZipFile(fixtures / "protected.zip") as archive:
        assert archive.read("protected.jsonl", pwd=password.encode()) == first.encode()
        try:
            archive.read("protected.jsonl", pwd=b"wrong-password")
        except (RuntimeError, zipfile.BadZipFile, zlib.error):
            pass
        else:
            raise AssertionError("encrypted fixture accepted the wrong password")

    large_input = root / "large-input"
    large_input.mkdir(mode=0o700)
    source = large_input / "sparse.bin"
    with source.open("wb") as output:
        output.truncate(LARGE_SIZE)
        for position, marker in MARKERS:
            assert position + len(marker) <= LARGE_SIZE
            output.seek(position)
            output.write(marker)
    source_stat = source.stat()
    assert source_stat.st_size == LARGE_SIZE
    assert source_stat.st_blocks * 512 < CHUNK_SIZE, "TMPDIR does not support sparse fixtures"
    return {
        "valid": valid,
        "damaged": [
            "bad-crc.zip", "truncated-payload.zip", "truncated-empty.zip", "unsupported-link.zip",
            "unsupported-link-long-comment.zip", "unsupported-fifo-long-comment.zip",
            "unsupported-fifo.zip", "unsupported-character-long-comment.zip",
            "unsupported-block-long-comment.zip", "unsupported-socket-long-comment.zip",
            "unsupported-link-zip64-long-comment.zip",
        ] + end_damage + directory_damage,
        "password": password,
        "passwordStream": first,
        "largeSize": LARGE_SIZE,
    }


def check_unicode(root, expected):
    with zipfile.ZipFile(root / "中文归档.zip") as archive:
        assert set(archive.namelist()) == set(expected) | {"子目录/"}
        for entry in archive.infolist():
            if not entry.filename.isascii():
                assert entry.flag_bits & 0x800, (entry.filename, entry.flag_bits)
        for name, content in expected.items():
            assert archive.read(name) == content.encode("utf-8"), name
        assert archive.testzip() is None
    return {"unicodeFileNames": True, "unicodeDirectory": True, "utf8Metadata": True}


def check_copy(root):
    copied = root / "large-copy.bin"
    assert copied.stat().st_size == LARGE_SIZE
    with copied.open("rb") as stream:
        length = verify_stream(stream)
    return {"copiedBytes": length}


def check_large_zip(root):
    archived = root / "large.zip"
    assert archived.stat().st_size < 32 << 20, "sparse fixture archive exceeded its storage budget"
    with zipfile.ZipFile(archived) as archive:
        assert archive.namelist() == ["sparse.bin"]
        info = archive.getinfo("sparse.bin")
        assert info.file_size == LARGE_SIZE
        with archive.open(info) as stream:
            length = verify_stream(stream)  # ZipExtFile also validates the CRC at EOF.
    return {"archivedBytes": length, "archiveBytes": archived.stat().st_size}


def main():
    resource.setrlimit(resource.RLIMIT_AS, (256 << 20, 256 << 20))
    action, root = sys.argv[1], Path(sys.argv[2])
    if action == "create":
        result = create_fixtures(root)
    elif action == "unicode":
        result = check_unicode(root, json.loads(sys.argv[3]))
    elif action == "copy":
        result = check_copy(root)
    elif action == "large-zip":
        result = check_large_zip(root)
    else:
        raise ValueError(f"unknown fixture action: {action}")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
