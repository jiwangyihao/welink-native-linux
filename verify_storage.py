#!/usr/bin/env python3
"""Verify the original encrypted ConfigTab format and the common-utils RPC service.

Usage: python3 verify_storage.py /path/to/build/common_utils.dll.so
Uses only synthetic data, including an original-DLL-created encrypted fixture.
Preloads system SQLite globally to catch accidental Electron/NSS interposition.
Original ConfigTab bytes are checked by the source-built native_storage/SQLite3MC
helper only. Sealed-library RPC checks use separately created native databases;
this verifier does not establish original-profile import through the sealed DLL.

--fixture selects a trusted original-DLL capture, never a Linux-generated DB.
The recorded source was /var/tmp/welink-native/fixtures/config-original.json;
the retained r6/r9 source archives do not contain its encrypted payload.
--codec-object selects the matching ia32 build object when the sealed library
directory contains only runtime files. --json-c-dir selects the private ia32
JSON-C prefix. CC/--cc may include compiler arguments; pkg-config honors
PKG_CONFIG_LIBDIR and PKG_CONFIG_SYSROOT_DIR. TMPDIR controls scratch staging.
WELINK_SQLITE_SOURCE selects the pinned SQLite3MC headers matching the codec object.
"""
import argparse
import base64
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

SOURCE = Path(__file__).resolve().parent
DRIVER = r'''
#define _GNU_SOURCE
#include "native_storage.h"
#include <dlfcn.h>
#include <json-c/json.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static int reply(const char *json) {
    puts(json); fflush(stdout); return 0;
}
static int fixture(int argc, char **argv) {
    if (argc != 6) return 2;
    struct native_storage_key key;
    int rc = native_storage_load_key(argv[2], argv[3], argv[5], 0, &key);
    if (rc) { fprintf(stderr,"key error %d\n",rc); return 3; }
    sqlite3 *db = NULL;
    rc = native_storage_open(argv[4], key.password, 0, &db);
    native_storage_clear_key(&key);
    if (rc) { fprintf(stderr,"database error %d\n",rc); return 4; }
    sqlite3_stmt *statement = NULL;
    rc = sqlite3_prepare_v2(db,"SELECT KEY,VALUE FROM ConfigTab ORDER BY KEY",-1,&statement,NULL);
    if (rc) { sqlite3_close(db); return 5; }
    struct json_object *rows = json_object_new_array();
    while ((rc=sqlite3_step(statement))==SQLITE_ROW) {
        struct json_object *row = json_object_new_array();
        json_object_array_add(row,json_object_new_string((const char *)sqlite3_column_text(statement,0)));
        json_object_array_add(row,json_object_new_string((const char *)sqlite3_column_text(statement,1)));
        json_object_array_add(rows,row);
    }
    puts(json_object_to_json_string_ext(rows,JSON_C_TO_STRING_PLAIN));
    json_object_put(rows); sqlite3_finalize(statement); sqlite3_close(db);
    return rc==SQLITE_DONE ? 0 : 6;
}
int main(int argc, char **argv) {
    void *system_sqlite = dlopen("libsqlite3.so.0",RTLD_NOW|RTLD_GLOBAL);
    if (!system_sqlite) { fprintf(stderr,"system SQLite load: %s\n",dlerror()); return 7; }
    if (argc>1 && !strcmp(argv[1],"--fixture")) return fixture(argc,argv);
    if (argc!=2) return 2;
    void *lib = dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);
    if (!lib) { fprintf(stderr,"SDK load: %s\n",dlerror()); return 8; }
    void (*init)(void *) = (void (*)(void *))dlsym(lib,"common_utils_init");
    void (*send)(const char *) = (void (*)(const char *))dlsym(lib,"common_utils_send_msg");
    void (*stop)(void) = (void (*)(void))dlsym(lib,"common_utils_shutdown");
    if (!init || !send || !stop) return 9;
    init((void *)reply);
    char *line=NULL; size_t capacity=0;
    while (getline(&line,&capacity,stdin)>=0) send(line);
    free(line); stop(); dlclose(lib); dlclose(system_sqlite);
    return 0;
}
'''


def build_driver(directory, codec_object, compiler, json_prefix):
    driver = directory / "storage-driver"
    env = dict(os.environ)
    env.setdefault("PKG_CONFIG_LIBDIR", "/usr/lib/i386-linux-gnu/pkgconfig:/usr/share/pkgconfig")
    packages = ["openssl"] if json_prefix else ["openssl", "json-c"]
    sqlite_source = Path(env.get("WELINK_SQLITE_SOURCE") or SOURCE / "vendor/sqlite3mc-1.4.6")
    flags = subprocess.check_output(["pkg-config", "--cflags", "--libs", *packages], env=env, text=True)
    command = shlex.split(compiler) + ["-m32", "-O2", "-fvisibility=hidden", "-pthread",
               "-I", str(sqlite_source), "-I", str(SOURCE), "-x", "c", "-", "-x", "none",
               str(SOURCE / "native_storage.c"), str(SOURCE / "kmc_compat.c"),
               str(codec_object)]
    if json_prefix:
        command += ["-I", str(json_prefix / "include"), str(json_prefix / "lib/libjson-c.a")]
    command += ["-o", str(driver), "-ldl", "-lm"] + shlex.split(flags)
    subprocess.run(command, input=DRIVER, text=True, check=True, timeout=60, env=env)
    return driver


def invoke(driver, library, requests, directory):
    run = subprocess.run([str(driver), str(library)],
                         input="".join(json.dumps(row, ensure_ascii=False)+"\n" for row in requests),
                         text=True, capture_output=True, check=True, timeout=30,
                         env=dict(os.environ, WELINK_NATIVE_LOG=str(directory / "native.log")))
    replies = [json.loads(line) for line in run.stdout.splitlines()]
    assert len(replies) == len(requests), run.stdout + run.stderr + (directory / "native.log").read_text()
    for request, reply in zip(requests, replies):
        assert reply["rsp"] == request["cmd"] and reply["sno"] == request["sno"]
    return replies


def request(cmd, sno, **param):
    return {"cmd": cmd, "sno": sno, "param": param}


def initialize(directory, handle=1, name="confPub.db", sno=1):
    return request(100, sno, dbHandle=handle, dbPath=str(directory), dbName=name,
                   privateEncryptIv="", kmcStorePath=str(directory / "kmc"))


def verify(library, driver, root, original, original_rpc=False):
    original_root = root / "original"
    original_root.mkdir()
    kmc = original_root / "kmc"
    kmc.mkdir()
    metadata = original_root / "config.db"
    metadata.write_text(original["metadata"])
    database = original_root / "confPub.db"
    database.write_bytes(base64.b64decode(original["database"]))
    (kmc / "kmcStore.dat").write_bytes(base64.b64decode(original["keystore"]))
    (kmc / "kmcStore_bak.dat").write_bytes(base64.b64decode(original["keystore_backup"]))
    before = database.read_bytes()
    run = subprocess.run([str(driver), "--fixture", str(metadata), str(kmc), str(database), original["plain"]],
                         text=True, capture_output=True, check=True, timeout=30)
    assert json.loads(run.stdout) == original["rows"]
    assert database.read_bytes() == before, "reading the original fixture rewrote it"
    if original_rpc:
        # Public ABI retains its normal device binding. This test needs a
        # matching synthetic capture, not a caller-supplied plaintext override.
        imported = invoke(driver, library, [initialize(original_root),
                          request(104, 2, dbHandle=1, keyType=1, matchValue=""),
                          request(105, 3, dbHandle=1)], original_root)
        assert [r["result"] for r in imported] == [0, 0, 0], "original public ABI open/query/close failed"
        rows = sorted([r["key"], r["value"]] for r in imported[1]["param"]["dataList"])
        assert rows == sorted(original["rows"]), "public ABI did not return the original rows"
        assert database.read_bytes() == before and metadata.read_text() == original["metadata"]

    directory = root / "native"
    directory.mkdir()
    calls = [initialize(directory),
             request(101, 2, dbHandle=1, key="alpha", value="first"),
             request(102, 3, dbHandle=1, listLen=2,
                     dataList=[{"key":"beta","value":"quote ' and 中文\nline"},
                               {"key":"gamma","value":"third"}]),
             request(104, 4, dbHandle=1, keyType=0, matchValue="alpha"),
             request(104, 5, dbHandle=1, keyType=1, matchValue="ignored"),
             request(104, 6, dbHandle=1, keyType=2, matchValue="alpha,gamma"),
             request(103, 7, dbHandle=1, keyType=0, matchValue="alpha"),
             request(104, 8, dbHandle=1, keyType=0, matchValue="alpha"),
             request(105, 9, dbHandle=1),
             request(104, 10, dbHandle=1, keyType=0, matchValue="beta")]
    replies = invoke(driver, library, calls, directory)
    assert [row["result"] for row in replies] == [0]*9+[5], replies
    assert replies[3]["param"] == {"dataList":[{"key":"alpha","value":"first"}],"listLen":1}
    assert replies[4]["param"]["listLen"] == 3
    assert {row["key"] for row in replies[5]["param"]["dataList"]} == {"alpha","gamma"}
    assert replies[7]["param"] == {"dataList":[],"listLen":0}
    assert all("param" not in replies[index] for index in (0,1,2,6,8))
    encrypted = (directory / "confPub.db").read_bytes()
    assert encrypted[:16] != b"SQLite format 3\x00"
    restored = invoke(driver, library, [initialize(directory),
                       request(104, 2, dbHandle=1, keyType=0, matchValue="beta")], directory)
    assert restored[1]["param"]["dataList"] == [{"key":"beta","value":"quote ' and 中文\nline"}]

    # A damaged key must not silently generate a new one over an existing DB.
    key_path = directory / "config.db"
    damaged = "broken original key metadata"
    key_path.write_text(damaged)
    denied = invoke(driver, library, [initialize(directory)], directory)[0]
    assert denied["result"] != 0
    assert key_path.read_text() == damaged and (directory / "confPub.db").read_bytes() == encrypted

    racing = root / "racing"
    racing.mkdir()
    def create(index):
        return invoke(driver, library, [initialize(racing, name=f"config-{index}.db")], racing)[0]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as workers:
        created = list(workers.map(create, range(4)))
    assert all(row["result"] == 0 for row in created), created
    for index in range(4):
        reopened = invoke(driver, library, [initialize(racing, name=f"config-{index}.db")], racing)[0]
        assert reopened["result"] == 0
    return {"passed":True,"original_fixture_coverage":"sealed-rpc-and-codec" if original_rpc else "source-built-codec-helper-only",
            "sealed_library_original_import":original_rpc,"system_sqlite_preloaded":True,
            "rpc_crud":True,"restart_persistence":True,"corrupt_key_preserved":True,
            "concurrent_key_creators":4}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("library", type=Path)
    parser.add_argument("--fixture", type=Path, default=SOURCE / "fixtures/config-original.json",
                        help="trusted synthetic original-DLL fixture JSON; required, never regenerated by this verifier")
    parser.add_argument("--original-rpc", action="store_true",
                        help="also open the original fixture through the sealed API; requires matching device binding")
    parser.add_argument("--codec-object", type=Path,
                        help="matching ia32 .sqlite3mc.o (default: beside the library)")
    parser.add_argument("--json-c-dir", type=Path,
                        help="private ia32 JSON-C prefix, kept outside PKG_CONFIG_SYSROOT_DIR")
    parser.add_argument("--cc", default=os.environ.get("CC", "gcc"),
                        help="ia32 compiler command, including optional sysroot arguments")
    options = parser.parse_args()
    library = options.library.resolve(strict=True)
    fixture_path = options.fixture.resolve(strict=True)
    fixture_bytes = fixture_path.read_bytes()
    original = json.loads(fixture_bytes)
    codec_object = (options.codec_object or library.parent / ".sqlite3mc.o").resolve(strict=True)
    json_prefix = options.json_c_dir.resolve(strict=True) if options.json_c_dir else None
    if json_prefix and not ((json_prefix / "include/json-c/json.h").is_file()
                            and (json_prefix / "lib/libjson-c.a").is_file()):
        parser.error("--json-c-dir must contain include/json-c/json.h and lib/libjson-c.a")
    with tempfile.TemporaryDirectory(prefix="welink-storage-test-") as temporary:
        root = Path(temporary)
        driver = build_driver(root, codec_object, options.cc, json_prefix)
        result = verify(library, driver, root, original, options.original_rpc)
        result.update(fixture=str(fixture_path), fixture_sha256=hashlib.sha256(fixture_bytes).hexdigest())
        print(json.dumps(result))
