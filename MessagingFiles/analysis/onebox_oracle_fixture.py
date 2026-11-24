#!/usr/bin/env python3
"""Parent-run synthetic Onebox oracle; never uses the user's Wine prefix.

Run the ENTIRE driver inside the parent's isolated network namespace with
loopback enabled. It binds only 127.0.0.1 and starts only the supplied probe
under the explicitly supplied private WINEPREFIX. It never runs wineboot,
wineserver, a production executable, or any build command.
The supplied Wine prefix must be a child of the private --output directory
(owned by this user, mode 0700). Do not point either argument at a real profile.
"""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import tempfile
import threading
import time

DATA = bytes(range(256)) * 256
ACCESS_TOKEN = "oracle-access-token"
ONEBOX_TOKEN = "oracle-onebox-token"
REFRESH_TOKEN = "oracle-refresh-token"
SSO_REPLY = {
    "token": ONEBOX_TOKEN,
    "refreshToken": REFRESH_TOKEN,
    "timeout": 3600,
    "objectSid": "oracle-object-sid",
    "cloudUserId": 42,
    "loginName": "oracle-user",
}


def windows_path(path):
    return "Z:" + str(Path(path).resolve()).replace("/", "\\")


def read_callbacks(raw):
    output = []
    cursor = 0
    pattern = re.compile(br"(?m)^CALLBACK ([0-9]+)\n")
    while True:
        match = pattern.search(raw, cursor)
        if not match:
            return output
        length = int(match.group(1))
        start = match.end()
        end = start + length
        if length > 32 * 1024 * 1024 or end > len(raw):
            raise ValueError("truncated or invalid callback frame")
        output.append(json.loads(raw[start:end].decode("utf-8")))
        cursor = end


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe-exe", required=True, type=Path)
    parser.add_argument("--dll-dir", required=True, type=Path)
    parser.add_argument("--wine-prefix", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--wine", default="wine")
    options = parser.parse_args()
    prefix = options.wine_prefix.resolve()
    workspace = options.output.resolve()
    home = Path.home().resolve()
    if (prefix == workspace or not prefix.is_relative_to(workspace) or home.is_relative_to(workspace) or
            any(part in (".wine", ".deepinwine", "drive_c", "dosdevices") for part in prefix.parts)):
        raise SystemExit("Wine prefix must be inside a disposable private --output directory, not a production profile")
    if not workspace.is_dir() or workspace.stat().st_uid != os.getuid() or workspace.stat().st_mode & 0o077:
        raise SystemExit("parent must create the private --output directory with mode 0700")
    if not prefix.is_dir():
        raise SystemExit("parent must initialize the private Wine prefix first")
    if not options.probe_exe.is_file() or not options.dll_dir.is_dir():
        raise SystemExit("compiled probe and copied original SDK directory are required")
    options.output.mkdir(parents=True, exist_ok=True)
    case = Path(tempfile.mkdtemp(prefix="onebox-oracle-", dir=options.output.resolve()))
    case.chmod(0o700)
    (case / "logs").mkdir()
    certificate, key = case / "fixture-ca.pem", case / "fixture-key.pem"
    with (case / "certificate-tool.log").open("wb") as log:
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "1", "-nodes",
            "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
            "-keyout", str(key), "-out", str(certificate),
        ], stdout=log, stderr=log, check=True)
    key.chmod(0o600)
    request_log = []
    request_lock = threading.Lock()

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format, *args):
            pass

        def record(self):
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length else b""
            with request_lock:
                request_log.append({
                    "method": self.command, "path": self.path,
                    "headers": dict(self.headers.items()),
                    "body": body.decode("utf-8", errors="replace"),
                })

        def json_reply(self, status, body):
            encoded = json.dumps(body, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self):
            self.record()
            if self.path == "/api/v2/sso/welink":
                if self.headers.get("x-access-token") != ACCESS_TOKEN:
                    self.json_reply(401, {"error": "unexpected synthetic SSO token"})
                    return
                self.json_reply(200, SSO_REPLY)
                return
            if self.path == "/data":
                # Preserve the original request headers as evidence. An omitted
                # header is observed, not silently replaced by the fixture.
                for name in ("Authorization", "x-usertoken"):
                    value = self.headers.get(name)
                    if value is not None and value != ONEBOX_TOKEN:
                        self.json_reply(401, {"error": "unexpected synthetic download token"})
                        return
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(DATA)))
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    for offset in range(0, len(DATA), 4096):
                        self.wfile.write(DATA[offset:offset + 4096])
                        self.wfile.flush()
                        # Deliberately exercise progress callbacks, not a polling wait.
                        time.sleep(0.2)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return
            self.json_reply(404, {"error": "unexpected oracle URL"})

        def do_DELETE(self):
            self.record()
            if self.path == "/api/v2/token":
                self.json_reply(200, {})
            else:
                self.json_reply(404, {"error": "unexpected oracle URL"})

        def do_POST(self):
            self.record()
            self.json_reply(405, {"error": "no uploads are enabled in this oracle"})

        def do_PUT(self):
            self.record()
            self.json_reply(405, {"error": "no uploads are enabled in this oracle"})

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(certificate), str(key))
    server.socket = context.wrap_socket(server.socket, server_side=True)
    authority = "127.0.0.1:%d" % server.server_port
    origin = "https://" + authority
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    destination = case / "download.bin"
    login = {
        "cmd": 589828, "sno": 1, "description": "tup_offlinefile_login",
        "param": {
            # OfflineLogin requires nonempty rsUrl and prefixes request_url with HTTPS.
            "rsUrl": authority, "request_url": authority, "onebox_address_whitelist": "",
            "log_file_size": {
                "device_version": "1.0.0", "device_sn": "oracle-device", "app_name": "welink",
                "device_type": "PC", "device_cpuid": "oracle-cpu", "device_mac": "oracle-mac",
                "device_uuid": "oracle-uuid", "device_guid": "oracle-guid", "login_type": "0",
                "device_os": "linux", "device_name": "oracle-device", "login_name": "oracle-user",
                "is_sso_login": 1, "access_token": ACCESS_TOKEN, "pass_word": "",
                "server_domain": "", "corp_id": "", "cookie": "oracle-cookie=1",
            },
            "pst_login_info": {
                "kia_disabled": 1, "kia_dll_dir": windows_path(options.dll_dir),
                "en_tls_mode": 1, "local_ip": "127.0.0.1", "time_out": 20000,
                "try_connect_time_out": 10000,
                "reverse_proxy": {"reverse_proxy_ip": "", "reverse_proxy_port": 0},
                "proxy": {"proxy_ip": "", "proxy_port": 0, "proxy_auth_mode": 0,
                          "proxy_user_name": "", "proxy_password": ""},
                "encry_trans": 1, "en_server_mode": 1, "server_expired_at": 1800000,
                "max_file_size": 3221225472, "part_trans": 0,
                "min_part_size": 41943040, "part_trans_size": 5242880,
                "st_tls_para": {"client_cert_path": "", "client_key_kype": "",
                    "en_verify_server_mode": 0, "client_key_path": "", "client_priv_keypw": "",
                    "ca_cert_path": windows_path(certificate), "client_cert_type": ""},
            },
        },
    }
    download = {
        "cmd": 589832, "sno": 2, "description": "tup_offlinefile_downloadfile",
        "param": {"down_file_info": {
            "pplain_access": {"access_code": "", "pcheight": "", "pctype": "", "pcwidth": ""},
            "bkeep_download": 0, "total_length": len(DATA), "pcfile_down_url": origin + "/data",
            "buse_svn_file": False, "bdown_delete": False, "pcfile_path": windows_path(destination),
        }},
    }
    for name, value in [("login.json", login), ("download.json", download), ("sso-response.json", SSO_REPLY)]:
        (case / name).write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")
    env = os.environ.copy()
    env["WINEPREFIX"] = str(prefix)
    env.setdefault("WINEDEBUG", "-all")
    env["NO_PROXY"] = env["no_proxy"] = "127.0.0.1,localhost"
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        env.pop(name, None)
    command = [options.wine, str(options.probe_exe.resolve()), windows_path(options.dll_dir),
               windows_path(case / "login.json"), windows_path(case / "download.json"), windows_path(case / "logs")]
    returncode = None
    try:
        with (case / "probe.stdout").open("wb") as stdout, (case / "probe.stderr").open("wb") as stderr:
            process = subprocess.Popen(command, cwd=options.dll_dir.resolve(), env=env, stdout=stdout, stderr=stderr)
            try:
                returncode = process.wait(timeout=110)
            except subprocess.TimeoutExpired:
                process.kill()  # Only this private probe process; never wineserver or another application.
                returncode = process.wait()
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join()
        (case / "http-requests.json").write_text(json.dumps(request_log, indent=2), encoding="utf-8")
    callbacks = read_callbacks((case / "probe.stdout").read_bytes())
    (case / "callbacks.jsonl").write_text("".join(json.dumps(x, separators=(",", ":")) + "\n" for x in callbacks), encoding="utf-8")
    acks = [x for x in callbacks if x.get("rsp") == 589832]
    progress = [x for x in callbacks if x.get("notify") == 2]
    completed = [x for x in callbacks if x.get("notify") == 1]
    release = [x for x in callbacks if x.get("rsp") == 589834]
    actual = destination.read_bytes() if destination.is_file() else None
    report = {
        "case": str(case), "probe_exit": returncode,
        "initial_ack_count": len(acks), "progress_count": len(progress),
        "completion_count": len(completed), "release_reply_count": len(release),
        "expected_sha256": hashlib.sha256(DATA).hexdigest(),
        "actual_sha256": hashlib.sha256(actual).hexdigest() if actual is not None else None,
        "expected_size": len(DATA), "actual_size": len(actual) if actual is not None else None,
        "bytes_match": actual == DATA,
    }
    report["passed"] = bool(returncode == 0 and acks and acks[-1].get("result") == 0 and completed and release and
        completed[-1].get("param", {}).get("code") == 0 and
        completed[-1].get("param", {}).get("filersp", {}).get("status_code") == 200 and actual == DATA)
    (case / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
