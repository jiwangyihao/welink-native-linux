#!/usr/bin/env python3
"""Check pedestal storage against original-DLL synthetic fixtures, without Wine.

Exercises encrypted imports, typed records, persistence, account isolation,
original pagination bounds, and public-key rotation. Never uses a user profile.

--fixture selects a trusted original-DLL capture, never Linux-generated replies.
The recorded source was /var/tmp/welink-native/fixtures/pedestal-original.json;
the retained r6/r9 source archives do not contain its encrypted payload.
CC/--cc may include the ia32 compiler's sysroot arguments. TMPDIR controls
scratch staging; all fixture files are copied into writable private directories.
These storage/import checks do not replace the sealed app's cmd80 integrity check.
"""
import argparse
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

from verify_kmc import encryption

SOURCE = Path(__file__).resolve().parent
DRIVER = r'''
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static int reply(const char *text) { puts(text); fflush(stdout); return 0; }
int main(int argc, char **argv)
{
    if (argc < 2) return 2;
    void *system = dlopen("libsqlite3.so.0", RTLD_NOW | RTLD_GLOBAL);
    if (!system) { fputs(dlerror(), stderr); return 3; }
    void *library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!library) { fputs(dlerror(), stderr); return 4; }
    const char *prefix = argc > 2 ? argv[2] : "tup_sqlite";
    char symbol[128];
    snprintf(symbol, sizeof(symbol), "%s_init", prefix);
    void (*init)(void *) = dlsym(library, symbol);
    snprintf(symbol, sizeof(symbol), "%s_send_msg", prefix);
    void (*send)(const char *) = dlsym(library, symbol);
    snprintf(symbol, sizeof(symbol), "%s_shutdown", prefix);
    void (*shutdown)(void) = dlsym(library, symbol);
    if (!init || !send || !shutdown) return 5;
    init((void *)reply);
    char *line = NULL;
    size_t capacity = 0;
    while (getline(&line, &capacity, stdin) >= 0) send(line);
    free(line);
    shutdown();
    return 0;
}
'''


def command(cmd, sno, param):
    return {"cmd": cmd, "sno": sno, "param": param}


def setup(sno=2000):
    return [command(79, sno, {"_dbpath": "$ROOT", "_kmcpath": "$ROOT", "_logpath": "$ROOT/logs",
                              "_appname": "HIT APP", "_apptype": 1}),
            command(1, sno + 1, {"_dbpath": "0", "_useraccount": "public"})]


def account(name, sno):
    return command(1, sno, {"_dbpath": "0", "_useraccount": name})


def query_login(sno):
    return command(7, sno, {"_matchinfo": {"keytype": 8, "match_value": ""}})


def install_fixture(parent, name, fixture):
    root = parent / name
    root.mkdir(mode=0o700)
    for relative, data in fixture["files"].items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.write_bytes(base64.b64decode(data, validate=True))
        path.chmod(0o600)
    return root


def invoke(driver, library, root, requests, prefix="tup_sqlite"):
    payload = json.dumps(requests, ensure_ascii=False).replace("$ROOT", str(root))
    requests = json.loads(payload)
    # Original-DLL fixture records predate the explicit native KMC context.
    for request in requests:
        if prefix == "tup_sqlite" and request["cmd"] == 79:
            request["param"].setdefault("_kmcpath", request["param"]["_dbpath"])
    run = subprocess.run([str(driver), str(library), prefix],
                         input="".join(json.dumps(row, ensure_ascii=False) + "\n" for row in requests),
                         env=dict(os.environ, WELINK_NATIVE_LOG=str(root.parent / "native-test.log")),
                         text=True, capture_output=True, timeout=60)
    assert run.returncode == 0, (run.returncode, run.stderr)
    replies = [json.loads(line) for line in run.stdout.splitlines() if line.strip()]
    assert len(replies) == len(requests), (len(requests), replies, run.stderr)
    for request, reply in zip(requests, replies):
        assert reply["rsp"] == request["cmd"] and reply["sno"] == request["sno"], reply
    return replies


def contract_param(param):
    result = copy.deepcopy(param)
    # Login exparams is JSON text; JsonCpp's indentation is not its data contract.
    # Call-record exparams is instead a raw string and must remain byte-exact.
    for row in (result or {}).get("_logininfolist") or []:
        if row.get("exparams"):
            row["exparams"] = json.dumps(json.loads(row["exparams"]), sort_keys=True,
                                         ensure_ascii=False, separators=(",", ":"))
    return result


def compare_contract(actual, expected, requests):
    for got, want, request in zip(actual, expected, requests):
        for key in ("rsp", "sno", "result"):
            assert got[key] == want[key], (request["sno"], key, got, want)
        # Error wording is not a storage contract. All successful query data and
        # empty-result shapes are compared; optional null envelopes are equivalent.
        param = want.get("param")
        if param and "reason" not in param:
            assert contract_param(got.get("param")) == contract_param(param), (request["sno"], got, want)
        if "description" in request:
            assert got.get("description") == request["description"], got


def file_hashes(root, names):
    return {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in names}


def verify(library, common, work, fixture, compiler):
    driver = work / "pedestal-driver"
    subprocess.run(shlex.split(compiler) + ["-m32", "-O2", "-Wall", "-Wextra",
                    "-x", "c", "-", "-o", str(driver), "-ldl"],
                   input=DRIVER, text=True, check=True)
    profile = install_fixture(work, "interop", fixture)
    first = invoke(driver, library, profile, fixture["requests"])
    compare_contract(first, fixture["replies"], fixture["requests"])
    restarted = invoke(driver, library, profile, fixture["restart_requests"])
    compare_contract(restarted, fixture["restart_replies"], fixture["restart_requests"])
    for name in ("sys.db", "UserData/fixture-user/user.db", "UserData/fixture-user/history.db"):
        assert not (profile / name).read_bytes().startswith(b"SQLite format 3\0"), name

    bad = install_fixture(work, "bad-key", fixture)
    (bad / "UserData/config.db").write_bytes(b"invalid synthetic metadata")
    before = file_hashes(bad, fixture["files"])
    rejected = invoke(driver, library, bad, setup())
    assert rejected[-1]["result"] != 0, rejected
    assert file_hashes(bad, fixture["files"]) == before

    mismatch = install_fixture(work, "wrong-setter", fixture)
    changed = copy.deepcopy(fixture["requests"][2])
    changed["param"]["plainvalue"] += "-wrong"
    changed["sno"] = 2101
    before = file_hashes(mismatch, fixture["files"])
    result = invoke(driver, library, mismatch, [setup(2100)[0], changed, setup(2102)[1]])
    assert result[1]["result"] == 0 and result[2]["result"] == 0, result
    assert file_hashes(mismatch, fixture["files"]) == before

    isolation = install_fixture(work, "account-isolation", fixture)
    broken = isolation / "UserData/broken-account"
    broken.mkdir(mode=0o700)
    (broken / "config_private.db").write_bytes(b"broken private key")
    requests = setup(2200) + [account("fixture-user", 2202), account("broken-account", 2203),
        command(25, 2204, {"_keyvalue": {"id": 0, "strkey": "fixture.no-leak", "strvalue": "wrong account"}}),
        account("fixture-user", 2205),
        command(27, 2206, {"_matchinfo": {"keytype": 1, "match_value": "fixture.no-leak"}})]
    isolated = invoke(driver, library, isolation, requests)
    assert isolated[2]["result"] == 0 and isolated[3]["result"] != 0, isolated
    assert isolated[4]["result"] == -1 and isolated[-1]["param"]["_retlen"] == 0, isolated

    records = [{"peeraccount": "fixture-bulk", "starttime": 1000 + i,
                "duration": i, "confid": ""} for i in range(600)]
    page = {"operationtype": 14, "datalen": 2, "datalist": [
        {"keytype": 11, "match_value": "99999"}, {"keytype": 13, "match_value": "1000"}]}
    requests = setup(2300) + [account("fixture-user", 2302),
        command(72, 2303, {"_arraylen": len(records), "_callrecordinfolist": records}),
        command(74, 2304, {"_multimatchinfo": page})]
    bounded = invoke(driver, library, profile, requests)
    assert bounded[-2]["result"] == 1, bounded[-2]
    rows = bounded[-1]["param"]["_callrecordlist"]
    assert bounded[-1]["param"]["_retlen"] == 512, bounded[-1]
    assert [row["starttime"] for row in rows] == list(range(1599, 1087, -1))

    rotation = install_fixture(work, "rotation", fixture)
    plain = hashlib.sha256(b"synthetic-public-rekey").hexdigest()[:48]
    nonce = hashlib.sha256(b"synthetic-public-nonce").hexdigest()[:32]
    encrypted = invoke(driver, common, rotation, [encryption(rotation, plain, 2400)], "common_utils")[0]
    assert encrypted["result"] == 0, encrypted
    metadata = encrypted["param"]["CiperText"] + "|" + nonce
    update = command(89, 2404, {"newplainvalue": plain, "newvecvalue": nonce, "newsecvalue": metadata})
    private_names = [name for name in fixture["files"] if name.startswith("UserData/fixture-user/")]
    private_before = file_hashes(rotation, private_names)
    rotated = invoke(driver, library, rotation, setup(2401) + [query_login(2403), update, query_login(2405)])
    assert rotated[3]["result"] == 1, rotated
    assert rotated[2]["param"] == rotated[4]["param"], rotated
    reopened = invoke(driver, library, rotation, setup(2410) + [query_login(2412)])
    assert reopened[-1]["param"] == rotated[2]["param"], reopened
    assert file_hashes(rotation, private_names) == private_before
    before = file_hashes(rotation, fixture["files"])
    invalid = copy.deepcopy(update)
    invalid["param"]["newsecvalue"] = "not-hex|" + nonce
    rejected = invoke(driver, library, rotation, setup(2420) + [invalid, query_login(2423)])
    assert rejected[2]["result"] == 0 and rejected[3]["param"] == reopened[-1]["param"], rejected
    assert file_hashes(rotation, fixture["files"]) == before
    return {"passed": True, "original_callbacks": len(first) + len(restarted),
            "encrypted_import": True, "restart_persistence": True,
            "corrupt_key_preserved": True, "wrong_key_setter_rejected": True,
            "account_isolation": True, "call_history_limit": 512,
            "key_rotation": True, "invalid_rotation_preserved": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("library", type=Path)
    parser.add_argument("--common", type=Path)
    parser.add_argument("--fixture", type=Path, default=SOURCE / "fixtures/pedestal-original.json",
                        help="trusted synthetic original-DLL fixture JSON; required, never regenerated by this verifier")
    parser.add_argument("--cc", default=os.environ.get("CC", "gcc"),
                        help="ia32 compiler command, including optional sysroot arguments")
    args = parser.parse_args()
    library = args.library.resolve(strict=True)
    common = (args.common or library.parent / "common_utils.dll.so").resolve(strict=True)
    fixture_path = args.fixture.resolve(strict=True)
    fixture_bytes = fixture_path.read_bytes()
    fixture = json.loads(fixture_bytes)
    with tempfile.TemporaryDirectory(prefix="welink-pedestal-test-") as directory:
        result = verify(library, common, Path(directory), fixture, args.cc)
        result.update(fixture=str(fixture_path), fixture_sha256=hashlib.sha256(fixture_bytes).hexdigest())
        print(json.dumps(result))
