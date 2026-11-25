#!/usr/bin/env python3
"""Parent-only synthetic native Onebox validation (never builds anything).

Dependencies: Python 3.10+, openssl CLI, Linux /proc, an already-built ia32 native
SDK .so and this directory's ia32 helper. Both native objects must use the supplied
PRIVATE STATIC json-c 0.19, not system 0.18. No Wine, original DLL or client runs.

Parent compile, from MessagingFiles (JSON_C_PREFIX is the supplied private ia32
0.19 installation; HELPER is a new output path):
  cc -m32 -std=c11 -O2 -Wall -Wextra -Werror -pthread \\
    -I"$JSON_C_PREFIX/include" analysis/onebox_native_validation.c \\
    "$JSON_C_PREFIX/lib/libjson-c.a" -ldl -lm \\
    -Wl,--export-dynamic-symbol=g_get_monotonic_time -o "$HELPER"
Parent run, after restoring the client and building the SDK separately:
  unshare --user --map-root-user --net sh -c \\
    'ip link set lo up; exec python3 "$1" --helper "$2" --native-so "$3" --output "$4"' \\
    sh analysis/onebox_native_validation.py "$HELPER" "$NATIVE_SO" "$OUTPUT"
The caller must provide a private network namespace with ONLY lo. This CLI fails
closed otherwise; if user namespaces are disabled, the parent must provision an
equivalent network namespace. No host-interface or privileged-network fallback.

Exit 0: passed; 1: protocol/byte/fixture assertion; 2: setup/input failure;
3: owner-thread/shutdown/helper failure (takes precedence over protocol failure).
Artifacts are retained in a fresh mode-0700 directory, including exact callback
strings, decrypted HTTP headers/bodies, received parts, reconstructed commits,
input/output hashes, commands, timings and separate protocol/lifecycle results.
"""
import argparse
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import queue
import re
import select
import socket
import ssl
import struct
import subprocess
import tempfile
import threading
import time
from urllib.parse import parse_qs, urlsplit

BASE = 134242560
LOGIN, UPLOAD, DOWNLOAD, RELEASE, UPDATE = 589828, 589830, 589832, 589834, 589860
PART = 5 * 1024 * 1024
UPLOAD_SIZE = 21 * 1024 * 1024 + 137
DOWNLOAD_SIZE = 1024 * 1024 + 317
PREFIX, SHORT_BODY = 123457, 65537
ACCESS = "native-validation-access-token"
TOKEN = "native-validation-onebox-token"
REFRESH = "native-validation-refresh-token"
NONBLOCK_NS = 750_000_000
PLAIN_ACCESS = "native-validation-link-access"
SSO = {"token": TOKEN, "refreshToken": REFRESH, "timeout": 3600,
       "cloudUserId": 42,  # Valid Onebox sessions need not include the directory attribute objectSid.
       "loginName": "native-validation-user42"}
PRIMARY_HOST = "onebox.com.validation.invalid"
STANDBY_HOST = "onebox.validation.invalid"
ROUTING_SCENE = {
    "scope": "Executable --routing scene; all addresses stay inside the private loopback namespace",
    "evidence": "http_with_rs.dll RVA 0xee30 recursive string flattening and RVA 0x66c0 standby selection",
    "compass_response": {
        "enable": 1, "ttl": 300, "lastUpdateTime": 1,
        "httpDns": [{"domain": PRIMARY_HOST, "ipV4s": ["127.0.0.2"]},
                    {"domain": STANDBY_HOST, "ipV4s": ["127.0.0.1"]}],
        "standbyDomainConfig": {"onebox": STANDBY_HOST},
    },
}


class ProtocolFailure(Exception):
    pass


class LifecycleFailure(Exception):
    pass


def require(condition, message, category=ProtocolFailure):
    if not condition:
        raise category(message)


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def save_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def byte_report(path, expected):
    actual = path.read_bytes() if path.is_file() else None
    result = {"path": str(path), "expected_size": len(expected), "expected_sha256": digest(expected),
              "actual_size": len(actual) if actual is not None else None,
              "actual_sha256": digest(actual) if actual is not None else None,
              "bytes_equal": actual == expected}
    save_json(path.with_name(path.name + ".digest.json"), result)
    require(actual == expected, "byte mismatch: " + str(path))
    return result


def request(command, sno, param, description):
    return {"cmd": command, "sno": sno, "description": description, "param": param}


def login_request(sno, authority, certificate, rs_authority=None):
    require(re.fullmatch(r"(?:127\.0\.0\.1|onebox\.com\.validation\.invalid):[1-9][0-9]*", authority),
            "login requires a literal loopback or synthetic reserved authority")
    rs_authority = rs_authority or authority
    require(re.fullmatch(r"127\.0\.0\.1:[1-9][0-9]*", rs_authority), "RS must be literal loopback")
    return request(LOGIN, sno, {
        "request_url": authority, "rsUrl": rs_authority,
        "onebox_address_whitelist": ",".join(("127.0.0.1", PRIMARY_HOST, STANDBY_HOST)),
        "log_file_size": {
            "device_version": "1.0.0", "device_sn": "native-validation-device", "app_name": "welink",
            "device_type": "PC", "device_cpuid": "synthetic-cpu", "device_mac": "synthetic-mac",
            "device_uuid": "synthetic-uuid", "device_guid": "synthetic-guid", "login_type": "0",
            "device_os": "linux", "device_name": "synthetic-device", "login_name": "synthetic-user42",
            "is_sso_login": 1, "access_token": ACCESS, "pass_word": "", "server_domain": "",
            "corp_id": "", "cookie": "native-validation-cookie=1",
        },
        "pst_login_info": {
            "kia_disabled": 1, "kia_dll_dir": "", "en_tls_mode": 1, "local_ip": "127.0.0.1",
            "time_out": 15000, "try_connect_time_out": 3000,
            "reverse_proxy": {"reverse_proxy_ip": "", "reverse_proxy_port": 0},
            "proxy": {"proxy_ip": "", "proxy_port": 0, "proxy_auth_mode": 0,
                      "proxy_user_name": "", "proxy_password": ""},
            "encry_trans": 1, "en_server_mode": 1, "server_expired_at": 1800000,
            "max_file_size": 3221225472, "part_trans": 1,
            "min_part_size": 20 * 1024 * 1024, "part_trans_size": PART,
            "st_tls_para": {"client_cert_path": "", "client_key_kype": "",
                            "en_verify_server_mode": 1, "client_key_path": "", "client_priv_keypw": "",
                            "ca_cert_path": str(certificate), "client_cert_type": ""},
        },
    }, "tup_offlinefile_login")


def download_request(sno, path, origin, mode, resume=True):
    return request(DOWNLOAD, sno, {"down_file_info": {
        "pplain_access": {"access_code": "", "pcheight": "", "pctype": "", "pcwidth": ""},
        "bkeep_download": int(resume), "total_length": DOWNLOAD_SIZE,
        "pcfile_down_url": origin + "/download/" + mode,
        "buse_svn_file": False, "bdown_delete": False, "pcfile_path": str(path),
    }}, "tup_offlinefile_downloadfile")


def upload_request(sno, source, name, origin, md5, group_resume=False):
    info = {"file_path": str(source), "file_name": name, "parent_id": "0", "group_id": "",
            "use_svn_file": False, "is_cross_instance": False, "public_share_link": False,
            "resume_file_id": "", "resume_up_url": "", "resume_md5": ""}
    if group_resume:
        info.update(group_id="73", resume_file_id="73001", resume_up_url=origin + "/upload/stale-73001", resume_md5=md5)
    return request(UPLOAD, sno, {"up_file_info": info}, "tup_offlinefile_uploadfile")


class HeaderCapture:
    """Capture bytes consumed by http.client.parse_headers without normalizing."""
    def __init__(self, reader):
        self.reader, self.lines = reader, []

    def readline(self, *args):
        value = self.reader.readline(*args)
        self.lines.append(value)
        return value

    def __getattr__(self, name):
        return getattr(self.reader, name)


class Fixture:
    def __init__(self, root, certificate, key, routing=False):
        self.root = root
        self.routing = routing
        self.http = root / "http"
        self.http.mkdir()
        (root / "backend").mkdir()
        self.upload = hashlib.shake_256(b"welink-native-validation-upload-v1").digest(UPLOAD_SIZE)
        self.download = hashlib.shake_256(b"welink-native-validation-download-v1").digest(DOWNLOAD_SIZE)
        self.source = root / "synthetic-upload.bin"
        self.source.write_bytes(self.upload)
        (root / "synthetic-download.bin").write_bytes(self.download)
        self.md5 = hashlib.md5(self.upload).hexdigest()
        self.block_md5 = hashlib.md5(self.upload[:262144]).hexdigest()
        self.access = hashlib.sha256(self.md5.encode("ascii")).hexdigest()[:20]
        self.frames, self.failures = [], []
        self.reject_tls = threading.Event()
        self.tls_rejected = []
        self.lock = threading.Lock()
        self.active = 0
        self.login_done = threading.Event()
        self.renewal_done = threading.Event()
        self.sso = dict(SSO)
        self.renewal_response = None
        self.download_token = TOKEN
        self.gates = {name: threading.Event() for name in ("cancel", "shutdown")}
        self.started = {name: threading.Event() for name in ("cancel", "shutdown")}
        self.backend = {
            "42001": {"owner": "42", "parts": {}, "received": [], "committed": False, "initialized": False},
            "73001": {"owner": "73", "parts": {}, "received": [], "committed": False, "initialized": True},
        }
        # A real synthetic persisted prefix, not an advertised-but-missing part.
        seeds = []
        for part in (1, 2):
            data = self.part_bytes(part)
            self.backend["73001"]["parts"][part] = data
            name = root / "backend" / ("73001-seeded-part-%d.bin" % part)
            name.write_bytes(data)
            seeds.append({"partId": part, "offset": (part - 1) * PART, "path": str(name),
                          "size": len(data), "sha256": digest(data)})
        save_json(root / "backend" / "resume-seed.json", {"owner": "73", "file_id": "73001", "parts": seeds})
        save_json(root / "synthetic-inputs.json", {"user_id": "42", "group_id": "73", "part_size": PART,
                  "upload": {"size": len(self.upload), "sha256": digest(self.upload), "md5": self.md5,
                             "blockMD5": self.block_md5},
                  "download": {"size": len(self.download), "sha256": digest(self.download)}})
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass

            def setup(self):
                super().setup()
                self.connection.settimeout(10)

            def parse_request(self):
                capture = HeaderCapture(self.rfile)
                original = self.rfile
                self.response_blocks = []
                self.rfile = capture
                try:
                    ok = super().parse_request()
                finally:
                    self.rfile = original
                self.request_header_bytes = self.raw_requestline + b"".join(capture.lines)
                return ok

            def end_headers(self):
                self.response_blocks.append(b"".join(getattr(self, "_headers_buffer", [])) + b"\r\n")
                super().end_headers()

            def respond(self, status, body, headers=None, declared_size=None):
                self.frame["status"] = status
                self.send_response(status)
                self.send_header("Content-Length", str(len(body) if declared_size is None else declared_size))
                self.send_header("Content-Type", (headers or {}).get("Content-Type", "application/octet-stream"))
                self.send_header("Connection", "close")
                for name, value in (headers or {}).items():
                    if name != "Content-Type":
                        self.send_header(name, value)
                self.end_headers()
                self.close_connection = True
                self.send_bytes(body)

            def send_bytes(self, data):
                self.wfile.write(data)
                self.wfile.flush()
                self.response_file.write(data)
                self.response_hash.update(data)
                self.frame["response_bytes_written"] += len(data)

            def json_reply(self, status, value):
                self.frame["response_json"] = value
                self.respond(status, compact(value).encode("utf-8"), {"Content-Type": "application/json"})

            def auth(self, token=TOKEN, user=False, absent=False):
                if absent:
                    require(self.headers.get("Authorization") is None and self.headers.get("x-usertoken") is None,
                            "delegated multipart request unexpectedly forwarded session headers")
                else:
                    require(self.headers.get("Authorization") == token, "missing/wrong synthetic Authorization")
                    if user:
                        require(self.headers.get("x-usertoken") == token, "missing/wrong synthetic x-usertoken")

            def object_body(self):
                value = json.loads(self.body.decode("utf-8"))
                require(type(value) is dict, "expected a JSON object request body")
                self.frame["request_json"] = value
                return value

            def route(self):
                local_ip = self.connection.getsockname()[0]
                parsed = urlsplit(self.path)
                require(not parsed.scheme and not parsed.netloc, "absolute-form request not expected")
                path, query = parsed.path, parsed.query
                target_host = "127.0.0.1" if path == "/compass/api/v1/hosts" or not fixture.routing else (
                    PRIMARY_HOST if local_ip == "127.0.0.2" else STANDBY_HOST)
                authority = target_host + ":%d" % fixture.server.server_port
                allowed_hosts = {authority}
                if path == "/api/v2/sso/welink":
                    allowed_hosts.add(target_host)  # Original SSO explicitly omits its port.
                require(self.headers.get("Host") in allowed_hosts, "Host does not match the selected fixture route")
                require(self.frame["sni"] == (None if target_host == "127.0.0.1" else target_host),
                        "TLS SNI does not match the actual target hostname")
                if path == "/compass/api/v1/hosts":
                    self.auth(absent=True)
                    require(self.command == "POST" and not query and
                            self.headers.get("x-access-token") is None and self.headers.get("Cookie") is None,
                            "Compass received a service credential or wrong request method")
                    body = self.object_body()
                    require(set(body) == {"appId", "userTenantId", "userAccount"} and body["appId"] == "6489640385",
                            "Compass request differs from recovered fields")
                    self.json_reply(200, ROUTING_SCENE["compass_response"] if fixture.routing else
                                    {"enable": 0, "ttl": 300, "lastUpdateTime": 1, "httpDns": []})
                    return
                if fixture.routing and local_ip == "127.0.0.2":
                    self.frame["routing_failure"] = True
                    if path in ("/download/full", "/download/range"):
                        self.auth(user=True)
                        offset = PREFIX if path.endswith("/range") else 0
                        require(self.headers.get("Range") == ("bytes=%d-" % offset if offset else None),
                                "retry changed the original resume offset")
                        headers = {"Content-Range": "bytes %d-%d/%d" %
                                   (offset, len(fixture.download) - 1, len(fixture.download))} if offset else {}
                        self.respond(206 if offset else 200, fixture.download[offset:offset + SHORT_BODY],
                                     headers, declared_size=len(fixture.download) - offset)
                    else:
                        if path.startswith("/upload/") and query.startswith("partId="):
                            self.auth(absent=True)
                            values = parse_qs(query, strict_parsing=True)
                            part = int(values["partId"][0])
                            require(self.body == fixture.part_bytes(part),
                                    "first upload route did not read the actual selected source range")
                        self.json_reply(503, {"error": "synthetic-primary-route-failure"})
                    return
                if path == "/api/v2/sso/welink":
                    require(self.command == "GET" and not query and not self.body, "unexpected SSO method/body")
                    require(self.headers.get("x-access-token") == ACCESS, "unexpected SSO token")
                    fixture.download_token = fixture.sso["token"]
                    self.json_reply(200, fixture.sso)
                    fixture.login_done.set()
                    return
                if path == "/api/v2/token":
                    require(self.command == "PUT" and not query and not self.body,
                            "unexpected renewal method/body")
                    self.auth(token=REFRESH)
                    if fixture.renewal_response is None:
                        self.json_reply(503, {"error": "synthetic-renewal-unavailable"})
                    else:
                        fixture.download_token = fixture.renewal_response["token"]
                        self.json_reply(200, fixture.renewal_response)
                    fixture.renewal_done.set()
                    return
                if path.startswith("/download/"):
                    self.auth(token=fixture.download_token, user=True)
                    require(not query, "unexpected download query")
                    mode = path.rsplit("/", 1)[1]
                    if mode == "received":
                        date = self.headers.get("Date")
                        require(self.command == "POST" and date, "received link requires a dated signed POST")
                        signature = base64.b64encode(hashlib.sha256(
                            (PLAIN_ACCESS + "_sep_" + date).encode("ascii")).hexdigest().encode("ascii")).decode("ascii")
                        require(self.object_body() == {"plainAccessCode": signature}, "wrong received-link signature")
                    else:
                        require(self.command == "GET" and not self.body, "unexpected download request")
                    require(mode in ("full", "range", "ignored", "partial", "complete", "cancel", "shutdown", "received"),
                            "unknown synthetic download")
                    require(mode != "complete", "complete local file must skip its body request")
                    offset = PREFIX if mode in ("range", "ignored", "partial") else 0
                    require(self.headers.get("Range") == ("bytes=%d-" % offset if offset else None),
                            "actual Range differs from seeded file length")
                    if mode in ("cancel", "shutdown"):
                        self.respond(200, fixture.download[:65536], declared_size=len(fixture.download))
                        fixture.started[mode].set()
                        require(fixture.gates[mode].wait(12), "lifecycle fixture gate was not opened")
                        for position in range(65536, len(fixture.download), 4096):
                            self.send_bytes(fixture.download[position:position + 4096])
                            time.sleep(0.01)
                        return
                    if mode == "ignored" or not offset:
                        self.respond(200, fixture.download)
                    else:
                        data = fixture.download[offset:]
                        if mode == "partial":
                            data = data[:SHORT_BODY]
                        self.respond(206, data, {"Content-Range": "bytes %d-%d/%d" %
                                     (offset, len(fixture.download) - 1, len(fixture.download))},
                                     declared_size=len(fixture.download) - offset)
                    return
                if path == "/api/v2/files/42/":
                    self.auth()
                    require(self.command == "PUT" and not query, "preupload method or query")
                    body = self.object_body()
                    expected = {"name", "parent", "size", "md5", "blockMD5", "contentCreatedAt", "contentModifiedAt", "encryptKey"}
                    require(set(body) == expected, "preupload fields differ from the established wire shape")
                    require(body["name"] in ("multipart.bin", "dedup.bin") and body["parent"] == "0" and
                            type(body["size"]) is int and body["size"] == len(fixture.upload) and
                            body["md5"] == fixture.md5 and body["blockMD5"] == fixture.block_md5 and
                            body["encryptKey"] == "", "preupload content/hash/field type mismatch")
                    require(all(type(body[k]) is int and 0 <= body[k] <= 0xffffffff for k in
                                ("contentCreatedAt", "contentModifiedAt")), "ia32 millisecond timestamp shape mismatch")
                    if body["name"] == "dedup.bin":
                        require(fixture.backend["42001"]["committed"], "dedup cannot succeed before a verified actual upload")
                        self.json_reply(201, {"fileID": 42001})
                    else:
                        require(not fixture.backend["42001"]["initialized"], "duplicate multipart preupload")
                        self.json_reply(200, {"fileID": 42001, "url": fixture.origin + "/upload/42001"})
                    return
                if path.endswith("/refreshurl"):
                    self.auth()
                    require(self.command == "PUT" and path == "/api/v2/files/73/73001/refreshurl" and not query,
                            "group resume MUST refresh group73, never session user42")
                    require(self.object_body() == {"uploadUrl": fixture.origin + "/upload/stale-73001"},
                            "resume refresh did not use the supplied old uploadUrl")
                    self.json_reply(200, {"uploadUrl": fixture.origin + "/upload/73001"})
                    return
                if path in ("/upload/42001", "/upload/73001"):
                    file_id = path.rsplit("/", 1)[1]
                    backend = fixture.backend[file_id]
                    if self.command == "GET":
                        self.auth(absent=True)
                        require(file_id == "73001" and not query and not self.body, "unexpected multipart list")
                        self.json_reply(200, {"parts": [{"partId": 2}, {"partId": 1}]})
                        return
                    require(self.command == "PUT", "multipart requests must use PUT")
                    if query == "parts":
                        self.auth()
                        require(file_id == "42001" and not self.body and not backend["initialized"],
                                "resume must not reinitialize parts")
                        backend["initialized"] = True
                        self.json_reply(200, {})
                        return
                    self.auth(absent=True)
                    require(backend["initialized"], "part/commit before multipart initialization")
                    if query == "commit":
                        body = self.object_body()
                        count = (len(fixture.upload) + PART - 1) // PART
                        require(body == {"parts": [{"partId": str(i)} for i in range(1, count + 1)]},
                                "commit JSON must contain all five string-valued partIds in order")
                        require(set(backend["parts"]) == set(range(1, count + 1)), "commit refers to missing actual bytes")
                        combined = b"".join(backend["parts"][i] for i in range(1, count + 1))
                        require(combined == fixture.upload, "actual committed bytes/hash do not match the synthetic source")
                        require(backend["received"] == ([1, 2, 3, 4, 5] if file_id == "42001" else [3, 4, 5]),
                                "actual transmitted ranges must follow returned resume parts")
                        destination = fixture.root / "backend" / (file_id + "-committed.bin")
                        destination.write_bytes(combined)
                        backend["commit_digest"] = byte_report(destination, fixture.upload)
                        backend["commit_json"] = body
                        backend["committed"] = True
                        self.json_reply(200, {})
                        return
                    values = parse_qs(query, strict_parsing=True)
                    require(set(values) == {"partId"} and len(values["partId"]) == 1 and
                            re.fullmatch(r"[1-5]", values["partId"][0]), "invalid partId query")
                    part = int(values["partId"][0])
                    expected_bytes = fixture.part_bytes(part)
                    require(part not in backend["parts"], "retransmitted an already-present part")
                    require(self.headers.get_content_type() == "multipart/form-data", "multipart payload content type")
                    require(self.body == expected_bytes, "part %d actual bytes/offset/hash mismatch" % part)
                    backend["parts"][part] = self.body
                    backend["received"].append(part)
                    self.frame["actual_range"] = {"first": (part - 1) * PART,
                        "last": (part - 1) * PART + len(self.body) - 1, "size": len(self.body), "sha256": digest(self.body)}
                    self.json_reply(200, {})
                    return
                if path in ("/api/v2/links/42/42001", "/api/v2/links/73/73001"):
                    self.auth()
                    require(self.command == "POST" and not query, "share link method/query")
                    file_id = path.rsplit("/", 1)[1]
                    require(fixture.backend[file_id]["committed"], "share link requested before verified commit")
                    require(self.object_body() == {"access": "direct", "plainAccessCode": fixture.access},
                            "share link access code must be the first 20 hex digits of SHA256 of the file's MD5 text")
                    self.json_reply(201, {"url": fixture.origin + "/shared/" + file_id,
                                          "plainAccessCode": fixture.access})
                    return
                raise ProtocolFailure("unexpected synthetic endpoint: " + self.command + " " + self.path)

            def serve(self):
                with fixture.lock:
                    index = len(fixture.frames) + 1
                    self.frame = {"index": index, "method": self.command, "path": self.path,
                                  "headers": list(self.headers.raw_items()), "response_bytes_written": 0,
                                  "local_ip": self.connection.getsockname()[0],
                                  "sni": getattr(self.connection, "fixture_sni", None), "done": False}
                    fixture.frames.append(self.frame)
                    fixture.active += 1
                stem = fixture.http / ("%04d" % index)
                self.frame["artifact_prefix"] = str(stem.relative_to(fixture.root))
                Path(str(stem) + ".request.headers").write_bytes(self.request_header_bytes)
                self.response_hash = hashlib.sha256()
                self.response_file = Path(str(stem) + ".response.body").open("wb")
                try:
                    require(self.headers.get("Transfer-Encoding") is None, "unexpected chunked request framing")
                    lengths = self.headers.get_all("Content-Length", [])
                    require(len(lengths) <= 1, "duplicate Content-Length")
                    length = int(lengths[0]) if lengths else 0
                    require(0 <= length <= PART, "unexpected request body size")
                    self.body = self.rfile.read(length)
                    Path(str(stem) + ".request.body").write_bytes(self.body)
                    self.frame["request_size"] = len(self.body)
                    self.frame["request_sha256"] = digest(self.body)
                    require(len(self.body) == length, "truncated client request body")
                    self.route()
                except (BrokenPipeError, ConnectionResetError, ssl.SSLError) as error:
                    self.frame["connection_outcome"] = type(error).__name__
                    if self.path not in ("/download/cancel", "/download/shutdown"):
                        fixture.failure(self.frame, str(error))
                except Exception as error:
                    fixture.failure(self.frame, str(error))
                    if "status" not in self.frame:
                        try:
                            self.json_reply(422, {"error": str(error)})
                        except (OSError, ssl.SSLError):
                            pass
                finally:
                    self.close_connection = True
                    self.response_file.close()
                    Path(str(stem) + ".response.headers").write_bytes(b"".join(self.response_blocks))
                    self.frame["response_sha256"] = self.response_hash.hexdigest()
                    with fixture.lock:
                        self.frame["done"] = True
                        fixture.active -= 1

            do_GET = do_PUT = do_POST = do_DELETE = do_HEAD = do_PATCH = serve

        self.server = http.server.ThreadingHTTPServer(("0.0.0.0" if routing else "127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.server.block_on_close = False
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(certificate, key)
        def server_name(connection, name, _context):
            connection.fixture_sni = name
            if self.reject_tls.is_set():
                self.tls_rejected.append({"sni": name, "peer": connection.getpeername()})
                return ssl.ALERT_DESCRIPTION_HANDSHAKE_FAILURE
        context.set_servername_callback(server_name)
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.rs_authority = "127.0.0.1:%d" % self.server.server_port
        self.authority = (PRIMARY_HOST if routing else "127.0.0.1") + ":%d" % self.server.server_port
        self.origin = "https://" + self.authority
        self.thread = threading.Thread(target=self.server.serve_forever, name="onebox-loopback-tls", daemon=True)
        self.thread.start()

    def part_bytes(self, part):
        return self.upload[(part - 1) * PART:part * PART]

    def failure(self, frame, message):
        frame["failure"] = message
        with self.lock:
            self.failures.append({"frame": frame["index"], "path": frame["path"], "message": message})

    def paths(self):
        with self.lock:
            return [frame["path"] for frame in self.frames]

    def finish(self):
        for gate in self.gates.values():
            gate.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)
        deadline = time.monotonic() + 12
        while self.active and time.monotonic() < deadline:
            time.sleep(0.01)
        if self.active:
            self.failures.append({"message": "fixture request threads failed to finish", "active": self.active})
        save_json(self.root / "http-frames.json", self.frames)
        save_json(self.root / "tls-rejected.json", self.tls_rejected)
        save_json(self.root / "fixture-failures.json", self.failures)
        save_json(self.root / "backend" / "summary.json", {file_id: {
            "owner": value["owner"], "committed": value["committed"], "transmitted_parts": value["received"],
            "part_digests": {str(i): {"size": len(data), "sha256": digest(data)} for i, data in value["parts"].items()},
            "commit_digest": value.get("commit_digest"), "commit_json": value.get("commit_json"),
        } for file_id, value in self.backend.items()})


class Driver:
    def __init__(self, options, root, name, no_proxy="127.0.0.1,localhost"):
        self.root = root / name
        self.root.mkdir()
        for directory in ("home", "tmp", "logs", "config", "cache", "data", "runtime"):
            (self.root / directory).mkdir()
        environment = {"PATH": os.defpath, "LC_ALL": "C", "HOME": str(self.root / "home"),
                       "TMPDIR": str(self.root / "tmp"), "XDG_CONFIG_HOME": str(self.root / "config"),
                       "XDG_CACHE_HOME": str(self.root / "cache"), "XDG_DATA_HOME": str(self.root / "data"),
                       "XDG_RUNTIME_DIR": str(self.root / "runtime"), "NO_PROXY": no_proxy,
                       "no_proxy": no_proxy}
        if options.library_dir:
            environment["LD_LIBRARY_PATH"] = ":".join(str(path.resolve()) for path in options.library_dir)
        self.events, self.callbacks, self.actions = [], [], []
        self.messages = queue.Queue()
        self.command_id = 0
        self.stdout = (self.root / "helper.stdout.jsonl").open("wb")
        self.stderr = (self.root / "helper.stderr").open("wb")
        self.controls = (self.root / "controls.jsonl").open("wb")
        self.closed = False
        try:
            self.process = subprocess.Popen([str(options.helper.resolve()), str(options.native_so.resolve()), str(self.root / "logs")],
                                            cwd=self.root, env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                            stderr=self.stderr, start_new_session=True)
        except Exception:
            self.stdout.close()
            self.stderr.close()
            self.controls.close()
            raise
        self.reader = threading.Thread(target=self.read_output, name="onebox-helper-output", daemon=True)
        self.reader.start()
        try:
            ready = self.receive(10)
            require(ready.get("type") == "ready" and ready.get("pointer_bits") == 32 and ready.get("json_c") == "0.19",
                    "helper ABI/private JSON-C readiness mismatch", LifecycleFailure)
        except Exception:
            self.close(abort=True)
            raise

    def read_output(self):
        try:
            while True:
                line = self.process.stdout.readline(16 * 1024 * 1024)
                if not line:
                    break
                self.stdout.write(line)
                self.stdout.flush()
                try:
                    self.messages.put(json.loads(line))
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    self.messages.put({"reader_error": str(error)})
        finally:
            self.messages.put({"reader_eof": True})

    def receive(self, timeout):
        try:
            message = self.messages.get(timeout=max(0.001, timeout))
        except queue.Empty as error:
            raise LifecycleFailure("native helper timed out; see " + str(self.root)) from error
        require(not message.get("reader_error") and not message.get("reader_eof"),
                "native helper output ended/failed: " + compact(message), LifecycleFailure)
        self.events.append(message)
        if message.get("type") == "callback":
            require(message.get("owner") == 1 and message.get("pumping") == 1 and message.get("depth") == 1 and
                    message.get("after_shutdown") == 0, "callback violated owner/pump/shutdown boundary", LifecycleFailure)
            try:
                frame = json.loads(message["raw"])
            except (json.JSONDecodeError, KeyError) as error:
                raise ProtocolFailure("SDK callback is not complete JSON") from error
            self.callbacks.append({"metadata": message, "frame": frame})
        if message.get("type") == "action":
            self.actions.append(message)
            if "nested_rc" in message:
                require(message["nested_rc"] == 0 and message["nested_callbacks"] == 0,
                        "nested owner pump did not defer", LifecycleFailure)
            for name in ("nested_ns", "release_ns", "shutdown_ns"):
                if name in message:
                    require(0 <= message[name] < NONBLOCK_NS, name + " blocked in an owner callback", LifecycleFailure)
        return message

    def command(self, op, timeout=12, **values):
        self.command_id += 1
        control = {"op": op, "id": self.command_id, **values}
        encoded = (compact(control) + "\n").encode("utf-8")
        self.controls.write(encoded)
        self.controls.flush()
        before = len(self.callbacks)
        try:
            self.process.stdin.write(encoded)
            self.process.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            raise LifecycleFailure("native helper input closed") from error
        deadline = time.monotonic() + timeout
        while True:
            message = self.receive(deadline - time.monotonic())
            if message.get("type") == "control":
                require(message.get("id") == self.command_id and message.get("op") == op,
                        "helper control framing mismatch", LifecycleFailure)
                require(message["violations"] == 0, "native callback boundary violation", LifecycleFailure)
                if op == "pump":
                    require(message["rc"] == len(self.callbacks) - before,
                            "owner pump count differs from actual delivered callbacks", LifecycleFailure)
                return message
            require(time.monotonic() < deadline, "native helper control timed out", LifecycleFailure)

    def ok(self, op, **values):
        reply = self.command(op, **values)
        require(reply["rc"] == 0, op + " failed: " + str(reply["rc"]), LifecycleFailure)
        return reply

    def send(self, value):
        self.ok("send", request=value)

    def wait_frame(self, predicate, timeout=20, start=0):
        deadline = time.monotonic() + timeout
        while True:
            for value in self.callbacks[start:]:
                if predicate(value["frame"]):
                    return value
            require(time.monotonic() < deadline, "expected SDK callback missing before deadline")
            self.command("pump")
            time.sleep(0.01)

    def reply(self, command, sno, timeout=20):
        return self.wait_frame(lambda frame: frame.get("rsp") == command and frame.get("sno") == sno, timeout)

    def completion(self, handle, timeout=30):
        return self.wait_frame(lambda frame: frame.get("notify") == 1 and frame.get("param", {}).get("file_handle") == handle, timeout)

    def wait_action(self, key, timeout=20):
        deadline = time.monotonic() + timeout
        while True:
            found = [action for action in self.actions if key in action]
            if found:
                return found[-1]
            require(time.monotonic() < deadline, "callback reentry action never ran", LifecycleFailure)
            self.command("pump")
            time.sleep(0.01)

    def quiescent(self, seconds=0.2):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.command("pump")
            self.ok("observe", milliseconds=20)

    def close(self, abort=False):
        if self.closed:
            return None
        self.closed = True
        error = None
        try:
            if abort:
                raise LifecycleFailure("helper startup did not become ready")
            if self.process.poll() is None:
                self.ok("exit")
                require(self.process.wait(timeout=3) == 0, "native helper exited with a failure", LifecycleFailure)
            else:
                require(self.process.returncode == 0, "native helper exited prematurely", LifecycleFailure)
        except Exception as failure:
            error = str(failure)
        finally:
            if self.process.poll() is None:
                self.process.kill()  # Only the private helper spawned by this Driver.
                self.process.wait()
            self.reader.join(3)
            self.process.stdin.close()
            self.process.stdout.close()
            self.stdout.close()
            self.stderr.close()
            self.controls.close()
            save_json(self.root / "events.json", self.events)
            save_json(self.root / "callbacks.json", self.callbacks)
            save_json(self.root / "actions.json", self.actions)
            save_json(self.root / "process.json", {"returncode": self.process.returncode, "cleanup_error": error})
        return error


def login(driver, fixture, certificate, sno, boundary=False, proxy_port=None):
    fixture.login_done.clear()
    message = login_request(sno, fixture.authority, certificate, fixture.rs_authority)
    if proxy_port is not None:
        message["param"]["pst_login_info"]["proxy"].update(proxy_ip="127.0.0.1", proxy_port=proxy_port)
    driver.send(message)
    require(fixture.login_done.wait(12), "fixture SSO did not finish")
    if boundary:
        before = len(driver.callbacks)
        observed = driver.ok("observe", milliseconds=200)
        require(before == 0 and observed["callbacks"] == 0, "worker callback arrived before owner pump", LifecycleFailure)
        wrong = driver.command("wrong_pump")
        require(wrong["rc"] == -1 and wrong["callbacks"] == 0, "wrong-thread pump must reject with -EPERM", LifecycleFailure)
        driver.ok("arm", match={"rsp": LOGIN, "sno": sno}, nested=True)
    response = driver.reply(LOGIN, sno)["frame"]
    require(response.get("result") == 0 and response.get("param", {}).get("user_id") == "42" and
            response.get("param", {}).get("plogin_result") == 200, "synthetic user42 SSO failed")
    if boundary:
        driver.wait_action("nested_rc")
    return response


def initial_handle(driver, command, sno):
    ack = driver.reply(command, sno)
    frame = ack["frame"]
    require("notify" not in frame and frame.get("result") == 0, "initial handle acknowledgement failed: " + compact(frame))
    field = "pfile_handle" if command == UPLOAD else "pcfile_handle"
    handle = frame.get("param", {}).get(field)
    require(type(handle) is int and 0 < handle <= 0xffffffff, "initial ack has no valid handle")
    return handle, ack


def assert_completion(driver, handle, ack, upload=False, failure=False, file_id=None, fixture=None, expected_status=200):
    complete = driver.completion(handle)
    frame, param = complete["frame"], complete["frame"].get("param", {})
    require("rsp" not in frame and "result" not in frame and frame.get("notify") == 1,
            "notify1 completion must be distinct from initial rsp acknowledgement")
    require(complete["metadata"]["index"] > ack["metadata"]["index"], "completion preceded handle ack")
    code = param.get("code")
    require(type(code) is int and (code != 0 if failure else code == 0), "unexpected transfer completion code: " + str(code))
    file = param.get("filersp", {})
    require(file.get("handle") == (handle if upload else 0), "download filersp.handle must be 0; upload must retain handle")
    require(file.get("callback_type") == (1 if upload else 2) and file.get("status_code") == expected_status,
            "wrong completion callback type/normalized HTTP status")
    if upload:
        require(file.get("file_id") == file_id and file.get("plain_access_code") == fixture.access and
                file.get("url") == fixture.origin + "/shared/" + file_id, "upload completion is not backed by the actual committed file/link")
    return complete


def release_result(driver, sno, handle, expected):
    driver.send(request(RELEASE, sno, {"file_handle": handle}, "tup_offlinefile_releasefile"))
    reply = driver.reply(RELEASE, sno)["frame"]
    require(reply.get("result") == expected, "active release must succeed; completed/retired handles must return Base+4")
    return reply


def download_case(driver, fixture, mode, sno):
    destination = driver.root / (mode + ".bin")
    if mode in ("range", "partial"):
        destination.write_bytes(fixture.download[:PREFIX])
    elif mode == "ignored":
        destination.write_bytes(b"!" * PREFIX)  # A wrong prefix proves the 200 body resets, not appends.
    elif mode == "complete":
        destination.write_bytes(fixture.download)
    before = fixture.paths().count("/download/" + mode)
    if mode == "full":
        driver.ok("arm", match={"notify": 1}, nested=True, release_sno=sno + 1)
    driver.send(download_request(sno, destination, fixture.origin, mode, resume=mode != "full"))
    handle, ack = initial_handle(driver, DOWNLOAD, sno)
    # The exhausted partial-stream route ends without a final HTTP response;
    # the transfer error code and preserved partial bytes remain mandatory.
    completed = assert_completion(driver, handle, ack, failure=mode == "partial",
                                  expected_status=0 if mode == "partial" else 200)
    expected = fixture.download[:PREFIX + SHORT_BODY] if mode == "partial" else fixture.download
    result = {"ack": ack["frame"], "completion": completed["frame"], "bytes": byte_report(destination, expected),
              "outcome": "expected_transport_failure_with_exact_partial_bytes" if mode == "partial" else "success"}
    if mode == "full":
        action = driver.wait_action("release_sno")
        require(action["release_sno"] == sno + 1 and action["release_handle"] == handle,
                "completion callback reentry used the wrong handle", LifecycleFailure)
        reply = driver.reply(RELEASE, sno + 1)["frame"]
        require(reply.get("result") == BASE + 4, "completed release must return invalid-handle Base+4")
        result["release"] = reply
    else:
        result["release"] = release_result(driver, sno + 1, handle, BASE + 4)
    if mode == "complete":
        require(fixture.paths().count("/download/complete") == before, "already-complete local download unexpectedly used HTTP")
    driver.quiescent()
    require(sum(value["frame"].get("notify") == 1 and value["frame"].get("param", {}).get("file_handle") == handle
                for value in driver.callbacks) == 1, "transfer emitted duplicate completions")
    return result


def received_download(driver, fixture, sno, name):
    destination = driver.root / (name + ".bin")
    message = download_request(sno, destination, fixture.origin, "received", resume=False)
    message["param"]["down_file_info"]["pplain_access"]["access_code"] = PLAIN_ACCESS
    driver.send(message)
    handle, ack = initial_handle(driver, DOWNLOAD, sno)
    completed = assert_completion(driver, handle, ack)
    return {"ack": ack["frame"], "completion": completed["frame"],
            "bytes": byte_report(destination, fixture.download)}


def session_barrier(driver, sno):
    # Wake the idle worker after advancing its clock. A second request after
    # the fixture replies is a queue barrier behind the actual renewal.
    driver.send(request(UPDATE, sno, {"access_token": ACCESS}, "tup_offlinefile_update_token"))
    require(driver.reply(UPDATE, sno)["frame"].get("result") == 0, "session update barrier failed")


def renewal_case(driver, fixture, certificate, sno):

    require(not fixture.renewal_done.is_set(), "renewal fixture must begin with a fresh session")
    driver.ok("advance", seconds=SSO["timeout"] - 119)
    session_barrier(driver, sno)
    require(fixture.renewal_done.wait(12), "SDK did not perform the due renewal; rebuild the clock-enabled helper")
    session_barrier(driver, sno + 1)
    renewals = [frame for frame in fixture.frames if frame["path"] == "/api/v2/token"]
    require(renewals and all(frame.get("status") == 503 for frame in renewals),
            "expected a genuine HTTPS renewal failure")
    accepted = received_download(driver, fixture, sno + 2, "received-after-failed-renewal")

    driver.ok("advance", seconds=121)
    session_barrier(driver, sno + 3)
    before = fixture.paths().count("/download/received")
    expired_path = driver.root / "received-after-expiry.bin"
    driver.send(download_request(sno + 4, expired_path, fixture.origin, "received", resume=False))
    expired = driver.reply(DOWNLOAD, sno + 4)["frame"]
    require(expired.get("result") == BASE + 30 and not expired_path.exists(),
            "expired session must refuse the download before creating a file")
    require(fixture.paths().count("/download/received") == before, "expired session sent a download request")
    require(len([frame for frame in fixture.frames if frame["path"] == "/api/v2/token"]) == len(renewals),
            "failed renewal spun or extended the original grant")

    login(driver, fixture, certificate, sno + 5)
    restored = received_download(driver, fixture, sno + 6, "received-after-relogin")
    return {"renewal_status": 503, "renewal_attempts": len(renewals), "unexpired_download": accepted,
            "expired_download": expired, "relogin_download": restored}


def renewal_boundary_case(driver, fixture, certificate, sno):
    results = []
    try:
        for index, lifetime in enumerate((600, 60)):
            serial = sno + index * 10
            fixture.sso = dict(SSO, timeout=lifetime)
            fixture.renewal_response = {"token": TOKEN + "-renewed-" + str(lifetime),
                                        "refreshToken": REFRESH, "tokenType": "Bearer", "timeout": 3600}
            fixture.renewal_done.clear()
            login(driver, fixture, certificate, serial)
            sso_count = fixture.paths().count("/api/v2/sso/welink")
            before = len(fixture.frames)
            expired = None
            if lifetime < 600:
                # The original minimum renewal timer is 600 seconds, independent
                # of a shorter access grant. Expiry must not cancel that timer.
                driver.ok("advance", seconds=lifetime + 1)
                session_barrier(driver, serial + 1)
                expired_path = driver.root / "short-grant-expired.bin"
                driver.send(download_request(serial + 2, expired_path, fixture.origin, "received", resume=False))
                expired = driver.reply(DOWNLOAD, serial + 2)["frame"]
                require(expired.get("result") == BASE + 30 and not expired_path.exists(),
                        "short grant authorized a download after expiry")
                require(not any(frame["path"] in ("/download/received", "/api/v2/token")
                                for frame in fixture.frames[before:]),
                        "expired short grant used HTTP or renewed before the minimum timer")
                driver.ok("advance", seconds=600 - lifetime)
            else:
                driver.ok("advance", seconds=601)
            session_barrier(driver, serial + 3)
            require(fixture.renewal_done.wait(12), "access-token expiry cancelled the due refresh-token attempt")
            session_barrier(driver, serial + 4)
            renewals = [frame for frame in fixture.frames[before:] if frame["path"] == "/api/v2/token"
                        and not frame.get("routing_failure")]
            require(len(renewals) == 1 and renewals[0].get("status") == 200,
                    "boundary renewal did not obtain exactly one new grant")
            # The server now accepts only the new token; reusing the expired
            # grant fails authentication even if the client reports a handle.
            downloaded = received_download(driver, fixture, serial + 5, "renewed-" + str(lifetime))
            require(fixture.paths().count("/api/v2/sso/welink") == sso_count,
                    "boundary recovery required an unexpected SSO login")
            results.append({"lifetime": lifetime, "expired_download": expired, "renewal_status": 200,
                            "renewed_download": downloaded})
    finally:
        fixture.sso = dict(SSO)
        fixture.renewal_response = None
        login(driver, fixture, certificate, sno + 20)
    return results


def upload_case(driver, fixture, mode, sno):
    group = mode == "group_resume"
    before = len(fixture.frames)
    driver.send(upload_request(sno, fixture.source, "dedup.bin" if mode == "dedup" else "multipart.bin",
                               fixture.origin, fixture.md5, group_resume=group))
    handle, ack = initial_handle(driver, UPLOAD, sno)
    file_id = "73001" if group else "42001"
    completed = assert_completion(driver, handle, ack, upload=True, file_id=file_id, fixture=fixture)
    records = fixture.frames[before:]
    paths = [record["path"] for record in records if not record.get("routing_failure") and
             record["path"] != "/compass/api/v1/hosts"]
    progress = [value["frame"] for value in driver.callbacks if value["frame"].get("notify") == 2 and
                value["frame"].get("param", {}).get("file_handle") == handle]
    multipart = [value for value in driver.callbacks if value["frame"].get("notify") == 5 and
                 value["frame"].get("param", {}).get("file_handle") == handle]
    if mode == "multipart":
        require(len(multipart) == 1, "new multipart upload must emit one real resume descriptor")
        meta = multipart[0]["frame"]["param"]
        require(meta.get("resume_file_id") == "42001" and meta.get("resume_up_url") == fixture.origin + "/upload/42001" and
                meta.get("resume_md5") == fixture.md5, "multipart resume metadata mismatch")
        require(ack["metadata"]["index"] < multipart[0]["metadata"]["index"] < completed["metadata"]["index"],
                "multipart resume notification must occur between ack and completion")
        require(progress, "actual multipart upload emitted no progress")
        require(fixture.backend[file_id]["received"] == [1, 2, 3, 4, 5], "actual >20MiB upload did not transmit five parts")
    elif mode == "dedup":
        require(paths == ["/api/v2/files/42/", "/api/v2/links/42/42001"], "dedup unexpectedly transmitted a body/parts/commit")
        require(not multipart, "dedup fabricated multipart-resume notification")
    else:
        require(paths == ["/api/v2/files/73/73001/refreshurl", "/upload/73001", "/upload/73001?partId=3",
                          "/upload/73001?partId=4", "/upload/73001?partId=5", "/upload/73001?commit",
                          "/api/v2/links/73/73001"], "group73 resume request/range sequence differs from returned parts")
        require(not any("/42/73001" in value for value in fixture.paths()), "group resume used session user42")
        require(fixture.backend[file_id]["received"] == [3, 4, 5], "resume must transmit only ranges following existing parts1/2")
        require(not multipart, "resume after part2 must not fabricate a part1 resume notification")
    return {"ack": ack["frame"], "completion": completed["frame"], "paths": paths, "progress_count": len(progress),
            "release": release_result(driver, sno + 1, handle, BASE + 4),
            "commit_digest": fixture.backend[file_id].get("commit_digest")}

def routing_result(fixture):
    failures = [frame for frame in fixture.frames if frame.get("routing_failure")]
    require(any(frame["path"] == "/api/v2/sso/welink" for frame in failures),
            "routing scene never exercised failed-primary SSO")
    for path in ("/download/full", "/download/range"):
        failed = [frame for frame in failures if frame["path"] == path]
        completed = [frame for frame in fixture.frames if frame["path"] == path and
                     not frame.get("routing_failure") and frame.get("status") in (200, 206)]
        require(failed and all(frame["response_bytes_written"] == SHORT_BODY for frame in failed) and completed,
                "routing scene did not fail over after writing actual partial download bytes")
    parts = [frame for frame in failures if "/upload/" in frame["path"] and "?partId=" in frame["path"]]
    require(parts, "routing scene never replayed a real uploaded part")
    for frame in parts:
        require(any(other["path"] == frame["path"] and not other.get("routing_failure") and
                    other["request_size"] == frame["request_size"] and
                    other["request_sha256"] == frame["request_sha256"] for other in fixture.frames),
                "standby upload did not rewind to identical source bytes")
    return {"primary_host": PRIMARY_HOST, "standby_host": STANDBY_HOST,
            "failed_attempts": len(failures), "replayed_parts": len(parts),
            "verified_tls_sni": sorted({frame["sni"] for frame in fixture.frames if frame["sni"]})}


def lifecycle_cases(driver, fixture, certificate):
    results = {"login_owner_boundary": login(driver, fixture, certificate, 5000, boundary=True)}
    cancel_path = driver.root / "cancel.bin"
    driver.ok("arm", match={"notify": 2}, nested=True, release_sno=5002)
    driver.send(download_request(5001, cancel_path, fixture.origin, "cancel"))
    require(fixture.started["cancel"].wait(5), "active cancellation body never started")
    handle, ack = initial_handle(driver, DOWNLOAD, 5001)
    action = driver.wait_action("release_sno")
    require(action["release_sno"] == 5002 and action["release_handle"] == handle,
            "active callback release did not target its real handle", LifecycleFailure)
    fixture.gates["cancel"].set()
    released = driver.reply(RELEASE, 5002)["frame"]
    require(released.get("result") == 0, "release of active transfer must succeed", LifecycleFailure)
    driver.quiescent(0.3)
    require(not any(value["frame"].get("notify") == 1 and value["frame"].get("param", {}).get("file_handle") == handle
                    for value in driver.callbacks), "active cancellation fabricated a completion", LifecycleFailure)
    actual = cancel_path.read_bytes()
    require(0 < len(actual) < len(fixture.download), "cancel must preserve a real nonempty partial file")
    results["active_cancel"] = {"ack": ack["frame"], "release": released,
        "bytes": byte_report(cancel_path, fixture.download[:len(actual)]),
        "repeat_release": release_result(driver, 5003, handle, BASE + 4), "reentry": action}

    shutdown_path = driver.root / "shutdown.bin"
    driver.send(download_request(5010, shutdown_path, fixture.origin, "shutdown"))
    require(fixture.started["shutdown"].wait(5), "active shutdown body never started")
    shutdown_handle, _ack = initial_handle(driver, DOWNLOAD, 5010)
    driver.ok("arm", match={"rsp": UPDATE, "sno": 5011}, nested=True, shutdown=True)
    for sno in (5011, 5012):
        driver.send(request(UPDATE, sno, {"access_token": ACCESS}, "tup_offlinefile_update_token"))
    # Queue two real worker responses without delivering either; the first owner
    # callback requests shutdown while a real HTTP body is still blocked at TLS.
    driver.ok("observe", milliseconds=200)
    shutdown_action = driver.wait_action("shutdown_ns")
    require(driver.reply(UPDATE, 5011)["frame"].get("result") == 0, "shutdown trigger command failed")
    fixture.gates["shutdown"].set()
    frozen = len(driver.callbacks)
    driver.send(request(UPDATE, 5013, {"access_token": ACCESS}, "after_shutdown_must_be_dropped"))
    driver.quiescent(0.5)
    require(len(driver.callbacks) == frozen, "post-shutdown stale callbacks were delivered", LifecycleFailure)
    deadline = time.monotonic() + 12
    attempts = []
    while True:
        reply = driver.command("init")
        attempts.append({"rc": reply["rc"], "elapsed_ns": reply["elapsed_ns"]})
        require(reply["elapsed_ns"] < NONBLOCK_NS, "reinit blocked on cleanup", LifecycleFailure)
        if reply["rc"] == 0:
            break
        require(reply["rc"] == BASE + 34, "cleanup-busy reinit must return Base+34", LifecycleFailure)
        require(time.monotonic() < deadline, "eventual cleanup/reinit did not finish", LifecycleFailure)
        driver.quiescent(0.02)
        require(len(driver.callbacks) == frozen, "callbacks leaked while cleanup was pending", LifecycleFailure)
    login(driver, fixture, certificate, 5020)
    results["reinit_old_handle"] = release_result(driver, 5021, shutdown_handle, BASE + 4)
    # A new-epoch transfer proves reinit is usable, not just an accepted init call.
    new_path = driver.root / "reinit-complete.bin"
    new_path.write_bytes(fixture.download)
    driver.send(download_request(5022, new_path, fixture.origin, "complete"))
    new_handle, new_ack = initial_handle(driver, DOWNLOAD, 5022)
    require(new_handle not in (handle, shutdown_handle), "reinit reused a stale handle", LifecycleFailure)
    assert_completion(driver, new_handle, new_ack)
    driver.quiescent(0.2)
    for value in driver.callbacks:
        frame = value["frame"]
        require(frame.get("sno") not in (5012, 5013), "shutdown failed to discard queued/post-stop responses", LifecycleFailure)
        if value["metadata"]["index"] > frozen:
            require(value["metadata"]["epoch"] == 2 and
                    frame.get("param", {}).get("file_handle") not in (handle, shutdown_handle),
                    "stale transfer callback crossed the startup epoch", LifecycleFailure)
    actual = shutdown_path.read_bytes()
    require(0 < len(actual) < len(fixture.download), "shutdown must cancel a real active partial body")
    results["shutdown_reentry"] = {"action": shutdown_action, "callbacks_at_shutdown": frozen,
        "cleanup_reinit_attempts": attempts, "cancelled_bytes": byte_report(shutdown_path, fixture.download[:len(actual)]),
        "new_epoch_bytes": byte_report(new_path, fixture.download)}
    return results


class ConnectProxy:
    """Literal-loopback CONNECT relay; TLS is still negotiated with Fixture."""
    def __init__(self, fixture):
        self.fixture, self.frames, self.failures = fixture, [], []
        self.lock = threading.Lock()
        self.active = 0
        proxy = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass

            def do_CONNECT(self):
                self.close_connection = True
                record = {"authority": self.path, "connect_status": None,
                          "client_tls_bytes": 0, "origin_tls_bytes": 0, "done": False}
                with proxy.lock:
                    proxy.frames.append(record)
                    proxy.active += 1
                try:
                    require(self.path == fixture.authority, "proxy target escaped its literal-loopback fixture")
                    require(all(self.headers.get(name) is None for name in
                                ("Authorization", "x-usertoken", "x-access-token", "Cookie")),
                            "CONNECT forwarded an origin credential")
                    self.connection.settimeout(8)
                    with socket.create_connection(("127.0.0.1", fixture.server.server_port), timeout=8) as origin:
                        self.send_response_only(200, "Connection established")
                        self.end_headers()
                        self.wfile.flush()
                        record["connect_status"] = 200
                        peers = (self.connection, origin)
                        while True:
                            ready, _write, _error = select.select(peers, (), (), 8)
                            require(ready, "CONNECT relay timed out")
                            for source in ready:
                                data = source.recv(65536)
                                if not data:
                                    return
                                destination = origin if source is self.connection else self.connection
                                field = "client_tls_bytes" if source is self.connection else "origin_tls_bytes"
                                record[field] += len(data)
                                destination.sendall(data)
                except (ConnectionResetError, BrokenPipeError) as error:
                    record["connection_outcome"] = type(error).__name__
                    if not (fixture.reject_tls.is_set() and record["origin_tls_bytes"]):
                        with proxy.lock:
                            proxy.failures.append(record["connection_outcome"])
                except Exception as error:
                    record["error"] = type(error).__name__ + ": " + str(error)
                    with proxy.lock:
                        proxy.failures.append(record["error"])
                finally:
                    record["done"] = True
                    with proxy.lock:
                        proxy.active -= 1

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.server.block_on_close = False
        self.thread = threading.Thread(target=self.server.serve_forever, name="onebox-connect-proxy", daemon=True)
        self.thread.start()

    def finish(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)
        deadline = time.monotonic() + 10
        while self.active and time.monotonic() < deadline:
            time.sleep(0.01)
        if self.active:
            self.failures.append("CONNECT handlers did not finish")
        save_json(self.fixture.root / "connect-frames.json", self.frames)
        save_json(self.fixture.root / "connect-failures.json", self.failures)


def proxy_tls_failure_case(options, root, ca, certificate, key):
    case = root / "connect-origin-tls-failure"
    case.mkdir()
    fixture = Fixture(case, certificate, key)
    proxy, driver = None, None
    try:
        proxy = ConnectProxy(fixture)
        # Disable only this helper's environment bypass so the explicit proxy
        # is actually exercised for literal 127.0.0.1, including its good SSO.
        driver = Driver(options, case, "driver", no_proxy="")
        driver.ok("init")
        login(driver, fixture, ca, 6000, proxy_port=proxy.server.server_port)
        require(any(frame["connect_status"] == 200 and frame["origin_tls_bytes"] for frame in proxy.frames),
                "SSO did not traverse the real CONNECT tunnel")
        destination = driver.root / "existing-resume-prefix.bin"
        prefix = fixture.download[:PREFIX]
        destination.write_bytes(prefix)
        before_connect, before_http = len(proxy.frames), len(fixture.frames)
        fixture.reject_tls.set()
        driver.send(download_request(6001, destination, fixture.origin, "range"))
        handle, ack = initial_handle(driver, DOWNLOAD, 6001)
        completion = assert_completion(driver, handle, ack, failure=True, expected_status=0)
        preserved = byte_report(destination, prefix)
        attempts = proxy.frames[before_connect:]
        require(fixture.tls_rejected and attempts and
                all(frame["connect_status"] == 200 and frame["client_tls_bytes"] and frame["origin_tls_bytes"]
                    for frame in attempts),
                "expected CONNECT-success followed by an actual origin TLS rejection")
        require(len(fixture.frames) == before_http, "rejected TLS unexpectedly reached an origin HTTP handler")
        return {"ack": ack["frame"], "completion": completion["frame"], "preserved_prefix": preserved,
                "tls_rejections": len(fixture.tls_rejected), "connect_attempts": len(attempts),
                "release": release_result(driver, 6002, handle, BASE + 4)}
    finally:
        cleanup_error = driver.close() if driver else None
        if proxy:
            proxy.finish()
        fixture.finish()
        require(cleanup_error is None, "proxy case native cleanup failed: " + str(cleanup_error), LifecycleFailure)
        require(not fixture.failures and (proxy is None or not proxy.failures),
                "proxy case fixture failed; inspect its retained artifacts")


def elf32(path):
    with path.open("rb") as stream:
        header = stream.read(20)
    require(len(header) == 20 and header[:6] == b"\x7fELF\x01\x01" and struct.unpack_from("<H", header, 18)[0] == 3,
            "must supply an ia32 little-endian ELF, not a DLL/client: " + str(path), ValueError)


def certificate_files(root):
    ca, ca_key = root / "fixture-ca.pem", root / "fixture-ca.key"
    key, csr, certificate = root / "fixture-server.key", root / "fixture-server.csr", root / "fixture-server.pem"
    extensions = root / "fixture-server.ext"
    extensions.write_text("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n"
                          "extendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:" + PRIMARY_HOST +
                          ",DNS:" + STANDBY_HOST + "\n", encoding="ascii")
    commands = [
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "2", "-nodes",
         "-subj", "/CN=Onebox synthetic fixture CA", "-addext", "basicConstraints=critical,CA:TRUE",
         "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", str(ca_key), "-out", str(ca)],
        ["openssl", "req", "-new", "-newkey", "rsa:2048", "-sha256", "-nodes", "-subj", "/CN=127.0.0.1",
         "-keyout", str(key), "-out", str(csr)],
        ["openssl", "x509", "-req", "-in", str(csr), "-CA", str(ca), "-CAkey", str(ca_key), "-set_serial", "42",
         "-days", "2", "-sha256", "-extfile", str(extensions), "-out", str(certificate)],
    ]
    with (root / "certificate-tool.log").open("wb") as log:
        for command in commands:
            subprocess.run(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log, check=True, timeout=20,
                           cwd=root, env={"PATH": os.defpath, "HOME": str(root), "LC_ALL": "C", "OPENSSL_CONF": "/dev/null"})
    return ca, certificate, key


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--helper", type=Path, required=True, help="already-built ia32 onebox_native_validation helper")
    parser.add_argument("--native-so", type=Path, required=True, help="already-built ia32 native OfflineFile SDK .so")
    parser.add_argument("--output", type=Path, default=Path(tempfile.gettempdir()), help="parent directory for a NEW private artifact root")
    parser.add_argument("--library-dir", type=Path, action="append", default=[], help="explicit private ia32 dependency directory (repeatable)")
    parser.add_argument("--routing", action="store_true",
                        help="force verified Compass/standby TLS, partial-download rollback and upload replay")
    parser.add_argument("--renewal-only", action="store_true",
                        help="only failed/expiry-boundary renewals and authenticated received-file downloads")
    options = parser.parse_args()
    os.umask(0o077)
    options.output.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="onebox-native-", dir=options.output.resolve()))
    report = {"root": str(root), "protocol": [], "lifecycle": [], "fixture": [], "setup": [], "passed": False}
    fixture, protocol_driver, lifecycle_driver = None, None, None
    try:
        require({name for _index, name in socket.if_nameindex()} == {"lo"},
                "refusing real networking: run the ENTIRE CLI in a private network namespace with only lo", ValueError)
        for path in (options.helper, options.native_so):
            elf32(path)
        require(os.access(options.helper, os.X_OK), "helper is not executable", ValueError)
        for path in options.library_dir:
            require(path.is_dir(), "private dependency directory is missing: " + str(path), ValueError)
        save_json(root / "invocation.json", {"helper": str(options.helper.resolve()), "native_so": str(options.native_so.resolve()),
                  "helper_sha256": digest(options.helper.read_bytes()), "native_so_sha256": digest(options.native_so.read_bytes()),
                  "library_directories": [str(path.resolve()) for path in options.library_dir], "interfaces": socket.if_nameindex()})
        ca, certificate, key = certificate_files(root)
        save_json(root / "routing-scene.json", dict(ROUTING_SCENE, enabled=options.routing))
        fixture = Fixture(root, certificate, key, options.routing)
        try:
            protocol_driver = Driver(options, root, "protocol-driver")
            protocol_driver.ok("init")
            login(protocol_driver, fixture, ca, 1)
            cases = [("failed-renewal-download", lambda: renewal_case(protocol_driver, fixture, ca, 7000)),
                     ("expiry-boundary-renewal", lambda: renewal_boundary_case(protocol_driver, fixture, ca, 7100))]
            if not options.renewal_only:
                cases.extend((mode, lambda mode=mode, sno=10 + n * 10: download_case(protocol_driver, fixture, mode, sno))
                             for n, mode in enumerate(("full", "range", "ignored", "partial", "complete")))
                cases.extend((mode, lambda mode=mode, sno=100 + n * 10: upload_case(protocol_driver, fixture, mode, sno))
                             for n, mode in enumerate(("multipart", "dedup", "group_resume")))
            for name, run in cases:
                start = time.monotonic()
                try:
                    details = run()
                    report["protocol"].append({"case": name, "passed": True, "seconds": time.monotonic() - start, "details": details})
                except ProtocolFailure as error:
                    report["protocol"].append({"case": name, "passed": False, "error": str(error)})
                save_json(root / "report.json", report)
            if options.routing and not options.renewal_only:
                try:
                    details = routing_result(fixture)
                    report["protocol"].append({"case": "route-failover", "passed": True, "details": details})
                except ProtocolFailure as error:
                    report["protocol"].append({"case": "route-failover", "passed": False, "error": str(error)})
        except LifecycleFailure as error:
            report["lifecycle"].append({"case": "protocol-driver", "passed": False, "error": str(error)})
        except ProtocolFailure as error:
            report["protocol"].append({"case": "login-prerequisite", "passed": False, "error": str(error)})
        finally:
            if protocol_driver:
                error = protocol_driver.close()
                report["lifecycle"].append({"case": "protocol-driver-cleanup", "passed": error is None, "error": error})
        # Separate process and outcomes: a protocol failure does not suppress the
        # owner/cancellation/shutdown exercises and a shutdown failure is not SSO.
        if not options.renewal_only:
            try:
                lifecycle_driver = Driver(options, root, "lifecycle-driver")
                lifecycle_driver.ok("init")
                details = lifecycle_cases(lifecycle_driver, fixture, ca)
                report["lifecycle"].append({"case": "owner-cancel-shutdown-reinit", "passed": True, "details": details})
            except (LifecycleFailure, ProtocolFailure) as error:
                category = "lifecycle" if isinstance(error, LifecycleFailure) else "protocol"
                report[category].append({"case": "owner-cancel-shutdown-reinit", "passed": False, "error": str(error)})
            finally:
                for gate in fixture.gates.values():
                    gate.set()
                if lifecycle_driver:
                    error = lifecycle_driver.close()
                    report["lifecycle"].append({"case": "lifecycle-driver-cleanup", "passed": error is None, "error": error})
            try:
                details = proxy_tls_failure_case(options, root, ca, certificate, key)
                report["protocol"].append({"case": "connect-success-origin-tls-failure", "passed": True, "details": details})
            except (LifecycleFailure, ProtocolFailure) as error:
                category = "lifecycle" if isinstance(error, LifecycleFailure) else "protocol"
                report[category].append({"case": "connect-success-origin-tls-failure", "passed": False, "error": str(error)})
    except Exception as error:
        report["setup"].append({"passed": False, "error": type(error).__name__ + ": " + str(error)})
    finally:
        if fixture:
            try:
                fixture.finish()
            except Exception as error:
                report["setup"].append({"passed": False, "error": "fixture cleanup: " + str(error)})
            report["fixture"] = fixture.failures
        protocol_failed = any(not value["passed"] for value in report["protocol"]) or bool(report["fixture"])
        lifecycle_failed = any(not value["passed"] for value in report["lifecycle"])
        report["exit_code"] = 2 if report["setup"] else 3 if lifecycle_failed else 1 if protocol_failed else 0
        report["passed"] = report["exit_code"] == 0
        save_json(root / "report.json", report)
        print(json.dumps(report, indent=2))
    return report["exit_code"]


if __name__ == "__main__":
    raise SystemExit(main())
