#!/usr/bin/env python3
"""Isolated KV regression against the real ia32 C driver and SQLite public ABI.

Nothing builds implicitly. After rebuilding tup_sqlite_logic_api.so, run:
  python3 MessagingFiles/analysis/im_kv_query_regression.py --synthetic-only \
    --runner NativeBuild/validation/im_native_validation \
    --native-sqlite NativeIntegration/lib/tup_sqlite_logic_api.so \
    --dependency-dir NativeIntegration/lib/runtime \
    --kmc-seed /absolute/PURE-SYNTHETIC/KMC-root --output /tmp/im-kv-new

The output directory must not exist. Only a COPY of the explicitly supplied
synthetic KMC seed is used; application/private databases start empty. There
are no profile inputs, network calls, source-text assertions or SQL shortcuts.
Every write/query/delete goes through the C driver's dlopen'd public exports.
Separate driver processes prove persistence, including key-list preferences.
Exit 0 means every assertion passed, 1 is failure, 2 is a missing prerequisite.

The ABI validates UTF-8, so raw 0xff prefixes cannot enter it. The cases below
include valid UTF-8 whose exclusive byte successor is NOT valid UTF-8, plus
empty and embedded-NUL prefixes, without weakening the ABI's parser.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

from im_native_validation import Fixture, Harness, Script, json_write, require


OMITTED = object()
PREFERENCES = ("preference.#expanded", "preference.'font\"scale", "preference.%_notify")
SQL_KEY = "' OR 1=1 --"


def fixture_rows() -> dict[int, list[dict]]:
    keys = {
        "", "#", "#topic", "#topic/one", "#topic'quote", "$topic",
        "'", "'quoted", '"', '"quoted', SQL_KEY, SQL_KEY + "/child",
        "1=1", "1=1/child", "0); DROP TABLE UserCommonKeyValueTab;--",
        "%", "%literal", "_", "_literal", "wild%_", "wild%_/literal",
        "wildAX/decoy", "PAGE#0000", "page$neighbor", "missing-neighbor",
        "汉字", "汉字#偏好", "汉字🧪", "汉语", "é", "é/tail", "ê",
        "\u07ff", "\u07ff/tail", "\u0800", "\U0010ffff", "\U0010ffff/tail",
        "nul", "nul\0", "nul\0/tail", "nula", *PREFERENCES,
        *(f"page#{number:04d}" for number in range(600)),
    }
    # Align primary-key and byte-index order: pagination is reproducible without
    # claiming a new ORDER BY contract for the vendor's unordered SELECTs.
    ordered = sorted(keys, key=lambda key: key.encode("utf-8"))
    result = {}
    for command, database in ((94, "conversation"), (100, "user")):
        result[command] = [
            {"id": number, "key": key,
             "value": json.dumps({"database": database, "key": key, "enabled": True},
                                 ensure_ascii=False, separators=(",", ":"))}
            for number, key in enumerate(ordered, 1)
        ]
    return result


def multi(operation: int, items: list) -> dict:
    return {"operationtype": operation, "datalen": len(items), "datalist": items}


class KVScript(Script):
    def __init__(self, fixture: Fixture, logs: Path):
        super().__init__(fixture, logs)
        self.queries: dict[int, dict] = {}
        self.initialize(fixture)

    def query_rows(self, command: int, match: dict, rows: list[dict], label: str) -> None:
        sno = self.rpc(command, {"_multimatchinfo": match})
        self.queries[sno] = {"label": label, "rows": rows}

    def prefix(self, command: int, rows: list[dict], prefix: str,
               limit=OMITTED, offset=OMITTED) -> None:
        items = [{"keytype": 3, "match_value": prefix}]
        if limit is not OMITTED:
            items.append({"keytype": 4, "match_value": limit})
        if offset is not OMITTED:
            items.append({"keytype": 5, "match_value": offset})
        size = 512 if limit is OMITTED or int(limit) <= 0 else min(int(limit), 512)
        start = 0 if offset is OMITTED else max(int(offset), 0)
        expected = [row for row in rows if row["key"].startswith(prefix)][start:start + size]
        self.query_rows(command, multi(3, items), expected,
                        f"cmd{command} prefix={prefix!r} limit={limit if limit is not OMITTED else 'omitted'} "
                        f"offset={offset if offset is not OMITTED else 'omitted'}")

    def keylist(self, rows: list[dict], values: list, label: str) -> None:
        keys = {key for value in values for key in (value if isinstance(value, list) else [value])}
        expected = [row for row in rows if row["key"] in keys][:512]
        self.query_rows(100, multi(7, [{"keytype": 7, "match_value": value} for value in values]), expected, label)


def run_script(h: Harness, name: str, script: KVScript) -> dict:
    script.close()
    json_write(h.artifacts / f"{name}.kv-expectations.json", script.queries)
    checked = h.checked_script(name, script)
    for sno, expectation in script.queries.items():
        reply = checked["replies"][sno]
        param = reply.get("param")
        label = expectation["label"]
        require(isinstance(param, dict) and type(param.get("_retlen")) is int and
                "_commonkeyvaluelist" in param, f"{label}: missing typed KV list/count: {reply!r}")
        actual = param["_commonkeyvaluelist"]
        if actual is None and param["_retlen"] == 0:
            actual = []
        require(isinstance(actual, list) and len(actual) == param["_retlen"], f"{label}: inconsistent rows/count")
        require(len(actual) <= 512, f"{label}: exceeded vendor serialization cap")
        for row in actual:
            require(isinstance(row, dict) and type(row.get("id")) is int and
                    isinstance(row.get("key"), str) and isinstance(row.get("value"), str),
                    f"{label}: malformed row: {row!r}")
        require(sorted(actual, key=lambda row: row["id"]) == expectation["rows"],
                f"{label}: actual rows differ from exact expected IDs/keys/values; see {name}.events.json")
    return {"artifact": name, "callbacks": len(checked["replies"]), "queries": len(script.queries)}


def seed(h: Harness, fixture: Fixture, rows: dict[int, list[dict]]) -> dict:
    script = KVScript(fixture, h.artifacts / "kv-seed.logs")
    for row in rows[94]:
        script.rpc(91, {"_commonkeyvalue": row}, row["id"])
    bulk = [row for row in rows[100] if row["key"] not in PREFERENCES]
    script.rpc(98, {"_arraylen": len(bulk), "_commonkeyvaluelist": bulk})
    for row in rows[100]:
        if row["key"] in PREFERENCES:
            script.rpc(97, {"_commonkeyvalue": row}, row["id"])
    # cmd92 intentionally targets historydb, not the cmd94 conversation table.
    script.rpc(92, {"_arraylen": 1, "_commonkeyvaluelist": [
        {"id": 100000, "key": "#history-only", "value": "history sentinel"}]})
    script.prefix(94, rows[94], "#history-only")
    return run_script(h, "kv-seed", script)


def prefixes(h: Harness, fixture: Fixture, rows: dict[int, list[dict]]) -> dict:
    script = KVScript(fixture, h.artifacts / "kv-prefixes.logs")
    for command, data in rows.items():
        for prefix in ("#", "#topic", "'", '"', SQL_KEY, "1=1", "0); DROP TABLE",
                       "%", "_", "wild%_", "汉字", "é", "\u07ff", "\U0010ffff",
                       "nul\0", "PAGE#", "not-present"):
            script.prefix(command, data, prefix)
        for limit, offset in (
            (OMITTED, OMITTED), ("0", OMITTED), (0, OMITTED), ("-9", OMITTED),
            (-1, OMITTED), ("1", OMITTED), ("512", OMITTED), ("9999", OMITTED),
            (9223372036854775807, OMITTED), ("3", "2"), (3, 2),
            (OMITTED, "595"), (OMITTED, 2), ("0", "2"), (-1, 595),
            ("5", "-3"), ("5", "600"), (OMITTED, 9223372036854775807),
        ):
            script.prefix(command, data, "page#", limit, offset)
        for limit, offset in ((OMITTED, OMITTED), (0, 2), (OMITTED, 600), (1, 0)):
            script.prefix(command, data, "", limit, offset)
        # Bound numeric inputs retain the existing decimal-prefix conversion;
        # SQL-looking suffixes must never become statements or clauses.
        script.query_rows(command, multi(3, [
            {"keytype": 3, "match_value": "page#"},
            {"keytype": 4, "match_value": "3; DROP TABLE UserCommonKeyValueTab;--"},
            {"keytype": 5, "match_value": "2 OR 1=1"},
        ]), [row for row in data if row["key"].startswith("page#")][2:5], "bound pagination values")
        script.query_rows(command, multi(1, [{"keytype": 1, "match_value": ""}]),
                          [row for row in data if row["key"] == ""], "exact empty key")
        for bad in (None, True, 7, [], {}, ["page#"]):
            script.rpc(command, {"_multimatchinfo": multi(3, [{"keytype": 3, "match_value": bad}])}, -1)
        for bad_match in (None, [], multi(3, []),
                          {"operationtype": 3, "datalen": 2, "datalist": [{"keytype": 3, "match_value": "page#"}]}):
            script.rpc(command, {"_multimatchinfo": bad_match}, -1)
        script.prefix(command, data, "page#", 2, 598)
    return run_script(h, "kv-prefixes", script)


def keylists(h: Harness, fixture: Fixture, data: list[dict]) -> dict:
    script = KVScript(fixture, h.artifacts / "kv-keylists.logs")
    script.keylist(data, [list(PREFERENCES)], "persisted preferences in one keytype7 array")
    script.keylist(data, list(PREFERENCES), "legacy scalar keytype7 items")
    script.keylist(data, [[PREFERENCES[0], "", SQL_KEY], PREFERENCES[1], ["%", "_", "汉字", PREFERENCES[0]]],
                   "mixed arrays/scalars, duplicate keys, empty key, and literal SQL/wildcards")
    script.keylist(data, [[]], "empty key array")
    script.keylist(data, [], "empty datalist")
    script.keylist(data, [[f"page#{number:04d}" for number in reversed(range(600))]], "keylist retains 512 cap")
    for bad in (None, True, 7, {}, [None], [True], [7], [{}], [[]], [PREFERENCES[0], 7]):
        script.rpc(100, {"_multimatchinfo": multi(7, [{"keytype": 7, "match_value": bad}])}, -1)
    for bad_item in (None, True, 7, "not-an-object", []):
        script.rpc(100, {"_multimatchinfo": multi(7, [{"keytype": 7, "match_value": list(PREFERENCES)}, bad_item])}, -1)
    for bad_match in (
        {"operationtype": 7, "datalen": 2, "datalist": [{"keytype": 7, "match_value": list(PREFERENCES)}]},
        {"operationtype": 7, "datalen": 1, "datalist": "not-an-array"},
    ):
        script.rpc(100, {"_multimatchinfo": bad_match}, -1)
    script.keylist(data, [list(PREFERENCES)], "malformed queries leave preferences unchanged")
    return run_script(h, "kv-keylists", script)


def delete_keys(h: Harness, fixture: Fixture, data: list[dict]) -> tuple[dict, list[dict]]:
    script = KVScript(fixture, h.artifacts / "kv-delete.logs")
    for bad in (PREFERENCES[0], None, [PREFERENCES[0], 7], [PREFERENCES[0], {}], [[PREFERENCES[0]]]):
        script.rpc(99, {"_matchinfo": {"keytype": 7, "match_value": bad}}, -1)
    script.keylist(data, [list(PREFERENCES)], "malformed direct deletion is atomic")
    script.rpc(99, {"_matchinfo": {"keytype": 7, "match_value": []}}, 0)
    removed = {PREFERENCES[0], "", SQL_KEY}
    script.rpc(99, {"_matchinfo": {"keytype": 7, "match_value": sorted(removed)}}, 1)
    remaining = [row for row in data if row["key"] not in removed]
    script.keylist(remaining, [list(PREFERENCES), "", SQL_KEY, SQL_KEY + "/child"], "direct cmd99 array deletes only literal keys")
    script.prefix(100, remaining, "page#", 2, 598)
    return run_script(h, "kv-delete", script), remaining


def regression(h: Harness) -> dict:
    fixture = h.fresh("kv-query-fixture", h.args.kmc_seed)
    data = fixture_rows()
    phases = [seed(h, fixture, data), prefixes(h, fixture, data), keylists(h, fixture, data[100])]
    deleted, remaining = delete_keys(h, fixture, data[100])
    phases.append(deleted)
    reopen = KVScript(fixture, h.artifacts / "kv-reopen.logs")
    reopen.keylist(remaining, [list(PREFERENCES), "", SQL_KEY, SQL_KEY + "/child"], "deletions and surviving preferences persist")
    reopen.prefix(100, remaining, "page#", 2, 598)
    reopen.prefix(94, data[94], "", 1)
    phases.append(run_script(h, "kv-reopen", reopen))
    return {"phases": phases, "seed_rows_per_table": len(data[94]), "public_abi_only": True,
            "profiles_used": False, "queries": sum(phase["queries"] for phase in phases)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--synthetic-only", action="store_true", required=True,
                        help="affirm the supplied KMC seed is purely synthetic, never a live profile")
    parser.add_argument("--runner", type=Path, required=True)
    parser.add_argument("--native-sqlite", type=Path, required=True)
    parser.add_argument("--dependency-dir", type=Path, action="append", default=[])
    parser.add_argument("--kmc-seed", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=90)
    parser.set_defaults(application_seed=None)
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    os.umask(0o077)
    try:
        harness = Harness(args)
    except OSError as error:
        print(f"output prerequisite: {error}", file=sys.stderr)
        return 2
    harness.case("kv_public_abi_regression", lambda: regression(harness))
    return 1 if any(row["status"] == "fail" for row in harness.results) else 2 if any(
        row["status"] == "blocked" for row in harness.results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
