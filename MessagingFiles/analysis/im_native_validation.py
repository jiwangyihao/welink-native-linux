#!/usr/bin/env python3
"""Parent-run IM codec/database validation. Authoring does not build or run it.

BUILD INPUTS (all native objects/libraries must be ia32):
  * analysis/im_native_validation.c, which includes the ACTUAL sibling
    im_transport_codec.c and im_transport_schema.inc; do not compile codec twice.
  * Restored native source-root include path (native_storage.h and the pinned
    vendor/sqlite3mc-1.4.6 header), real native_storage.o, kmc_compat.o, and the
    project's sqlite3mc amalgamation object built with production cipher flags.
  * Supplied PRIVATE json-c 0.19 headers and libjson-c.a, NOT pkg-config json-c
    (the system version is 0.18). GLib-2.0, OpenSSL, pthread, dl, math ia32 inputs.
  * Build the helper with -m32 -std=c11 -fvisibility=hidden. Example link recipe:
      cc -m32 -std=c11 -O2 -fvisibility=hidden -I"$NATIVE_ROOT" \
        -I"$PRIVATE_JSON_C_INCLUDE" $GLIB32_CFLAGS \
        analysis/im_native_validation.c "$NATIVE_STORAGE_O" "$KMC_COMPAT_O" \
        "$SQLITE3MC_O" "$PRIVATE_JSON_C_A" $GLIB32_LIBS $OPENSSL32_LIBS \
        -ldl -lpthread -lm -o im_native_validation
    Those object variables are built PRODUCTION objects, never mock providers.
  * The native IM SQLite shared library must export exactly InitSqliteService,
    SqliteServiceSendMsg, SqliteServiceDispatchCallbacks, SqliteServiceShutdown.
    It too must use private static json-c 0.19 and the real encrypted storage.
  * Optional original probe: i686-w64-mingw32-gcc -std=c11 -O2 -Wall -Wextra
      analysis/im_native_validation_oracle.c -o im_native_validation_oracle.exe
    Its DLL input is original tup_sqlite_logic_api.dll, NOT im_sqlite_plugin.dll.

INVOCATIONS (nothing builds implicitly):
  python3 analysis/im_native_validation.py --synthetic-only --slice codec \
    --runner /absolute/ia32/im_native_validation --output /tmp/im-codec-new
  python3 analysis/im_native_validation.py --synthetic-only --slice all \
    --runner /absolute/ia32/im_native_validation \
    --native-sqlite /absolute/ia32/tup_sqlite_logic_api.so \
    --dependency-dir /absolute/ia32/dependencies --output /tmp/im-all-new \
    --original-fixture /absolute/PURE-SYNTHETIC/fixture.json \
    --wine /absolute/wine --wine-prefix /tmp/im-all-new/wine \
    --oracle-probe /absolute/im_native_validation_oracle.exe \
    --oracle-dll /absolute/original-im/tup_sqlite_logic_api.dll \
    --oracle-dependency-dir /absolute/original-im
  Without --original-fixture, --kmc-seed /absolute/PURE-SYNTHETIC/KMC-root plus
  the optional original runtime generates an original fixture through its ABI.
  --application-seed may supply PURE SYNTHETIC original application resources.
  --oracle-launcher may be repeated, e.g. /usr/bin/unshare, --net, -- (use
  --oracle-launcher=--net). A parent-managed no-network namespace is recommended.
  The validator opens no sockets and never starts IM, login, meetings or clients.

SUPPLIED FIXTURE FORMAT (fixture.json, UTF-8, alongside copied synthetic data):
  {"format":"im-native-validation-fixture-v1", "synthetic":true,
   "origin":"original-dll", "account":"fixture-user",
   "application":"app", "kmc":"kmc", "private":"private",
   "expected_userconfig":[{"id":2,"strkey":"fixture.im.中文",
                           "strvalue":"the exact synthetic original value"}]}
  All three paths are relative directories inside the manifest's directory;
  symlinks are rejected. The private directory must contain config_private.db,
  user.db, history.db, conversation.db and any original sidecars. The account
  plaintext must be fixture-user, NOT fixture-user=. KMC is Init's THIRD argument.
  Source fixtures/seeds are never modified. Only copies below a NEW output dir
  are touched. Generated native-counterpart/fixture.json can be passed to the
  original probe: the driver really queries it, not merely exports a manifest.

RESULTS:
  summary.json has separate pass/fail/blocked scenarios. Every child has full
  stdout/stderr, parsed events, requests and expectations, including unredacted
  SYNTHETIC callbacks. No absent prerequisite or skipped row is a pass. Exit 1
  means a failed assertion; exit 2 means missing prerequisites; 0 means every
  selected scenario actually passed. Original data-query success is separate
  from original shutdown: exit 3/hang is always a lifecycle failure. Native
  callbacks are accepted only inside the owner's exact public dispatch pump.
"""
from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import struct
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Callable

HERE = Path(__file__).resolve().parent
FORMAT = "im-native-validation-fixture-v1"
ACCOUNT = "fixture-user"
KEY = "fixture.im.中文"
NATIVE_VALUE = "原生互通：中文、单引号'、双引号\"与换行\n第二行"
ORIGINAL_VALUE = "原始互通：纯合成中文数据"
PRIVATE_FILES = ("config_private.db", "user.db", "history.db", "conversation.db")


class Blocked(Exception):
    """An external input/runtime is absent, not a failed assertion."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def json_write(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def jsonl_write(path: Path, rows: list[dict]) -> None:
    # Original adapters accept UTF-8 JSON; escaped payloads avoid ANSI file APIs.
    path.write_text("".join(json.dumps(row, ensure_ascii=True, separators=(",", ":")) + "\n" for row in rows), encoding="utf-8")


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256")
    return digest.hexdigest()


def inventory(directory: Path) -> dict[str, str]:
    return {str(path.relative_to(directory)): sha256(path)
            for path in sorted(directory.rglob("*")) if path.is_file()}


def checked_tree(source: Path) -> Path:
    if not source.is_dir():
        raise Blocked(f"missing synthetic directory: {source}")
    require(not source.is_symlink(), f"synthetic source must not be a symlink: {source}")
    for child in source.rglob("*"):
        require(not child.is_symlink(), f"symlink in synthetic fixture: {child}")
        require(child.is_file() or child.is_dir(), f"nonregular synthetic fixture entry: {child}")
    return source.resolve()


def copy_tree(source: Path, target: Path) -> None:
    shutil.copytree(checked_tree(source), target)


def elf32_inputs(path: Path) -> dict:
    if not path.is_file():
        raise Blocked(f"missing built native input: {path}")
    data = path.read_bytes()
    require(len(data) >= 52 and data[:6] == b"\x7fELF\x01\x01", f"not a little-endian ia32 ELF: {path}")
    header = struct.unpack_from("<16sHHIIIIIHHHHHH", data)
    require(header[2] == 3, f"native input is not EM_386: {path}")
    section_offset, section_size, count = header[6], header[11], header[12]
    require(section_size >= 40 and count > 0, f"ELF section metadata required to inspect dependencies: {path}")
    sections = [struct.unpack_from("<IIIIIIIIII", data, section_offset + n * section_size) for n in range(count)]
    needed = []
    for section in sections:
        if section[1] != 6:  # SHT_DYNAMIC
            continue
        strings = sections[section[6]]
        string_data = data[strings[4]: strings[4] + strings[5]]
        for offset in range(section[4], section[4] + section[5], section[9] or 8):
            tag, value = struct.unpack_from("<iI", data, offset)
            if tag == 1:
                needed.append(string_data[value:].split(b"\0", 1)[0].decode("ascii"))
    require(not any("json-c" in name for name in needed), f"json-c must be private/static, not DT_NEEDED: {needed}")
    return {"path": str(path), "sha256": sha256(path), "needed": needed, "machine": "ia32"}


@dataclass
class Fixture:
    root: Path
    app: Path
    kmc: Path
    private: Path
    expected: list[dict]
    origin: str

    def manifest(self) -> Path:
        path = self.root / "fixture.json"
        json_write(path, {"format": FORMAT, "synthetic": True, "origin": self.origin,
                          "account": ACCOUNT, "application": str(self.app.relative_to(self.root)),
                          "kmc": str(self.kmc.relative_to(self.root)),
                          "private": str(self.private.relative_to(self.root)),
                          "expected_userconfig": self.expected})
        return path


def supplied_fixture(path: Path) -> Fixture:
    if not path.is_file():
        raise Blocked(f"missing PURE SYNTHETIC original fixture manifest: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    require(data.get("format") == FORMAT and data.get("synthetic") is True, "fixture must declare the synthetic format")
    require(data.get("account") == ACCOUNT and data.get("origin") == "original-dll", "forward fixture must originate in real original DLL with fixture-user")
    root = path.resolve().parent

    def directory(key: str) -> Path:
        relative = data[key]
        require(isinstance(relative, str) and relative and not Path(relative).is_absolute(), f"invalid fixture path: {key}")
        candidate = root / relative
        require(candidate.resolve().is_relative_to(root), f"fixture path escapes manifest: {key}")
        return checked_tree(candidate)

    expected = data.get("expected_userconfig")
    require(isinstance(expected, list) and expected, "fixture must declare exact synthetic expected userconfig rows")
    for row in expected:
        require(isinstance(row, dict) and type(row.get("id")) is int and row["id"] > 0 and
                isinstance(row.get("strkey"), str) and isinstance(row.get("strvalue"), str), "invalid fixture expected row")
    require(any(row["strkey"] == KEY for row in expected), f"fixture needs the recorded Chinese sentinel {KEY}")
    fixture = Fixture(root, directory("application"), directory("kmc"), directory("private"), expected, "original-dll")
    for name in PRIVATE_FILES:
        require((fixture.private / name).is_file(), f"original fixture missing {name}")
    return fixture


class Script:
    def __init__(self, fixture: Fixture, logs: Path):
        logs.mkdir()
        self.ops = [{"op": "init", "log": str(logs), "app": str(fixture.app), "kmc": str(fixture.kmc)}]
        self.requests: list[dict] = []
        self.expected: dict[int, dict] = {}
        self.serial = 0

    def op(self, name: str, **fields) -> None:
        self.ops.append({"op": name, **fields})

    def rpc(self, cmd: int, param: dict, result: int | str = 1,
            rows: list[dict] | None = None, wait: bool = True) -> int:
        self.serial += 1
        sno = self.serial
        request = {"cmd": cmd, "sno": sno, "param": param}
        self.requests.append(request)
        self.expected[sno] = {"cmd": cmd, "result": result, "rows": rows}
        self.op("send", request=request)
        if wait:
            self.op("await", sno=sno, ms=15000)
        return sno

    def initialize(self, fixture: Fixture, account: str = ACCOUNT, wait: bool = True) -> int:
        return self.rpc(1, {"_useraccount": account, "_dbpath": str(fixture.private) + os.sep}, 0, wait=wait)

    def query(self, key: str, rows: list[dict], result: int = 1, wait: bool = True) -> int:
        return self.rpc(27, {"_matchinfo": {"keytype": 1, "match_value": key}}, result, rows, wait)

    def add(self, key: str, value: str, row_id: int = -1, result: int | str = "inserted_id", wait: bool = True) -> int:
        return self.rpc(25, {"_keyvalue": {"id": row_id, "strkey": key, "strvalue": value}}, result, wait=wait)

    def close(self) -> None:
        # Successful reinit proves prior asynchronous cleanup is really complete.
        self.op("shutdown")
        self.op("reinit", ms=15000)
        self.op("shutdown")


def callback_map(events: list[dict]) -> dict[int, dict]:
    result = {}
    for event in events:
        if event.get("event") != "callback":
            continue
        reply = event.get("reply")
        require(isinstance(reply, dict), "callback must be a JSON object")
        sno = reply.get("sno")
        require(type(sno) is int and sno not in result, f"missing/duplicate callback sno: {sno}")
        require(json.loads(event["raw"]) == reply, "callback artifact must preserve complete raw JSON")
        result[sno] = reply
    return result


def validate_callbacks(events: list[dict], expected: dict[int, dict], native: bool = True) -> dict[int, dict]:
    replies = callback_map(events)
    require(set(replies) == set(expected), f"callback identities differ: got {sorted(replies)}, expected {sorted(expected)}")
    if native:
        for event in events:
            if event.get("event") == "callback":
                require(event.get("owner") is True and event.get("inside_pump") is True, "callback outside the native owner's explicit pump")
    for sno, spec in expected.items():
        reply = replies[sno]
        require(type(reply.get("rsp")) is int and reply["rsp"] == spec["cmd"], f"wrong rsp for sno {sno}")
        require("cmd" in reply and reply["cmd"] is None and "ret" in reply and reply["ret"] is None,
                f"sno {sno}: original cmd:null/ret:null envelope not retained")
        require(type(reply.get("result")) is int and isinstance(reply.get("description"), str), f"sno {sno}: untyped result/description")
        if spec["result"] == "inserted_id":
            require(reply["result"] > 0, f"add_userconfig must return inserted id, got {reply}")
        else:
            require(reply["result"] == spec["result"], f"sno {sno}: command-specific result mismatch: {reply}")
        if spec["rows"] is None or spec["result"] != 1:
            continue
        param = reply.get("param")
        require(isinstance(param, dict) and type(param.get("_retlen")) is int and "_userconfiglist" in param,
                f"sno {sno}: query missing typed _retlen/list")
        rows = param["_userconfiglist"]
        if param["_retlen"] == 0 and rows is None:
            rows = []  # Recorded empty query form only; never normalize nonempty data.
        require(isinstance(rows, list) and len(rows) == param["_retlen"] == len(spec["rows"]), f"sno {sno}: query count mismatch: {param}")
        actual = []
        for row in rows:
            require(isinstance(row, dict) and type(row.get("id")) is int and isinstance(row.get("strkey"), str) and
                    isinstance(row.get("strvalue"), str), f"sno {sno}: invalid typed config row")
            actual.append((row["id"], row["strkey"], row["strvalue"]))
        wanted = []
        for row in spec["rows"]:
            row_id = replies[row["id_from"]]["result"] if "id_from" in row else row["id"]
            wanted.append((row_id, row["strkey"], row["strvalue"]))
        require(sorted(actual) == sorted(wanted), f"sno {sno}: Chinese config rows differ: {actual!r} != {wanted!r}")
    return replies


class Harness:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.out = args.output.resolve()
        self.out.mkdir(parents=True, exist_ok=False)
        self.artifacts = self.out / "artifacts"
        self.artifacts.mkdir()
        self.results: list[dict] = []
        self.inputs: dict = {}
        self.native_ready = False
        self.library_ready = False

    def case(self, name: str, action: Callable) -> object | None:
        started = time.monotonic()
        try:
            value = action()
            result = {"name": name, "status": "pass", "details": value}
        except Blocked as error:
            value = None
            result = {"name": name, "status": "blocked", "reason": str(error)}
        except Exception as error:
            value = None
            result = {"name": name, "status": "fail", "reason": f"{type(error).__name__}: {error}"}
        result["seconds"] = round(time.monotonic() - started, 6)
        self.results.append(result)
        self.save()
        print(f"{result['status'].upper()}: {name}" + (f": {result['reason']}" if "reason" in result else ""), flush=True)
        return value

    def save(self) -> None:
        json_write(self.out / "summary.json", {"synthetic_only": True, "inputs": self.inputs,
                                               "scenarios": self.results, "all_selected_passed": bool(self.results) and
                                               all(row["status"] == "pass" for row in self.results)})

    def native_inputs(self, database: bool = False) -> None:
        if not self.native_ready:
            if not self.args.runner:
                raise Blocked("--runner is required: prebuilt ia32 native validation executable")
            self.inputs["runner"] = elf32_inputs(self.args.runner)
            self.native_ready = True
        if database and not self.library_ready:
            if not self.args.native_sqlite:
                raise Blocked("--native-sqlite is required: prebuilt real native IM SQLite ABI library")
            self.inputs["native_sqlite"] = elf32_inputs(self.args.native_sqlite)
            self.library_ready = True

    def process(self, name: str, argv: list[str], env: dict[str, str], timeout: float) -> dict:
        json_write(self.artifacts / f"{name}.command.json", {"argv": argv, "timeout": timeout,
                    "LD_LIBRARY_PATH": env.get("LD_LIBRARY_PATH"), "WINEPREFIX": env.get("WINEPREFIX")})
        started = time.monotonic()
        try:
            child = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                                     cwd=self.out, start_new_session=True)
        except OSError as error:
            raise Blocked(f"cannot start supplied runtime {argv[0]}: {error}") from error
        timed_out = False
        try:
            stdout, stderr = child.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(child.pid, signal.SIGKILL)
            stdout, stderr = child.communicate()
        (self.artifacts / f"{name}.stdout.bin").write_bytes(stdout)
        (self.artifacts / f"{name}.stderr.bin").write_bytes(stderr)
        result = {"returncode": child.returncode, "timed_out": timed_out,
                  "seconds": round(time.monotonic() - started, 6), "artifact": name}
        json_write(self.artifacts / f"{name}.process.json", result)
        return {**result, "stdout": stdout, "stderr": stderr}

    def native(self, name: str, argv: list[str], database: bool = False) -> tuple[dict, list[dict]]:
        self.native_inputs(database)
        env = os.environ.copy()
        for key in ("LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH"):
            env.pop(key, None)
        for directory in self.args.dependency_dir:
            if not directory.is_dir():
                raise Blocked(f"missing ia32 dependency directory: {directory}")
        env["LD_LIBRARY_PATH"] = os.pathsep.join(str(path.resolve()) for path in self.args.dependency_dir)
        run = self.process(name, [str(self.args.runner.resolve()), *argv], env, self.args.timeout)
        events = []
        try:
            for line in run["stdout"].decode("utf-8").splitlines():
                events.append(json.loads(line))
        finally:
            json_write(self.artifacts / f"{name}.events.json", events)
        return run, events

    @staticmethod
    def successful(run: dict, events: list[dict]) -> None:
        require(not run["timed_out"] and run["returncode"] == 0, f"native runner failed: {run['artifact']}, exit={run['returncode']}, timeout={run['timed_out']}")
        require(not any(event.get("event") == "error" for event in events), "native runner reported an assertion error")
        runtime = [event for event in events if event.get("event") == "runtime"]
        require(len(runtime) == 1 and runtime[0].get("pointer_bits") == 32 and runtime[0].get("json_c") == "0.19", "wrong ia32/private-json-c runtime")

    def script(self, name: str, script: Script) -> tuple[dict, list[dict]]:
        path = self.artifacts / f"{name}.script.jsonl"
        jsonl_write(path, script.ops)
        json_write(self.artifacts / f"{name}.expectations.json", script.expected)
        self.native_inputs(True)
        return self.native(name, ["database", str(self.args.native_sqlite.resolve()), str(path)], True)

    def checked_script(self, name: str, script: Script) -> dict:
        run, events = self.script(name, script)
        self.successful(run, events)
        replies = validate_callbacks(events, script.expected)
        require(any(event.get("event") == "script_summary" for event in events), "native script did not finish")
        return {"artifact": name, "callbacks": len(replies), "replies": replies}

    def clone(self, fixture: Fixture, name: str) -> Fixture:
        root = self.out / name
        root.mkdir()
        for source, leaf in ((fixture.app, "app"), (fixture.kmc, "kmc"), (fixture.private, "private")):
            copy_tree(source, root / leaf)
        return Fixture(root, root / "app", root / "kmc", root / "private", fixture.expected, fixture.origin)

    def fresh(self, name: str, seed: Path | None) -> Fixture:
        if seed is None:
            raise Blocked("a supplied PURE SYNTHETIC --kmc-seed or original fixture KMC root is required")
        checked_tree(seed)
        root = self.out / name
        root.mkdir()
        copy_tree(seed, root / "kmc")
        if self.args.application_seed:
            copy_tree(self.args.application_seed, root / "app")
        else:
            (root / "app").mkdir()
        (root / "private").mkdir()
        return Fixture(root, root / "app", root / "kmc", root / "private", [], "native-public-abi")


def codec(h: Harness) -> dict:
    path = h.args.corpus.resolve()
    if not path.is_file():
        raise Blocked(f"missing complete corpus: {path}")
    original = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    require(len(original) == 401, "the complete corpus must contain exactly 401 rows")
    h.inputs["corpus"] = {"path": str(path), "sha256": sha256(path), "rows": 401}
    run, events = h.native("codec-all-401", ["codec", str(path)])
    vectors = [event for event in events if event.get("event") == "vector"]
    require(len(vectors) == 401, f"native codec did not attempt every row: {len(vectors)}/401")
    bad = []
    for index, (expected, actual) in enumerate(zip(original, vectors), 1):
        require(actual.get("row") == index and actual.get("original") == expected, f"row {index} changed or omitted by runner")
        if not (actual.get("pass") is True and actual.get("encode_exact") is True and
                actual.get("decode0_typed_equal") is True and actual.get("decode1_typed_equal") is True and
                actual.get("encode_status") == actual.get("decode0_status") == actual.get("decode1_status") == 0):
            bad.append({"row": index, "class": expected.get("class")})
    json_write(h.artifacts / "codec-all-401.mismatches.json", bad)
    require(not bad, f"native codec mismatches (none skipped): {bad}")
    h.successful(run, events)
    require(any(row.get("model_code") == 0 for row in vectors), "nested/code-zero models not exercised")
    return {"rows": 401, "encodes": 401, "original_decodes": 802,
            "code_zero_rows": sum(row.get("model_code") == 0 for row in vectors), "artifact": "codec-all-401"}


def query_fixture(script: Script, fixture: Fixture) -> None:
    for row in fixture.expected:
        script.query(row["strkey"], [row])


def native_generate(h: Harness, fixture: Fixture) -> dict:
    script = Script(fixture, h.artifacts / "native-generate.logs")
    script.initialize(fixture)
    added = script.add(KEY, NATIVE_VALUE)
    script.query(KEY, [{"id_from": added, "strkey": KEY, "strvalue": NATIVE_VALUE}])
    script.close()
    result = h.checked_script("native-generate", script)
    inserted = result["replies"][added]["result"]
    fixture.expected = [{"id": inserted, "strkey": KEY, "strvalue": NATIVE_VALUE}]
    fixture.origin = "native-public-abi"
    manifest = fixture.manifest()
    for name in PRIVATE_FILES:
        require((fixture.private / name).is_file(), f"native generation missing original-format file {name}")
    require(not (fixture.private / "config.private.db").exists(), "wrong private metadata filename")
    return {"artifact": "native-generate", "manifest": str(manifest), "inserted_id": inserted}


def crud(h: Harness, source: Fixture) -> dict:
    fixture = h.clone(source, "native-chinese-crud")
    script = Script(fixture, h.artifacts / "native-chinese-crud.logs")
    script.initialize(fixture)
    key, first, second, row_id = "验证.中文.CRUD", "添加：中文'与双引号\"", "更新：第二行\n反斜杠\\原样保留", 7301
    script.add(key, first, row_id, row_id)
    script.query(key, [{"id": row_id, "strkey": key, "strvalue": first}])
    # Original config API updates with add/replace, not a fabricated update cmd.
    script.add(key, second, row_id, row_id)
    script.query(key, [{"id": row_id, "strkey": key, "strvalue": second}])
    script.rpc(26, {"_matchinfo": {"keytype": 1, "match_value": key}}, 1)
    script.query(key, [])
    query_fixture(script, fixture)
    script.close()
    return h.checked_script("native-chinese-crud", script)


def reopen(h: Harness, source: Fixture, name: str) -> dict:
    fixture = h.clone(source, name)
    script = Script(fixture, h.artifacts / f"{name}.logs")
    script.initialize(fixture)
    query_fixture(script, fixture)
    script.close()
    return h.checked_script(name, script)


def corrupt_key(h: Harness, source: Fixture) -> dict:
    fixture = h.clone(source, "native-corrupt-key")
    key_path = fixture.private / "config_private.db"
    before = key_path.read_bytes()
    require(before, "cannot corrupt an empty key fixture")
    # Invalid ciphertext, original nonce/data remain untouched. Never regenerate.
    key_path.write_bytes(b"!" + before[1:])
    snapshot = inventory(fixture.private)
    json_write(h.artifacts / "native-corrupt-key.before.json", snapshot)
    script = Script(fixture, h.artifacts / "native-corrupt-key.logs")
    sno = script.initialize(fixture)
    script.expected[sno]["result"] = 1
    script.query(KEY, [], result=-1)
    script.add("验证.损坏密钥", "不能覆盖", result=-1)
    script.close()
    run, events = h.script("native-corrupt-key", script)
    after = inventory(fixture.private)
    json_write(h.artifacts / "native-corrupt-key.after.json", after)
    require(snapshot == after, "corrupt metadata or existing encrypted DB bytes were replaced/modified")
    h.successful(run, events)
    validate_callbacks(events, script.expected)
    return {"artifact": "native-corrupt-key", "unchanged_files": sorted(snapshot)}


def failed_switch(h: Harness, source: Fixture) -> dict:
    fixture = h.clone(source, "native-failed-account-switch")
    other = fixture.root / "other-private"
    copy_tree(fixture.private, other)
    key_path = other / "config_private.db"
    key_path.write_bytes(b"!" + key_path.read_bytes()[1:])
    snapshot = inventory(other)
    script = Script(fixture, h.artifacts / "native-failed-account-switch.logs")
    script.initialize(fixture)
    query_fixture(script, fixture)
    script.rpc(1, {"_useraccount": "fixture-other", "_dbpath": str(other) + os.sep}, 1)
    script.query(KEY, [], result=-1)
    script.add(KEY, "失败切换后绝不能写入旧账户", result=-1)
    script.initialize(fixture)
    query_fixture(script, fixture)
    script.close()
    run, events = h.script("native-failed-account-switch", script)
    after = inventory(other)
    json_write(h.artifacts / "native-failed-account-switch.preservation.json", {"before": snapshot, "after": after})
    require(snapshot == after, "failed target account metadata/database files changed")
    h.successful(run, events)
    validate_callbacks(events, script.expected)
    return {"artifact": "native-failed-account-switch", "old_account_reopened_unchanged": True,
            "failed_account_files_unchanged": sorted(snapshot)}


def lifecycle_capture(h: Harness, source: Fixture) -> tuple[dict, list[dict], Script, tuple[int, ...]]:
    fixture = h.clone(source, "native-callback-lifecycle")
    script = Script(fixture, h.artifacts / "native-callback-lifecycle.logs")
    initial = script.initialize(fixture, wait=False)
    script.op("wait_log", count=1, ms=15000)
    script.op("pause", ms=50)
    script.op("foreign_pump")
    script.op("await", sno=initial, ms=15000)
    script.op("lock", directory=str(fixture.private))
    trigger = script.query(KEY, fixture.expected, wait=False)
    ready_stale = script.query(KEY, fixture.expected, wait=False)
    blocked_stale = script.add("验证.忙清理", "纯合成阻塞写入", wait=False)
    pending_stale = script.query(KEY, fixture.expected, wait=False)
    script.op("wait_log", count=3, ms=15000)
    script.op("pause", ms=150)
    script.op("arm_shutdown", sno=trigger)
    script.op("await", sno=trigger, ms=2000)
    script.op("pause", ms=50)
    script.op("expect_busy")
    script.op("unlock")
    script.op("reinit", ms=15000)
    script.op("pump", ms=100)
    new_init = script.initialize(fixture)
    query_fixture(script, fixture)
    script.op("pump", ms=150)
    script.close()
    for stale in (ready_stale, blocked_stale, pending_stale):
        del script.expected[stale]
    run, events = h.script("native-callback-lifecycle", script)
    return run, events, script, (initial, trigger, ready_stale, blocked_stale, pending_stale, new_init)


def lifecycle_verdict(h: Harness, capture: tuple, kind: str) -> dict:
    run, events, script, ids = capture
    h.successful(run, events)
    replies = validate_callbacks(events, script.expected)
    operations = [event for event in events if event.get("event") == "operation"]
    if kind == "owner_pump":
        foreign = [event for event in operations if event["instruction"]["op"] == "foreign_pump"]
        require(len(foreign) == 1 and foreign[0]["status"] == -errno.EPERM and foreign[0]["callbacks"] == 0,
                "pre-pump/foreign-thread dispatch delivered callbacks or failed to reject nonowner")
    elif kind == "reentrant_nonblocking_shutdown":
        shutdowns = [event for event in events if event.get("event") == "reentrant_shutdown"]
        require(len(shutdowns) == 1 and shutdowns[0]["nested_dispatch"] == 0 and
                0 <= shutdowns[0]["duration_us"] <= 250000 and shutdowns[0]["immediate_init"] == errno.EALREADY,
                "reentrant shutdown did not defer nested dispatch, return promptly, and report EALREADY")
    elif kind == "busy_cleanup_reinit":
        busy = [event for event in operations if event["instruction"]["op"] == "expect_busy"]
        reinit = [event for event in operations if event["instruction"]["op"] == "reinit"]
        require(len(busy) == 1 and busy[0]["status"] == errno.EALREADY and reinit and all(row["status"] == 0 for row in reinit),
                "real locked SQLite cleanup/reinit did not exhibit EALREADY then success")
        require(replies[ids[-1]]["result"] == 0, "new account initialization failed after locked cleanup")
    elif kind == "stale_epoch_rejection":
        require(not any(sno in replies for sno in ids[2:5]), "ready, in-flight, or pending old-epoch callback leaked")
        for event in events:
            if event.get("event") == "callback":
                wanted = 1 if event["reply"]["sno"] in ids[:2] else 2
                require(event["generation"] == wanted, "callback delivered into the wrong initialization epoch")
    else:
        raise AssertionError(f"unknown lifecycle verdict: {kind}")
    return {"artifact": "native-callback-lifecycle", "callbacks": len(replies)}


def schema_signature(rows: list[dict]) -> dict:
    # In-memory SQLite is only a DDL parser for reference comparison. No file,
    # plaintext copy, decrypt fallback, or alternate database path is opened.
    connection = sqlite3.connect(":memory:")
    try:
        for kind in ("table", "index"):
            for row in rows:
                if row.get("type") == kind and row.get("sql") and not row["name"].startswith("sqlite_"):
                    connection.execute(row["sql"])
        tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        result = {}
        for name in tables:
            quoted = '"' + name.replace('"', '""') + '"'
            columns = []
            for cid, column, declared, nullable, default, primary in connection.execute(f"PRAGMA table_info({quoted})"):
                default = default.strip() if default is not None else None
                while default and default.startswith("(") and default.endswith(")"):
                    default = default[1:-1].strip()
                columns.append((cid, column.upper(), " ".join(declared.upper().split()), nullable, default, primary))
            indexes = []
            for _, index, unique, origin, partial in connection.execute(f"PRAGMA index_list({quoted})"):
                index_quoted = '"' + index.replace('"', '""') + '"'
                fields = [tuple(row) for row in connection.execute(f"PRAGMA index_xinfo({index_quoted})")]
                indexes.append((index.upper(), unique, origin, partial, fields))
            result[name.upper()] = {"columns": columns, "indexes": sorted(indexes),
                                    "foreign_keys": list(connection.execute(f"PRAGMA foreign_key_list({quoted})"))}
        return result
    finally:
        connection.close()


def inspect_schema(h: Harness, fixture: Fixture, name: str) -> dict:
    reference_path = h.args.schema.resolve()
    if not reference_path.is_file():
        raise Blocked(f"missing original schema reference: {reference_path}")
    reference = json.loads(reference_path.read_text(encoding="utf-8"))
    h.inputs["schema_reference"] = {"path": str(reference_path), "sha256": sha256(reference_path)}
    run, events = h.native(name, ["inspect", str(fixture.kmc), str(fixture.private)])
    h.successful(run, events)
    actual = {event["filename"]: event for event in events if event.get("event") == "database_inspection"}
    require(set(actual) == set(reference), "inspection must cover every reference database, without skipped files")
    signatures = {}
    for filename, expected in reference.items():
        record = actual[filename]
        require(record["status"] == 0, f"encrypted file/key interoperability failed for {filename}")
        require(record["user_version"] == [{"user_version": 0}], f"{filename}: user_version must remain original zero")
        if filename in ("history.db", "conversation.db"):
            require(record["db_version"] == [{"VERSION_KEY": "DBVersion", "VERSION_VALUE": "3.0"}], f"{filename}: wrong DBVersionTab DBVersion3.0")
        if filename == "user.db":
            require(record["account"] == [{"KEY": "loginaccount", "VALUE": ACCOUNT}], "account plaintext is not fixture-user")
        wanted, got = schema_signature(expected["rows"]), schema_signature(record["schema"])
        signatures[filename] = {"expected": wanted, "actual": got}
    json_write(h.artifacts / f"{name}.schema-signatures.json", signatures)
    for filename, pair in signatures.items():
        require(pair["expected"] == pair["actual"], f"{filename}: original schema semantics differ; see {name}.schema-signatures.json")
    return {"artifact": name, "databases": sorted(actual), "user_version": 0, "DBVersion": "3.0", "plaintext_fallback": False}


def windows_path(path: Path, directory: bool = False) -> str:
    resolved = str(path.resolve())
    require(resolved.isascii(), f"oracle ANSI directory/file API requires an ASCII filesystem path: {path}")
    result = "Z:" + resolved.replace("/", "\\")
    return result.rstrip("\\") + "\\" if directory else result


def oracle_prerequisites(h: Harness) -> tuple[list[str], dict[str, str]]:
    args = h.args
    required = {"--wine": args.wine, "--oracle-probe": args.oracle_probe, "--oracle-dll": args.oracle_dll,
                "--oracle-dependency-dir": args.oracle_dependency_dir, "--wine-prefix": args.wine_prefix}
    missing = [key for key, value in required.items() if value is None]
    if missing:
        raise Blocked("optional private-Wine original runtime not supplied: " + ", ".join(missing))
    for key in ("--wine", "--oracle-probe", "--oracle-dll"):
        if not required[key].is_file():
            raise Blocked(f"{key} input missing: {required[key]}")
    if not args.oracle_dependency_dir.is_dir():
        raise Blocked("original ia32 DLL dependency directory is missing")
    prefix = args.wine_prefix.resolve()
    marker = prefix / ".im-native-validation-private-prefix"
    if not prefix.exists():
        require(prefix.is_relative_to(h.out), "new Wine prefix must be below this run's output directory")
        prefix.mkdir(parents=True)
        marker.write_text("PURE SYNTHETIC\n", encoding="ascii")
    else:
        require(marker.is_file() and marker.read_text(encoding="ascii") == "PURE SYNTHETIC\n",
                "refusing unmarked or production Wine prefix; marker must contain PURE SYNTHETIC")
    zdrive = prefix / "dosdevices" / "z:"
    if zdrive.exists():
        require(zdrive.resolve() == Path("/"), "oracle path conversion requires private Wine Z: mapped to /")
    env = os.environ.copy()
    for key in ("LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH", "WINEPATH"):
        env.pop(key, None)
    env.update({"WINEPREFIX": str(prefix), "WINEARCH": "win32", "WINEDEBUG": "-all",
                "WINEDLLOVERRIDES": "mscoree,mshtml=", "WINEPATH": windows_path(args.oracle_dependency_dir, True)})
    h.inputs["original"] = {"dll": str(args.oracle_dll.resolve()), "sha256": sha256(args.oracle_dll),
                             "probe": str(args.oracle_probe.resolve()), "probe_sha256": sha256(args.oracle_probe),
                             "private_prefix": str(prefix)}
    return [*args.oracle_launcher, str(args.wine.resolve()), str(args.oracle_probe.resolve())], env


def oracle_events(raw: bytes) -> list[dict]:
    events = []
    position = 0
    while position < len(raw):
        end = raw.find(b"\n", position)
        if end < 0:
            break
        line = raw[position:end].rstrip(b"\r")
        position = end + 1
        if line.startswith((b"IMVALID_CALLBACK ", b"IMVALID_REQUEST ")):
            length = int(line.split()[1])
            require(0 <= length <= 16 * 1024 * 1024 and position + length < len(raw), "truncated original callback/request frame")
            text = raw[position:position + length].decode("utf-8")
            require(raw[position + length:position + length + 1] == b"\n", "malformed original frame terminator")
            position += length + 1
            if line.startswith(b"IMVALID_CALLBACK "):
                events.append({"event": "callback", "raw": text, "reply": json.loads(text)})
            else:
                events.append({"event": "request", "raw": text, "request": json.loads(text)})
        elif line.startswith(b"IMVALID_"):
            events.append({"event": "oracle_marker", "text": line.decode("ascii")})
    return events


def oracle_capture(h: Harness, fixture: Fixture, name: str, generate: bool = False) -> tuple[dict, list[dict], dict]:
    command, env = oracle_prerequisites(h)
    logs = h.artifacts / f"{name}.logs"
    logs.mkdir()
    requests = [{"cmd": 1, "sno": 1, "param": {"_useraccount": ACCOUNT, "_dbpath": windows_path(fixture.private, True)}}]
    expected = {1: {"cmd": 1, "result": 0, "rows": None}}
    if generate:
        requests.append({"cmd": 25, "sno": 2, "param": {"_keyvalue": {"id": -1, "strkey": KEY, "strvalue": ORIGINAL_VALUE}}})
        expected[2] = {"cmd": 25, "result": "inserted_id", "rows": None}
        rows = [{"id_from": 2, "strkey": KEY, "strvalue": ORIGINAL_VALUE}]
    else:
        rows = fixture.expected
    for row in rows:
        sno = len(requests) + 1
        requests.append({"cmd": 27, "sno": sno, "param": {"_matchinfo": {"keytype": 1, "match_value": row["strkey"]}}})
        expected[sno] = {"cmd": 27, "result": 1, "rows": [row]}
    path = h.artifacts / f"{name}.requests.jsonl"
    jsonl_write(path, requests)
    json_write(h.artifacts / f"{name}.expectations.json", expected)
    args = h.args
    command += [windows_path(args.oracle_dll), windows_path(args.oracle_dependency_dir, True), windows_path(logs, True),
                windows_path(fixture.app, True), windows_path(fixture.kmc, True), windows_path(path)]
    run = h.process(name, command, env, args.oracle_timeout)
    try:
        events = oracle_events(run["stdout"])
    except (AssertionError, ValueError, UnicodeError) as error:
        # Preserve the actual process outcome even if framing is broken, so
        # exit 3/hang still receives a separate failing lifecycle verdict.
        events = [{"event": "oracle_protocol_error", "detail": str(error)}]
    json_write(h.artifacts / f"{name}.events.json", events)
    return run, events, expected


def oracle_data(capture: tuple, fixture: Fixture | None = None) -> dict:
    run, events, expected = capture
    require(not any(event.get("event") == "oracle_protocol_error" for event in events),
            "original probe emitted malformed callback framing; see full stdout artifact")
    markers = [event["text"] for event in events if event.get("event") == "oracle_marker"]
    require("IMVALID_INIT 0" in markers and any(text.startswith("IMVALID_DATA_COMPLETE ") for text in markers), "original data probe did not complete the real ABI requests")
    replies = validate_callbacks(events, expected, native=False)
    requests = [event["request"] for event in events if event.get("event") == "request"]
    require(len(requests) == len(expected), "original probe did not send every expected request")
    if fixture is not None:
        fixture.expected = [{"id": replies[2]["result"], "strkey": KEY, "strvalue": ORIGINAL_VALUE}]
        fixture.origin = "original-dll"
        fixture.manifest()
    return {"artifact": run["artifact"], "callbacks": len(replies), "shutdown_is_separate": True}


def oracle_lifecycle(capture: tuple) -> dict:
    run, events, _ = capture
    markers = [event["text"] for event in events if event.get("event") == "oracle_marker"]
    require("IMVALID_SHUTDOWN_BEGIN" in markers, "original probe did not reach shutdown")
    require(not run["timed_out"] and run["returncode"] == 0 and "IMVALID_SHUTDOWN_RETURNED" in markers,
            f"original shutdown is NOT a lifecycle pass: exit={run['returncode']}, timeout={run['timed_out']}")
    return {"artifact": run["artifact"], "exit": 0, "shutdown_returned": True}


def missing_fixture(name: str) -> None:
    raise Blocked(f"{name} fixture unavailable; see its separate generation/input scenario")


def database_scenarios(h: Harness) -> None:
    original = None
    if h.args.original_fixture:
        holder = {}

        def load_original():
            holder["fixture"] = supplied_fixture(h.args.original_fixture)
            return {"manifest": str(h.args.original_fixture.resolve()), "sha256": sha256(h.args.original_fixture)}

        h.case("original_fixture_input", load_original)
        original = holder.get("fixture")
    seed = h.args.kmc_seed or (original.kmc if original else None)
    if original is None:
        generated = {}

        def generate_original():
            oracle_prerequisites(h)
            generated["fixture"] = h.fresh("original-generated", seed)
            generated["capture"] = oracle_capture(h, generated["fixture"], "original-generate", generate=True)
            return oracle_data(generated["capture"], generated["fixture"])

        produced = h.case("original_fixture_generation", generate_original)
        if "capture" in generated:
            h.case("original_generation_shutdown", lambda: oracle_lifecycle(generated["capture"]))
        else:
            h.case("original_generation_shutdown", lambda: missing_fixture("original generation runtime"))
        if produced is not None:
            original = generated["fixture"]
    if original:
        h.case("original_to_native_public_abi", lambda: reopen(h, original, "original-to-native"))
        # Inspect an independent copy: no baseline or supplied fixture is opened.
        h.case("original_fixture_schema_and_key", lambda: inspect_schema(h, h.clone(original, "original-inspection"), "original-inspection"))
    else:
        h.case("original_to_native_public_abi", lambda: missing_fixture("original"))
        h.case("original_fixture_schema_and_key", lambda: missing_fixture("original"))
    native_holder = {}

    def generate_native():
        h.native_inputs(True)
        fixture = h.fresh("native-counterpart", seed)
        result = native_generate(h, fixture)
        native_holder["fixture"] = fixture
        return result

    h.case("native_fixture_generation", generate_native)
    native = native_holder.get("fixture")
    for name, action in (
        ("native_chinese_crud", lambda: crud(h, native)),
        ("native_process_restart", lambda: reopen(h, native, "native-restart")),
        ("native_corrupt_key_preservation", lambda: corrupt_key(h, native)),
        ("native_failed_account_switch_isolation", lambda: failed_switch(h, native)),
        ("native_original_schema_and_key", lambda: inspect_schema(h, h.clone(native, "native-inspection"), "native-inspection")),
    ):
        h.case(name, action if native else lambda: missing_fixture("native"))
    capture = None
    capture_error = None
    if native:
        try:
            capture = lifecycle_capture(h, native)
        except Exception as error:
            capture_error = error
    for kind in ("owner_pump", "reentrant_nonblocking_shutdown", "busy_cleanup_reinit", "stale_epoch_rejection"):
        def verdict(kind=kind):
            if capture_error is not None:
                raise capture_error
            if capture is None:
                missing_fixture("native callback lifecycle")
            return lifecycle_verdict(h, capture, kind)
        h.case("native_" + kind, verdict)
    reverse = {}

    def query_original():
        if native is None:
            missing_fixture("native counterpart")
        oracle_prerequisites(h)
        fixture = h.clone(native, "native-to-original")
        reverse["capture"] = oracle_capture(h, fixture, "native-to-original")
        return oracle_data(reverse["capture"])

    h.case("native_to_original_public_abi", query_original)
    if "capture" in reverse:
        h.case("original_reverse_shutdown", lambda: oracle_lifecycle(reverse["capture"]))
    else:
        h.case("original_reverse_shutdown", lambda: missing_fixture("original reverse runtime"))


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--synthetic-only", action="store_true", required=True, help="affirm all supplied fixtures, KMC stores and optional Wine resources are PURE SYNTHETIC")
    parser.add_argument("--slice", choices=("codec", "database", "all"), default="all")
    parser.add_argument("--runner", type=Path, help="explicit prebuilt ia32 native helper (never built implicitly)")
    parser.add_argument("--native-sqlite", type=Path)
    parser.add_argument("--dependency-dir", type=Path, action="append", default=[])
    parser.add_argument("--output", type=Path, required=True, help="NEW output directory; never reuse a production profile")
    parser.add_argument("--corpus", type=Path, default=HERE.parent / "im_transport_vectors_complete.jsonl")
    parser.add_argument("--schema", type=Path, default=HERE / "im-original-schema.json")
    parser.add_argument("--original-fixture", type=Path)
    parser.add_argument("--kmc-seed", type=Path)
    parser.add_argument("--application-seed", type=Path)
    parser.add_argument("--wine", type=Path)
    parser.add_argument("--wine-prefix", type=Path)
    parser.add_argument("--oracle-probe", type=Path)
    parser.add_argument("--oracle-dll", type=Path)
    parser.add_argument("--oracle-dependency-dir", type=Path)
    parser.add_argument("--oracle-launcher", action="append", default=[])
    parser.add_argument("--timeout", type=float, default=90)
    parser.add_argument("--oracle-timeout", type=float, default=90)
    args = parser.parse_args()
    if args.timeout <= 0 or args.oracle_timeout <= 0:
        parser.error("timeouts must be positive")
    return args


def main() -> int:
    os.umask(0o077)
    args = arguments()
    try:
        harness = Harness(args)
    except OSError as error:
        print(f"output prerequisite: {error}", file=sys.stderr)
        return 2
    if args.slice in ("codec", "all"):
        harness.case("codec_all_401_encode_hide_empty_decode_nbr0_nbr1", lambda: codec(harness))
    if args.slice in ("database", "all"):
        database_scenarios(harness)
    harness.save()
    if any(row["status"] == "fail" for row in harness.results):
        return 1
    if any(row["status"] == "blocked" for row in harness.results):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
