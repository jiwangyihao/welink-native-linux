#!/usr/bin/env python3
"""Capture genuine synthetic storage fixtures with the original Windows DLLs.

This is an offline oracle-data generator, not a Linux acceptance test. It compiles
storage_oracle.c (recovered from the original Main H:2582 oracle), uses a fresh
Wine prefix inside bubblewrap --unshare-all, and records actual DLL callbacks and
encrypted files. No user profile, client, account, network, or Linux SDK is used.

The common_utils/sqlite_plugin identities match original Main H:2273. Capture
recipes retain H:2829/2970/3047 (ConfigTab) and H:2842/2889/3209/3326/3353
(pedestal), including the complete 19 + 8 storage callback contract. These calls
do not include cmd80/91: seal-specific integrity acceptance remains separate.

--output-dir must not exist. It retains generated JSON, DLL identity evidence,
raw oracle requests/stdout/stderr, and the disposable synthetic Wine work tree.
The r6/r9 source archives omitted the old fixture payloads; this generates new
original-DLL fixtures, not byte-for-byte copies of those lost captures.
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import struct
import subprocess

SOURCE = Path(__file__).resolve().parent
PINNED_DLLS = {
    "common_utils.dll": "80ad7e4e68381332b82cc2d05997020adffa4d2ea11343db4e88e7a17ba707bd",
    "resources/app/pedestal/sqlite_plugin.dll": "c1ea0ae307523f8c1210120417c3fd9799b4c6455d917dbbfb71e19e51e4e836",
    "wxsqlite.dll": "b5215064f3218a2e5ec0ac6670c975f0be632ed9e824c40b1148a39c581ea38e",
    "KMC.dll": "ebc3bf6f9f9b4c0c1cbe3b3f0360fdae6b23c6dea588d335d5736dd81e4a3d2e",
    "baseutils.dll": "9fb37fe7245d535999fb720345b1bf7fe9f2c2df47a9267404b3f878c6b59b78",
    "securec.dll": "30a535e7dfd7d9bf1e5bec1222d4b4941208e34654e06cdc7f215c1a0d5fa969",
    "wk_tup_commonlib.dll": "33cb1f36dd5eaffda5cfdf1abe498bb469a6035bab1d38cc108bd480b39cb5f8",
    "wk_tup_os_adapter.dll": "e2f7f8a01154da27b5678fd1bc7bf384da5a4bf1b950d113f1795fbf5b8a98f9",
}
PEDESTAL_FILES = (
    "kmcStore.dat", "kmcStore_bak.dat", "UserData/config.db", "sys.db",
    "UserData/fixture-user/config_private.db", "UserData/fixture-user/user.db",
    "UserData/fixture-user/history.db",
)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require_ia32(path):
    data = path.read_bytes()
    require(data[:2] == b"MZ", f"not a PE file: {path}")
    offset = struct.unpack_from("<I", data, 0x3c)[0]
    require(data[offset:offset + 4] == b"PE\0\0" and
            struct.unpack_from("<H", data, offset + 4)[0] == 0x14c,
            f"not the ia32 PE ABI: {path}")


def save_json(path, data):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def command(cmd, sno, param=None):
    return {"cmd": cmd, "sno": sno, "param": {} if param is None else param}


def winpath(relative):
    return "Z:/tmp/work/" + relative


def parse_records(text, prefix):
    decoder = json.JSONDecoder()
    return [decoder.raw_decode(text[match.end():].lstrip())[0]
            for match in re.finditer(r"(?m)^" + re.escape(prefix), text)]


class Oracle:
    def __init__(self, args, output):
        self.work = output / "work"
        self.work.mkdir(mode=0o700)
        self.evidence = output / "evidence"
        self.evidence.mkdir(mode=0o700)
        for name in ("home", "runtime", "logs", "config", "kmc", "pedestal-ready"):
            (self.work / name).mkdir(mode=0o700)
        vendor = args.vendor_root.resolve(strict=True)
        runtime = args.wine_runtime.resolve(strict=True)
        for name in ("bin/wine", "bin/wineserver", "lib/wine/i386-windows/ntdll.dll"):
            require((runtime / name).is_file(), f"missing Wine WOW64 prerequisite: {runtime / name}")
        for relative, expected in PINNED_DLLS.items():
            path = vendor / relative
            require(sha256(path) == expected, f"original DLL hash mismatch: {path}")
            require_ia32(path)
        sdk = output / "sdk"
        sdk.mkdir(mode=0o700)
        paths = sorted(path for path in vendor.iterdir() if path.suffix.lower() == ".dll" and path.is_file())
        paths.append(vendor / "resources/app/pedestal/sqlite_plugin.dll")
        identities = {}
        for path in paths:
            relative = str(path.relative_to(vendor))
            identities[relative] = sha256(path)
            destination = sdk / path.name
            require(not destination.exists(), f"ambiguous oracle DLL name: {path.name}")
            shutil.copyfile(path, destination)
            require(sha256(destination) == identities[relative], f"DLL staging changed bytes: {path}")
            destination.chmod(0o444)
        driver_source = SOURCE / "storage_oracle.c"
        driver = self.work / "oracle.exe"
        compile_command = shlex.split(args.cc) + ["-O2", "-Wall", "-Wextra", "-static",
                                                    "-o", str(driver), str(driver_source)]
        compiled = subprocess.run(compile_command, text=True, capture_output=True, timeout=120)
        (self.evidence / "compile.stdout").write_text(compiled.stdout)
        (self.evidence / "compile.stderr").write_text(compiled.stderr)
        require(compiled.returncode == 0, "oracle compilation failed; see evidence/compile.stderr")
        require_ia32(driver)
        self.provenance = {
            "generated_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "vendor_root": str(vendor), "vendor_sha256": identities,
            "oracle_source_sha256": sha256(driver_source), "oracle_exe_sha256": sha256(driver),
            "compiler": compile_command, "wine_runtime": str(runtime),
            "wine_sha256": sha256(runtime / "bin/wine"),
            "isolation": "bubblewrap --unshare-all; fresh synthetic prefix; no host home/profile mounts",
            "capture": "real Windows DLL files and callbacks; no Linux SDK loaded",
        }
        save_json(self.evidence / "provenance.json", self.provenance)
        # Mount only OS runtime directories, the selected Wine runtime, DLLs, and
        # newly created work. Do not expose /home, /root, /var or host /tmp.
        self.sandbox = [args.bwrap, "--unshare-all", "--new-session", "--die-with-parent"]
        for name in ("/usr", "/bin", "/lib", "/lib64"):
            if Path(name).exists():
                self.sandbox += ["--ro-bind", name, name]
        self.sandbox += ["--dir", "/etc"]
        if Path("/etc/ld.so.cache").is_file():
            self.sandbox += ["--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache"]
        passwd = self.work / "passwd"
        passwd.write_text(f"fixture:x:{os.getuid()}:{os.getgid()}:Synthetic fixture:/tmp/work/home:/bin/sh\n")
        self.sandbox += ["--ro-bind", str(passwd), "/etc/passwd",
                         "--dir", "/opt", "--ro-bind", str(runtime), "/opt/wine",
                         "--tmpfs", "/tmp", "--ro-bind", str(sdk), "/tmp/sdk",
                         "--bind", str(self.work), "/tmp/work", "--dir", "/home", "--dir", "/root",
                         "--proc", "/proc", "--dev", "/dev", "--chdir", "/tmp/work", "--clearenv"]
        environment = {
            "PATH": "/opt/wine/bin:/usr/bin:/bin", "HOME": "/tmp/work/home",
            "USER": "fixture", "LOGNAME": "fixture", "LC_ALL": "C.UTF-8",
            "WINEPREFIX": "/tmp/work/prefix", "WINEARCH": "win64", "WINEDEBUG": "-all",
            "XDG_RUNTIME_DIR": "/tmp/work/runtime",
            "WINEDLLOVERRIDES": "winemenubuilder.exe=d;mscoree,mshtml=d",
        }
        for key, value in environment.items():
            self.sandbox += ["--setenv", key, value]
        # Cleanup is confined to this fresh prefix inside the network/PID namespace.
        finish = ('/opt/wine/bin/wine "$@"; result=$?; '
                  '/opt/wine/bin/wineserver -k; cleanup=$?; /opt/wine/bin/wineserver -w; '
                  'if [ "$result" -eq 0 ] && [ "$cleanup" -ne 0 ]; then exit "$cleanup"; fi; exit "$result"')
        self.sandbox += ["/bin/sh", "-c", finish, "oracle", r"Z:\tmp\work\oracle.exe"]

    def run(self, name, arguments, text):
        (self.evidence / (name + ".stdin")).write_text(text, encoding="utf-8")
        completed = subprocess.run(self.sandbox + arguments, input=text, text=True,
                                   encoding="utf-8", capture_output=True, timeout=240)
        (self.evidence / (name + ".stdout")).write_text(completed.stdout, encoding="utf-8")
        (self.evidence / (name + ".stderr")).write_text(completed.stderr, encoding="utf-8")
        require(completed.returncode == 0, f"original oracle failed ({completed.returncode}): evidence/{name}.stderr")
        return completed.stdout

    def rpc(self, name, mode, requests, root=None):
        save_json(self.evidence / (name + ".requests.json"), requests)
        expanded = json.loads(json.dumps(requests, ensure_ascii=False).replace("$ROOT", root or ""))
        text = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in expanded)
        replies = parse_records(self.run(name, [mode], text), "REPLY ")
        require(len(replies) == len(expanded), f"oracle callback count mismatch: {name}")
        for request, reply in zip(expanded, replies):
            require(reply.get("rsp") == request["cmd"] and reply.get("sno") == request["sno"],
                    f"oracle callback identity mismatch: {name}: {reply}")
        save_json(self.evidence / (name + ".replies.json"), replies)
        return replies


def config_fixture(oracle):
    values = [["batch.beta", "b"], ["fixture.first", "replacement"],
              ["fixture.second", "quote ' and 中文\nline"]]
    calls = [command(7, 90),
             command(100, 1, {"dbHandle": 1, "dbPath": winpath("config"), "dbName": "confPub.db",
                              "privateEncryptIv": "", "kmcStorePath": winpath("kmc")}),
             command(101, 2, {"dbHandle": 1, "key": "fixture.first", "value": "first value"}),
             command(101, 3, {"dbHandle": 1, "key": "fixture.second", "value": values[2][1]}),
             command(101, 4, {"dbHandle": 1, "key": "fixture.first", "value": "replacement"}),
             command(102, 5, {"dbHandle": 1, "listLen": 2,
                              "dataList": [{"key": "batch.alpha", "value": "a"}, {"key": "batch.beta", "value": "b"}]}),
             command(103, 6, {"dbHandle": 1, "keyType": 0, "matchValue": "batch.alpha"}),
             command(104, 7, {"dbHandle": 1, "keyType": 1, "matchValue": ""}),
             command(105, 8, {"dbHandle": 1})]
    replies = oracle.rpc("config-create", "common", calls)
    require(all(reply["result"] == 0 for reply in replies), "original ConfigTab CRUD failed")
    rows = sorted([[row["key"], row["value"]] for row in replies[-2]["param"]["dataList"]])
    require(rows == values, "original ConfigTab query did not return the synthetic inputs")
    root = oracle.work / "config"
    metadata = (root / "config.db").read_text()
    cipher, nonce = metadata.split("|")
    decoded = oracle.rpc("config-key", "common", [command(107, 101,
                         {"kmcdir": winpath("kmc"), "cipherText": cipher})])[0]
    require(decoded["result"] == 0 and decoded["param"]["PlainText"], "original KMC did not decode its own metadata")
    plain = decoded["param"]["PlainText"]
    database = root / "confPub.db"
    before = database.read_bytes()
    require(not before.startswith(b"SQLite format 3\0"), "original ConfigTab is not encrypted")
    password = hashlib.pbkdf2_hmac("sha256", nonce.encode(), plain.encode(), 4096, 32).hex().upper()
    sql = oracle.run("config-original-codec", ["codec-sql", winpath("config/confPub.db"), password],
                     "SELECT KEY AS fixture_key,VALUE AS fixture_value FROM ConfigTab ORDER BY KEY;\n")
    original_rows = [[row["fixture_key"], row["fixture_value"]] for row in parse_records(sql, "ROW ")]
    require(original_rows == values and database.read_bytes() == before,
            "original wxsqlite read changed bytes or returned unexpected data")
    return {"source": "Original common_utils.dll / wxsqlite.dll, isolated synthetic profile; no account data",
            "provenance": oracle.provenance, "metadata": metadata, "plain": plain,
            "keystore": base64.b64encode((oracle.work / "kmc/kmcStore.dat").read_bytes()).decode(),
            "keystore_backup": base64.b64encode((oracle.work / "kmc/kmcStore_bak.dat").read_bytes()).decode(),
            "database": base64.b64encode(before).decode(), "rows": original_rows}


def pedestal_fixture(oracle):
    root = oracle.work / "pedestal-ready"
    plain, nonce = os.urandom(24).hex(), os.urandom(16).hex()
    seed = oracle.rpc("pedestal-key", "common", [command(106, 401, {
        "plainText": base64.b64encode(plain.encode()).decode(), "kmcdir": winpath("pedestal-ready")})])[0]
    require(seed["result"] == 0 and seed["param"]["CiperText"], "original KMC did not create the synthetic seed")
    salt = {"plainvalue": plain, "vecvalue": nonce, "secvalue": seed["param"]["CiperText"] + "|" + nonce}
    setup = {"_dbpath": "$ROOT", "_logpath": "$ROOT/logs", "_appname": "HIT APP", "_apptype": 1}
    selectors = [{"id": 0, "account": "fixture-selector-" + letter,
                  "displayaccount": "display-" + str(index), "userpwd": "synthetic-password",
                  "isautologin": 0, "isrememberpwd": 0, "tenantcn": "fixture", "tenanten": "fixture",
                  "tenantid": "fixture-tenant", "exparams": {"fixture": True}}
                 for index, letter in enumerate("ab")]
    seed_calls = [command(79, 1, setup), command(77, 2, salt),
                  command(1, 3, {"_dbpath": "0", "_useraccount": "public"}),
                  command(2, 4, {"_keyvalue": {"id": 0, "strkey": "fixture.system", "strvalue": "system value"}}),
                  command(5, 5, {"_logininfo": selectors[0]}), command(5, 6, {"_logininfo": selectors[1]}),
                  command(1, 7, {"_dbpath": "0", "_useraccount": "fixture-user"}),
                  command(25, 8, {"_keyvalue": {"id": 0, "strkey": "fixture.user", "strvalue": "user value"}})]
    seeded = oracle.rpc("pedestal-create", "sqlite", seed_calls, winpath("pedestal-ready"))
    require(all(seeded[index]["result"] == 0 for index in (0, 2, 6)) and
            all(seeded[index]["result"] > 0 for index in (1, 3, 4, 5, 7)),
            "original pedestal did not create all synthetic databases/records")
    files = {name: base64.b64encode((root / name).read_bytes()).decode() for name in PEDESTAL_FILES}
    for name in ("sys.db", "UserData/fixture-user/user.db", "UserData/fixture-user/history.db"):
        require(not (root / name).read_bytes().startswith(b"SQLite format 3\0"), f"original DB is not encrypted: {name}")
    proof = oracle.work / "pedestal-proof"
    shutil.copytree(root, proof)
    login = dict(selectors[0], account="fixture-roundtrip", displayaccount="fixture-display",
                 timestamp="200", exparams='{"fixture":true}')
    batch = [dict(login, account="fixture-batch-" + letter, timestamp=str(201 + index))
             for index, letter in enumerate("ab")]
    records = [{"peeraccount": "fixture-peer", "iscallout": 1, "starttime": 101, "duration": 3, "confid": ""},
               {"peeraccount": "fixture-peer", "iscallout": 0, "starttime": 102, "duration": 7, "confid": "fixture-conf"}]
    page = {"operationtype": 14, "datalen": 2, "datalist": [
        {"keytype": 11, "match_value": "99999"}, {"keytype": 13, "match_value": "20"}]}
    calls = [command(79, 1001, setup), command(78, 1002), command(77, 1003, salt),
             command(1, 1004, {"_dbpath": "0", "_useraccount": "public"}),
             command(2, 1005, {"_keyvalue": {"strkey": "fixture.中文", "strvalue": 'quote" slash\\ 中文\n'}}),
             command(4, 1006, {"_matchinfo": {"keytype": 1, "match_value": "fixture.中文"}}),
             command(5, 1007, {"_logininfo": login}),
             command(7, 1008, {"_matchinfo": {"keytype": 1, "match_value": "FIXTURE-ROUNDTRIP"}}),
             command(92, 1009, {"_arraylen": 2, "_logininfolist": batch}),
             command(7, 1010, {"_matchinfo": {"keytype": 8, "match_value": ""}}),
             command(93, 1011, {"_matchinfo": {"keytype": 1, "arraylen": 2,
                                            "match_values": ["fixture-batch-a", "fixture-batch-b"]}}),
             command(1, 1012, {"_dbpath": "0", "_useraccount": "fixture-user"}),
             command(25, 1013, {"_keyvalue": {"strkey": "fixture.user.中文", "strvalue": "原生-数据库"}}),
             command(27, 1014, {"_matchinfo": {"keytype": 1, "match_value": "fixture.user.中文"}}),
             command(72, 1015, {"_arraylen": 2, "_callrecordinfolist": records}),
             command(74, 1016, {"_multimatchinfo": page}),
             command(74, 1017, {"_multimatchinfo": dict(page, operationtype=16)}),
             command(73, 1018, {"_matchinfo": {"keytype": 7, "match_value": "fixture-conf"}}),
             command(74, 1019, {"_multimatchinfo": page})]
    calls[5]["description"] = "fixture custom description"
    replies = oracle.rpc("pedestal-contract", "sqlite", calls, winpath("pedestal-proof"))
    require(replies[4]["result"] == -1 and replies[12]["result"] == -1,
            "original required-id rejection contract changed")
    require(replies[5]["param"]["_retlen"] == 0 and replies[13]["param"]["_retlen"] == 0,
            "original rejected inserts unexpectedly created records")
    require(replies[7]["param"]["_retlen"] == 1 and
            replies[7]["param"]["_logininfolist"][0]["account"] == "fixture-roundtrip" and
            replies[9]["param"]["_retlen"] == 5,
            "original typed/case-insensitive login or batch contract failed")
    require(replies[15]["param"]["_retlen"] == 2 and replies[18]["param"]["_retlen"] == 1,
            "original call record insert/query/delete contract failed")
    restart = [command(79, 1101, setup), command(77, 1102, salt),
               command(1, 1103, {"_dbpath": "0", "_useraccount": "public"}),
               command(2, 1104, {"_keyvalue": {"id": 0, "strkey": "fixture.中文", "strvalue": 'quote" slash\\ 中文\n'}}),
               command(4, 1105, {"_matchinfo": {"keytype": 1, "match_value": "fixture.中文"}}),
               command(1, 1106, {"_dbpath": "0", "_useraccount": "fixture-user"}),
               command(25, 1107, {"_keyvalue": {"id": 0, "strkey": "fixture.user.中文", "strvalue": "原生-数据库"}}),
               command(27, 1108, {"_matchinfo": {"keytype": 1, "match_value": "fixture.user.中文"}})]
    reopened = oracle.rpc("pedestal-restart", "sqlite", restart, winpath("pedestal-proof"))
    require(reopened[3]["result"] > 0 and reopened[6]["result"] > 0 and
            reopened[4]["param"]["_retlen"] == 1 and reopened[7]["param"]["_retlen"] == 1,
            "original restart/valid-id insertion contract failed")
    require(reopened[4]["param"]["_sysconfiglist"][0]["strvalue"] == restart[3]["param"]["_keyvalue"]["strvalue"] and
            reopened[7]["param"]["_userconfiglist"][0]["strvalue"] == "原生-数据库",
            "original restart did not return the synthetic UTF-8 values")
    return {"source": "Original 32-bit sqlite_plugin.dll; isolated synthetic profile, no real account data",
            "provenance": oracle.provenance, "files": files, "requests": calls, "replies": replies,
            "restart_requests": restart, "restart_replies": reopened}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vendor-root", type=Path, required=True, help="original Windows app root containing common_utils.dll")
    parser.add_argument("--wine-runtime", type=Path, required=True, help="Wine WOW64 install prefix with bin/wine and bin/wineserver")
    parser.add_argument("--cc", required=True, help="ia32 MinGW compiler command; may contain relocation arguments")
    parser.add_argument("--bwrap", default="bwrap")
    parser.add_argument("--output-dir", type=Path, required=True, help="new directory; never an existing profile or fixture directory")
    args = parser.parse_args()
    os.umask(0o077)
    output = args.output_dir.resolve()
    output.mkdir(mode=0o700, parents=True)
    oracle = Oracle(args, output)
    config = config_fixture(oracle)
    pedestal = pedestal_fixture(oracle)
    save_json(output / "config-original.json", config)
    save_json(output / "pedestal-original.json", pedestal)
    summary = {"generated": "original Windows DLL synthetic fixtures", "linux_acceptance_run": False,
               "original_storage_callbacks": len(pedestal["replies"]) + len(pedestal["restart_replies"]),
               "fixtures": {name: {"path": str(output / name), "sha256": sha256(output / name)}
                            for name in ("config-original.json", "pedestal-original.json")},
               "evidence": str(oracle.evidence)}
    save_json(output / "capture.json", summary)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
