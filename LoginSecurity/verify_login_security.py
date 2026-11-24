#!/usr/bin/env python3
"""Isolated, real-library validation for the native WeLink login/security slice.

This program is intentionally written for the parent to run, not run by its
implementation worker. It builds a 32-bit owner-thread driver, uses the supplied
32-bit libraries, and serves a stateful synthetic authentication peer over real
loopback TLS. It never disables peer/hostname verification or uses a real account.
All callback objects and dlopen handles remain pinned until driver process exit.

The integrity variant compiles the actual pedestal_integrity.c with a fixed,
nonempty test manifest. Expected digests below are constants, not hashes learned
from files under inspection. No implementation is mocked or replaced.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import dataclasses
import hashlib
import http.server
import json
import os
from pathlib import Path
import queue
import re
import shlex
import shutil
import ssl
import struct
import subprocess
import tempfile
import threading
import time
import urllib.parse


DRIVER_C = r'''
#define _GNU_SOURCE
#include "native_rpc.h"
#include <dlfcn.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

_Static_assert(sizeof(void *)==4,"The validation driver must be 32-bit");
typedef void (*void_callback)(const char *);
typedef void (*init_fn)(void_callback);
typedef void (*send_fn)(const char *);
typedef void (*shutdown_fn)(void);
typedef int (*dispatch_fn)(void);
typedef void (*execute_fn)(const struct native_request *,native_callback);
struct sdk {
    const char *name;
    void *library;
    init_fn init;
    send_fn send;
    shutdown_fn shutdown;
    dispatch_fn dispatch;
    execute_fn execute;
    atomic_uint epoch,index;
    int armed;
    int64_t trigger_sno,trigger_rsp;
    struct json_object *after;
};
static struct sdk sdks[3]={{.name="login"},{.name="security"},{.name="integrity"}};
static pthread_t owner;
static atomic_int in_dispatch;
static pthread_mutex_t output_lock=PTHREAD_MUTEX_INITIALIZER;
static void on_callback(int which,unsigned registration,const char *text);
static void login_0(const char *s) { on_callback(0,0,s); }
static void login_1(const char *s) { on_callback(0,1,s); }
static void security_0(const char *s) { on_callback(1,0,s); }
static void security_1(const char *s) { on_callback(1,1,s); }
static int integrity_0(const char *s) { on_callback(2,0,s); return 0; }
static int integrity_1(const char *s) { on_callback(2,1,s); return 0; }
static void_callback void_callbacks[2][2]={{login_0,login_1},{security_0,security_1}};
static native_callback integrity_callbacks[2]={integrity_0,integrity_1};

static void string_field(struct json_object *o,const char *key,const char *value)
{ json_object_object_add(o,key,json_object_new_string(value)); }
static void integer_field(struct json_object *o,const char *key,int64_t value)
{ json_object_object_add(o,key,json_object_new_int64(value)); }
static void boolean_field(struct json_object *o,const char *key,int value)
{ json_object_object_add(o,key,json_object_new_boolean(value)); }
static void output(struct json_object *o)
{
    const char *text=json_object_to_json_string_ext(o,JSON_C_TO_STRING_PLAIN);
    pthread_mutex_lock(&output_lock);
    if(text) { fputs(text,stdout); fputc('\n',stdout); fflush(stdout); }
    pthread_mutex_unlock(&output_lock);
    json_object_put(o);
}
static void fatal(const char *reason)
{
    struct json_object *o=json_object_new_object();
    string_field(o,"event","fatal"); string_field(o,"reason",reason); output(o);
    _exit(2);
}
static void *symbol(void *library,const char *name)
{
    dlerror(); void *value=dlsym(library,name);
    if(dlerror() || !value) fatal("required native symbol is unavailable");
    return value;
}
static unsigned sdk_number(const char *name)
{
    for(unsigned i=0;i<3;i++) if(!strcmp(name,sdks[i].name)) return i;
    fatal("unknown SDK name"); return 0;
}
static void initialize(unsigned which)
{
    struct sdk *s=&sdks[which];
    s->epoch++; s->index=s->epoch&1u;
    if(which<2) s->init(void_callbacks[which][s->index]);
    /* Integrity has no init export: its real execute entry starts a new epoch. */
}
static void send_object(unsigned which,struct json_object *message)
{
    if(!json_object_is_type(message,json_type_object)) fatal("send payload is not an object");
    const char *text=json_object_to_json_string_ext(message,JSON_C_TO_STRING_PLAIN);
    if(!text) fatal("cannot encode driver request");
    struct sdk *s=&sdks[which];
    if(which<2) s->send(text);
    else {
        struct native_request request;
        if(native_parse(&request,text)) fatal("invalid integrity request");
        s->execute(&request,integrity_callbacks[s->index]);
        native_release(&request);
    }
}
static void on_callback(int which,unsigned registration,const char *text)
{
    int on_owner=pthread_equal(pthread_self(),owner);
    struct sdk *s=&sdks[which];
    struct json_object *message=text?json_tokener_parse(text):NULL;
    if(!json_object_is_type(message,json_type_object)) fatal("native callback is not JSON object");
    struct json_object *event=json_object_new_object();
    string_field(event,"event","callback"); string_field(event,"sdk",s->name);
    boolean_field(event,"owner",on_owner);
    boolean_field(event,"during_dispatch",atomic_load(&in_dispatch)!=0);
    boolean_field(event,"registration_matches",registration==s->index);
    integer_field(event,"driver_epoch",s->epoch);
    json_object_object_add(event,"message",json_object_get(message));
    output(event);
    if(on_owner && s->armed && native_integer(message,"sno",-1)==s->trigger_sno &&
       (s->trigger_rsp<0 || native_integer(message,"rsp",-1)==s->trigger_rsp)) {
        s->armed=0;
        struct json_object *after=s->after; s->after=NULL;
        struct timespec begin,end;
        clock_gettime(CLOCK_MONOTONIC,&begin);
        s->shutdown();
        initialize((unsigned)which);
        for(size_t i=0;i<json_object_array_length(after);i++)
            send_object((unsigned)which,json_object_array_get_idx(after,i));
        int nested=s->dispatch();
        clock_gettime(CLOCK_MONOTONIC,&end);
        struct json_object *done=json_object_new_object();
        string_field(done,"event","reinit_done"); string_field(done,"sdk",s->name);
        integer_field(done,"driver_epoch",s->epoch);
        integer_field(done,"recursive_dispatch",nested);
        integer_field(done,"elapsed_ns",(int64_t)(end.tv_sec-begin.tv_sec)*1000000000+end.tv_nsec-begin.tv_nsec);
        output(done); json_object_put(after);
    }
    json_object_put(message);
}
int main(void)
{
    owner=pthread_self();
    char *line=NULL; size_t capacity=0;
    while(getline(&line,&capacity,stdin)>=0) {
        struct json_object *command=json_tokener_parse(line);
        if(!json_object_is_type(command,json_type_object)) fatal("invalid driver command");
        const char *action=native_string(command,"action","");
        int64_t id=native_integer(command,"id",-1);
        if(!strcmp(action,"quit")) { json_object_put(command); free(line); _exit(0); }
        unsigned which=sdk_number(native_string(command,"sdk",""));
        struct sdk *s=&sdks[which]; int delivered=0;
        if(!strcmp(action,"load")) {
            if(s->library) fatal("SDK already loaded");
            s->library=dlopen(native_string(command,"path",""),RTLD_NOW|RTLD_LOCAL);
            if(!s->library) fatal("cannot load real 32-bit SDK or one of its dependencies");
            if(which==0) {
                s->init=(init_fn)symbol(s->library,"welink_login_init");
                s->send=(send_fn)symbol(s->library,"welink_login_send_msg");
                s->shutdown=(shutdown_fn)symbol(s->library,"welink_login_shutdown");
                s->dispatch=(dispatch_fn)symbol(s->library,"welink_login_dispatch");
            } else if(which==1) {
                s->init=(init_fn)symbol(s->library,"welink_security_init");
                s->send=(send_fn)symbol(s->library,"welink_security_send_msg");
                s->shutdown=(shutdown_fn)symbol(s->library,"welink_security_shutdown");
                s->dispatch=(dispatch_fn)symbol(s->library,"welink_security_dispatch");
            } else {
                s->execute=(execute_fn)symbol(s->library,"pedestal_integrity_execute");
                s->shutdown=(shutdown_fn)symbol(s->library,"pedestal_integrity_shutdown");
                s->dispatch=(dispatch_fn)symbol(s->library,"pedestal_integrity_dispatch");
            }
        } else {
            if(!s->library) fatal("SDK was not loaded");
            if(!strcmp(action,"init")) initialize(which);
            else if(!strcmp(action,"shutdown")) s->shutdown();
            else if(!strcmp(action,"send")) send_object(which,native_get(command,"message"));
            else if(!strcmp(action,"pump")) {
                atomic_fetch_add(&in_dispatch,1);
                delivered=s->dispatch();
                atomic_fetch_sub(&in_dispatch,1);
                if(delivered<0 || delivered>64) fatal("native dispatch returned invalid delivered count");
            } else if(!strcmp(action,"arm_reinit")) {
                struct json_object *after=native_get(command,"after");
                if(!json_object_is_type(after,json_type_array)) fatal("reinit sequence is not an array");
                json_object_put(s->after); s->after=json_object_get(after);
                s->trigger_sno=native_integer(command,"trigger_sno",-1);
                s->trigger_rsp=native_integer(command,"trigger_rsp",-1);
                s->armed=1;
            } else fatal("unknown driver action");
        }
        struct json_object *ack=json_object_new_object();
        string_field(ack,"event","ack"); string_field(ack,"sdk",s->name);
        string_field(ack,"action",action); integer_field(ack,"id",id);
        integer_field(ack,"delivered",delivered); output(ack);
        json_object_put(command);
    }
    free(line); _exit(0);
}
'''

# Fixed nonempty baseline. These constants are never derived from inspected files.
INTEGRITY_FILES = {"assets/one.dat": b"abc", "assets/two.dat": b"hello\n"}
INTEGRITY_MANIFEST = '''\
static const struct pedestal_integrity_asset pedestal_native_integrity_assets[] = {
    {"assets/one.dat", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"},
    {"assets/two.dat", "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"}
};
static const char pedestal_native_integrity_build[] = "synthetic-native-baseline-v1";
'''


class Failure(RuntimeError):
    pass


def require(condition, reason: str):
    if not condition:
        raise Failure(reason)


def command(args, *, data: bytes | None = None, env=None, timeout=120) -> bytes:
    """Subprocess execution is for the parent running this script only."""
    result = subprocess.run([str(x) for x in args], input=data, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env, timeout=timeout)
    if result.returncode:
        # No HTTP payloads, device identities, private keys or tokens in failure logs.
        raise Failure(f"{Path(str(args[0])).name} failed with exit status {result.returncode}")
    return result.stdout


class Driver:
    def __init__(self, executable: Path, sdk: str, library: Path, env: dict,
                 timeout: float, cwd: Path):
        self.sdk, self.timeout = sdk, timeout
        self.callbacks: list[dict] = []
        self.events: list[dict] = []
        self.acks: dict[int, dict] = {}
        self.serial = 0
        self.inbox: queue.Queue = queue.Queue()
        self.proc = subprocess.Popen([str(executable)], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     text=True, bufsize=1, env=env, cwd=cwd)
        self.reader = threading.Thread(target=self._reader, daemon=True)
        self.stderr_reader = threading.Thread(target=self._discard_stderr, daemon=True)
        self.reader.start(); self.stderr_reader.start()
        try:
            self.call("load", path=str(library))
            self.call("init")
        except BaseException:
            self.close()
            raise

    def _reader(self):
        try:
            for line in self.proc.stdout:
                try:
                    self.inbox.put(json.loads(line))
                except (ValueError, TypeError):
                    self.inbox.put({"event": "fatal", "reason": "non-JSON driver output"})
        except (OSError, ValueError):
            pass
        finally:
            self.inbox.put({"event": "eof"})

    def _discard_stderr(self):
        # SDK output is not assumed safe to publish. Preserve no unredacted log.
        try:
            for _line in self.proc.stderr:
                pass
        except (OSError, ValueError):
            pass

    def _accept(self, event: dict):
        kind = event.get("event")
        if kind == "fatal":
            raise Failure("native driver failure: " + str(event.get("reason", "unspecified")))
        if kind == "eof":
            raise Failure("native driver exited unexpectedly")
        if kind == "ack":
            self.acks[event["id"]] = event
        elif kind == "callback":
            require(event.get("owner") is True, "SDK invoked a callback on a worker thread")
            require(event.get("during_dispatch") is True, "SDK invoked a callback without owner pumping")
            require(event.get("registration_matches") is True, "old callback registration leaked into new init")
            require(isinstance(event.get("message"), dict), "callback has no structured message")
            self.callbacks.append(event["message"])
            self.events.append(event)
        elif kind == "reinit_done":
            require(event.get("recursive_dispatch") == 0, "recursive owner dispatch was not suppressed")
            require(event.get("elapsed_ns", 10**12) < 2_000_000_000,
                    "callback shutdown/re-init blocked the owner thread")
            self.events.append(event)
        else:
            raise Failure("unknown driver event")

    def _receive(self, timeout: float):
        try:
            self._accept(self.inbox.get(timeout=max(0.001, timeout)))
        except queue.Empty:
            if self.proc.poll() is not None:
                raise Failure("native driver terminated during an SDK operation")

    def call(self, action: str, **values) -> dict:
        self.serial += 1
        identity = self.serial
        packet = {"id": identity, "sdk": self.sdk, "action": action, **values}
        try:
            self.proc.stdin.write(json.dumps(packet, separators=(",", ":")) + "\n")
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError):
            raise Failure("native driver pipe closed") from None
        deadline = time.monotonic() + min(self.timeout, 5.0)
        while identity not in self.acks:
            if time.monotonic() >= deadline:
                raise Failure(f"owner thread blocked in {action}")
            self._receive(deadline-time.monotonic())
        return self.acks.pop(identity)

    def send(self, message: dict):
        self.call("send", message=message)

    def pump(self):
        return self.call("pump")["delivered"]

    def wait_message(self, predicate, *, timeout=None, since=0, peer=None) -> dict:
        deadline = time.monotonic() + (self.timeout if timeout is None else timeout)
        while True:
            for message in self.callbacks[since:]:
                if predicate(message):
                    return message
            if peer is not None:
                peer.check_errors()
            if time.monotonic() >= deadline:
                raise Failure("timed out waiting for an actual native callback")
            self.pump()
            self._receive(min(0.01, max(0.001, deadline-time.monotonic())))

    def response(self, command_id: int, sno: int, **kw) -> dict:
        return self.wait_message(lambda m: m.get("rsp") == command_id and m.get("sno") == sno, **kw)

    def idle(self, seconds: float, *, pump: bool, peer=None):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if peer is not None:
                peer.check_errors()
            if pump:
                self.pump()
            self._receive(min(0.02, max(0.001, deadline-time.monotonic())))

    def close(self):
        if not hasattr(self, "proc"):
            return
        if self.proc.poll() is None:
            try:
                self.proc.stdin.write('{"action":"quit"}\n'); self.proc.stdin.flush()
                self.proc.wait(timeout=1)
            except (OSError, subprocess.TimeoutExpired):
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.proc.kill(); self.proc.wait(timeout=2)
        self.reader.join(timeout=1); self.stderr_reader.join(timeout=1)
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            if stream is not None:
                with contextlib.suppress(OSError, ValueError):
                    stream.close()

    def __enter__(self):
        return self

    def __exit__(self, _kind, _value, _traceback):
        self.close()


def message(cmd: int, sno: int, param=None, description=None) -> dict:
    value = {"cmd": cmd, "sno": sno, "description": description or f"synthetic-command-{cmd}"}
    if param is not None:
        value["param"] = param
    return value


@dataclasses.dataclass
class Crypto:
    openssl: str
    directory: Path
    ca: Path
    other_ca: Path
    tls_cert: Path
    wrong_name_cert: Path
    tls_key: Path
    login_key: Path
    public_key: str
    sign_cert: Path
    sign_key: Path

    @classmethod
    def create(cls, openssl: str, directory: Path):
        directory.mkdir()
        ca_key, ca = directory/"ca.key", directory/"ca.crt"
        tls_key, tls_csr, tls_cert = directory/"tls.key", directory/"tls.csr", directory/"tls.crt"
        other_key, other_ca = directory/"other-ca.key", directory/"other-ca.crt"
        sign_key, sign_cert = directory/"sign.key", directory/"sign.crt"
        for key, cert, name, usage in ((ca_key, ca, "Synthetic Loopback CA", "keyCertSign,cRLSign"),
                                       (other_key, other_ca, "Synthetic Unrelated CA", "keyCertSign,cRLSign"),
                                       (sign_key, sign_cert, "Synthetic Envelope Signer", "digitalSignature")):
            command([openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
                     "-subj", "/CN="+name, "-keyout", key, "-out", cert,
                     "-addext", "basicConstraints=critical,CA:"+("FALSE" if key==sign_key else "TRUE"),
                     "-addext", "keyUsage=critical,"+usage])
        command([openssl, "req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256",
                 "-subj", "/CN=localhost", "-keyout", tls_key, "-out", tls_csr])
        ext = directory/"tls.ext"
        ext.write_text("subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\n"
                       "keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n")
        command([openssl, "x509", "-req", "-in", tls_csr, "-CA", ca, "-CAkey", ca_key,
                 "-set_serial", "42", "-days", "2", "-sha256", "-extfile", ext, "-out", tls_cert])
        wrong_name_cert = directory/"wrong-name.crt"
        wrong_ext = directory/"wrong-name.ext"
        wrong_ext.write_text("subjectAltName=DNS:synthetic-wrong-name.invalid\n"
                             "basicConstraints=critical,CA:FALSE\n"
                             "keyUsage=critical,digitalSignature,keyEncipherment\n"
                             "extendedKeyUsage=serverAuth\n")
        command([openssl, "x509", "-req", "-in", tls_csr, "-CA", ca, "-CAkey", ca_key,
                 "-set_serial", "43", "-days", "2", "-sha256", "-extfile", wrong_ext,
                 "-out", wrong_name_cert])
        command([openssl, "verify", "-CAfile", ca, wrong_name_cert])
        login_key = directory/"login.key"
        command([openssl, "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:3072", "-out", login_key])
        public = command([openssl, "pkey", "-in", login_key, "-pubout", "-outform", "DER"])
        return cls(openssl, directory, ca, other_ca, tls_cert, wrong_name_cert, tls_key, login_key,
                   base64.b64encode(public).decode("ascii"), sign_cert, sign_key)

    def decrypt(self, encoded: str) -> str:
        require(isinstance(encoded, str) and bool(encoded), "RSA result is empty or not a string")
        try:
            cipher = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError):
            raise Failure("RSA result is not Base64") from None
        require(len(cipher) > 0 and len(cipher) % 384 == 0, "RSA ciphertext has incorrect 3072-bit block framing")
        plain = bytearray()
        for offset in range(0, len(cipher), 384):
            plain.extend(command([self.openssl, "pkeyutl", "-decrypt", "-inkey", self.login_key,
                                  "-pkeyopt", "rsa_padding_mode:oaep", "-pkeyopt", "rsa_oaep_md:sha1",
                                  "-pkeyopt", "rsa_mgf1_md:sha1"], data=cipher[offset:offset+384]))
        try:
            return plain.decode("utf-8")
        except UnicodeDecodeError:
            raise Failure("RSA plaintext does not match the required UTF-8 format") from None


@dataclasses.dataclass
class Grant:
    name: str
    mode: str = "qr"
    username: str = "synthetic-user"
    password: str = "Synthetic password #42"
    tenant: str = "synthetic-tenant"
    auth_value: str = "synthetic-contact"
    response: object = None
    status: int = 200
    hold: bool = False
    seen: threading.Event = dataclasses.field(default_factory=threading.Event)
    sent: threading.Event = dataclasses.field(default_factory=threading.Event)
    release: threading.Event = dataclasses.field(default_factory=threading.Event)

    def __post_init__(self):
        if self.response is None:
            self.response = {"crypt_token": "synthetic-token-"+self.name,
                             "refresh_token": "synthetic-refresh-"+self.name,
                             "uid": "synthetic-uid", "userType": self.tenant,
                             "expires_in": 3600, "refresh_expires_in": 7200,
                             "oneboxUrl": "https://localhost/synthetic-onebox",
                             "desktopMaa": "https://localhost/synthetic-maa",
                             "meetingurl": "https://localhost/synthetic-meeting",
                             "ssoLoginUrl": "https://localhost/synthetic-sso",
                             "tenantAdminPortal": "https://localhost/synthetic-admin",
                             "phoneNumber": "synthetic-phone", "countryCode": "synthetic-country",
                             "email": "synthetic@example.invalid", "needChangePassword": "1",
                             "expiredPwdTip": "synthetic-tip", "setPasswordToken": "synthetic-set-password",
                             "x-wlk-gray": 7, "hmenus": [{"fixture_marker": "menu"}],
                             "welinkPcConfig": {"fixture_marker": "config"},
                             "busisets": {"fixture_marker": "business"}}
        if not self.hold:
            self.release.set()

    @property
    def code(self):
        return "synthetic-code-"+self.name


class Peer:
    LOGIN = "/mcloud/mag/pc/v11/LoginPReg"
    SSO = "/mcloud/mag/pc/v9/callback/LoginPReg"
    QR = "/mcloud/mag/pc/v6/code/LoginPReg"
    REFRESH = "/mcloud/mag/pc/v9/refresh/LoginPReg"
    LOGOUT = "/mcloud/mag/pc/v2/sso/logout"
    COMPASS = "/compass/api/v1/hosts"
    COOKIES = ["UM=synthetic-um; Path=/; Secure", "Onebox=synthetic-box; Path=/; Secure"]

    def __init__(self, crypto: Crypto, certificate: Path | None = None):
        self.crypto = crypto
        self.lock = threading.Lock()
        self.grants: dict[str, Grant] = {}
        self.refreshes: dict[str, Grant] = {}
        self.tokens: dict[str, dict] = {}
        self.requests: list[dict] = []
        self.errors: list[str] = []
        self.identity_fingerprint = None
        self.compass = Grant("compass", response={"enable": 0, "ttl": 300, "lastUpdateTime": 1,
                                                 "httpDns": [], "standbyDomainConfig": {}})
        peer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, _format, *_args):
                pass

            def do_POST(self):
                grant = None
                try:
                    size = int(self.headers.get("Content-Length", "0"))
                    require(0 < size < 1024*1024, "unexpected authentication request size")
                    body = self.rfile.read(size)
                    grant, reply, status, cookies = peer.handle(self.path, self.headers, body)
                    grant.seen.set()
                    require(grant.release.wait(20), "synthetic peer gate was not released")
                    encoded = reply if isinstance(reply, bytes) else json.dumps(reply, separators=(",", ":")).encode()
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(encoded)))
                    self.send_header("Connection", "close")
                    for cookie in cookies:
                        self.send_header("Set-Cookie", cookie)
                    self.end_headers()
                    self.wfile.write(encoded); self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
                    # Expected when native generation cancellation closes a held response.
                    pass
                except BaseException as exc:
                    with peer.lock:
                        peer.errors.append(str(exc) if isinstance(exc, Failure) else type(exc).__name__)
                    try:
                        self.send_error(500, "synthetic protocol assertion failed")
                    except OSError:
                        pass
                finally:
                    if grant is not None:
                        grant.sent.set()
                    self.close_connection = True

        class Server(http.server.ThreadingHTTPServer):
            daemon_threads = True
            def handle_error(self, _request, _client_address):
                with peer.lock:
                    peer.errors.append("unexpected loopback server exception")

        self.server = Server(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(str(certificate or crypto.tls_cert), str(crypto.tls_key))
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def add(self, grant: Grant):
        with self.lock:
            require(grant.name not in self.grants, "duplicate synthetic grant")
            self.grants[grant.name] = grant
        return grant

    def refresh(self, token: str, grant: Grant):
        with self.lock:
            self.refreshes[token] = grant
        return grant

    def check_errors(self):
        with self.lock:
            if self.errors:
                raise Failure("loopback peer rejected the native protocol: "+self.errors[0])

    def wait_seen(self, grant: Grant, timeout=10):
        deadline = time.monotonic()+timeout
        while not grant.seen.wait(0.02):
            self.check_errors()
            if time.monotonic() >= deadline:
                raise Failure("native SDK did not contact the real loopback TLS peer")
        self.check_errors()

    def count(self, path=None, name=None):
        with self.lock:
            return sum((path is None or r["path"] == path) and
                       (name is None or r["name"] == name) for r in self.requests)

    def handle(self, path, headers, raw):
        if path == self.LOGOUT:
            form = urllib.parse.parse_qs(raw.decode("ascii"), strict_parsing=True)
            token = headers.get("x-wlk-Authorization", "")
            with self.lock:
                session = self.tokens.get(token)
            require(session is not None, "logout did not present a token issued by this TLS peer")
            require(headers.get("Cookie") == "token="+token, "logout cookie does not match its authorization token")
            require(form.get("refresh_token") == [session["refresh_token"]], "logout refresh token is wrong")
            require(form.get("tenantid") == [session["userType"]], "logout tenant format changed")
            require(form.get("publicKeyFlag") == ["df"] and form.get("thirdAuthType") == ["1"],
                    "logout form does not match the verified contract")
            grant = Grant("logout", response={"code": "0"})
            with self.lock:
                self.requests.append({"path": path, "name": "logout", "time": time.monotonic()})
            return grant, grant.response, 200, []
        try:
            body = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            raise Failure("native HTTP body is not JSON") from None
        require(isinstance(body, dict), "native HTTP body is not an object")
        if path == self.COMPASS:
            require(body == {"appId": "6489640385", "userTenantId": "", "userAccount": ""},
                    "Compass body differs from the verified constructor")
            with self.lock:
                self.requests.append({"path": path, "name": "compass", "time": time.monotonic()})
            return self.compass, self.compass.response, 200, []
        require(path in (self.LOGIN, self.SSO, self.QR, self.REFRESH), "unexpected authentication endpoint")
        require(re.fullmatch(r"pc-\{[0-9A-Fa-f-]{36}\}", headers.get("traceid", "")) is not None,
                "native request is missing its original traceid format")
        require(headers.get("User-Agent") == "WeLink-meeting", "native User-Agent changed")
        require(headers.get("lang") == "en", "native language header changed")
        if path == self.REFRESH:
            with self.lock:
                grant = self.refreshes.get(body.get("refresh_token"))
        else:
            key = headers.get("tmpCode", "")
            with self.lock:
                grant = self.grants.get(key)
        require(grant is not None, "authentication used an unissued synthetic credential")
        require(body.get("publicKeyFlag") == "0" and body.get("thirdAuthType") == "1",
                "authentication public-key/type flags changed")
        require(self.crypto.decrypt(body.get("tenantid")) == grant.tenant, "RSA tenant encryption is not interoperable")
        if path == self.LOGIN:
            require(grant.mode == "normal", "wrong normal-login route")
            require(self.crypto.decrypt(body.get("loginName")) == grant.username, "RSA username encryption is wrong")
            require(self.crypto.decrypt(body.get("password")) == grant.password, "password encryption was omitted or doubled")
            require(self.crypto.decrypt(body.get("authValue")) == grant.auth_value, "RSA auth-value encryption is wrong")
            require(body.get("authType") == "phone", "normal-login auth type changed")
        elif path in (self.SSO, self.QR):
            require(body.get("code") == grant.code, "authorization code was changed")
            require(path == (self.SSO if grant.mode == "sso" else self.QR), "wrong authorization-code endpoint")
            require((body.get("authType") == "phone") if path == self.SSO else "authType" not in body,
                    "SSO/QR auth type fields do not match their distinct contracts")
        info = body.get("deviceInfo")
        require(isinstance(info, list) and bool(info), "native request lost deviceInfo")
        require(all(isinstance(x, dict) and isinstance(x.get("deviceType"), str) and
                    isinstance(x.get("deviceValue"), str) and x["deviceValue"] and "\0" not in x["deviceValue"]
                    for x in info), "persistent identity was wiped or malformed")
        fingerprint = hashlib.sha256(json.dumps(info, sort_keys=True).encode()).digest()
        with self.lock:
            if self.identity_fingerprint is None:
                self.identity_fingerprint = fingerprint
            require(self.identity_fingerprint == fingerprint, "device identity changed between synthetic authentications")
        require("*" in headers.get("uuid", ""), "uuid header did not use the verified masking format")
        require(body.get("TID") == "" and body.get("TCC") == "0", "unprovisioned device was falsely attested")
        with self.lock:
            self.requests.append({"path": path, "name": grant.name, "time": time.monotonic()})
            if isinstance(grant.response, dict) and grant.response.get("crypt_token"):
                # Only synthetic tokens minted by this peer may be used later.
                session = dict(grant.response)
                session.setdefault("userType", grant.tenant)
                self.tokens[session["crypt_token"]] = session
        return grant, grant.response, grant.status, self.COOKIES

    def close(self):
        with self.lock:
            grants = list(self.grants.values())+list(self.refreshes.values())+[self.compass]
        for grant in grants:
            grant.release.set()
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


def der(tag: int, value: bytes) -> bytes:
    if len(value) < 128:
        length = bytes([len(value)])
    else:
        encoded = len(value).to_bytes((len(value).bit_length()+7)//8, "big")
        length = bytes([0x80+len(encoded)])+encoded
    return bytes([tag])+length+value


def der_parts(encoded: bytes):
    require(len(encoded) >= 2, "truncated synthetic DER")
    count = encoded[1]
    offset = 2
    if count & 0x80:
        width = count & 0x7f
        require(0 < width <= 4 and len(encoded) >= 2+width, "invalid synthetic DER length")
        count = int.from_bytes(encoded[2:2+width], "big")
        offset += width
    require(offset+count <= len(encoded), "synthetic DER extends past its buffer")
    return encoded[0], encoded[offset:offset+count], offset+count


def der_children(encoded: bytes):
    _tag, value, _end = der_parts(encoded)
    result = []
    while value:
        _tag, _body, end = der_parts(value)
        result.append(value[:end])
        value = value[end:]
    return result


def oid(value: str) -> bytes:
    arcs = [int(x) for x in value.split(".")]
    encoded = bytearray()
    for number in [40*arcs[0]+arcs[1], *arcs[2:]]:
        digits = [number & 127]
        number >>= 7
        while number:
            digits.append((number & 127)|128)
            number >>= 7
        encoded.extend(reversed(digits))
    return der(6, bytes(encoded))


def sequence(*values: bytes) -> bytes:
    return der(0x30, b"".join(values))


def signed_pkcs7(crypto: Crypto, content_oid: str, content: bytes,
                 signed_content: bytes) -> bytes:
    """Create a genuine RSA/SHA256 legacy PKCS#7 envelope, not an SDK fake.

    Authenticode's SPC sequence is an ASN.1 ANY rather than CMS's OCTET STRING.
    The vendor hashes the contents of that sequence, excluding its DER header.
    """
    certificate = command([crypto.openssl, "x509", "-in", crypto.sign_cert, "-outform", "DER"])
    tbs = der_children(der_children(certificate)[0])
    if tbs[0][0] == 0xa0:
        tbs = tbs[1:]
    serial, issuer = tbs[0], tbs[2]
    sha256 = sequence(oid("2.16.840.1.101.3.4.2.1"), der(5, b""))
    rsa = sequence(oid("1.2.840.113549.1.1.1"), der(5, b""))
    attributes = sorted([
        sequence(oid("1.2.840.113549.1.9.3"), der(0x31, oid(content_oid))),
        sequence(oid("1.2.840.113549.1.9.4"),
                 der(0x31, der(4, hashlib.sha256(signed_content).digest()))),
    ])
    attribute_value = b"".join(attributes)
    signature = command([crypto.openssl, "dgst", "-sha256", "-sign", crypto.sign_key],
                        data=der(0x31, attribute_value))
    signer = sequence(der(2, bytes([1])), sequence(issuer, serial), sha256,
                      der(0xa0, attribute_value), rsa, der(4, signature))
    signed = sequence(der(2, bytes([1])), der(0x31, sha256),
                      sequence(oid(content_oid), der(0xa0, content)),
                      der(0xa0, certificate), der(0x31, signer))
    return sequence(oid("1.2.840.113549.1.7.2"), der(0xa0, signed))


def pe_image(signature: bytes | None) -> bytes:
    image = bytearray(1024)
    image[:2] = b"MZ"
    struct.pack_into("<I", image, 60, 0x80)
    image[0x80:0x84] = bytes([0x50, 0x45, 0, 0])
    struct.pack_into("<HHIIIHH", image, 0x84, 0x14c, 1, 0, 0, 0, 224, 0x2102)
    optional = 0x98
    struct.pack_into("<H", image, optional, 0x10b)
    struct.pack_into("<I", image, optional+16, 0x1000)
    struct.pack_into("<I", image, optional+28, 0x10000000)
    struct.pack_into("<II", image, optional+32, 0x1000, 0x200)
    struct.pack_into("<II", image, optional+56, 0x2000, 0x200)
    struct.pack_into("<H", image, optional+68, 3)
    struct.pack_into("<I", image, optional+92, 16)
    section = optional+224
    image[section:section+8] = b".text"+bytes(3)
    struct.pack_into("<IIII", image, section+8, 1, 0x1000, 512, 512)
    struct.pack_into("<I", image, section+36, 0x60000020)
    image[512] = 0xc3  # Never executed; only the real signature verifier reads it.
    if signature is not None:
        record = struct.pack("<IHH", len(signature)+8, 0x200, 2)+signature
        record += bytes((-len(record)) % 8)
        struct.pack_into("<II", image, optional+128, len(image), len(record))
        image.extend(record)
    return bytes(image)


def signature_fixtures(crypto: Crypto, root: Path) -> dict[str, Path]:
    root.mkdir()
    image = pe_image(None)
    checksum = 0x98+64
    security_directory = 0x98+128
    image_digest = hashlib.sha256(image[:checksum]+image[checksum+4:security_directory]+
                                  image[security_directory+8:]).digest()
    digest_info = sequence(sequence(oid("2.16.840.1.101.3.4.2.1"), der(5, b"")),
                           der(4, image_digest))
    spc = sequence(sequence(oid("1.3.6.1.4.1.311.2.1.15")), digest_info)
    signature = signed_pkcs7(crypto, "1.3.6.1.4.1.311.2.1.4", spc, der_parts(spc)[1])
    altered_signature = signature[:-1]+bytes([signature[-1] ^ 1])
    wrong_type_payload = b"synthetic-data16"
    require(len(wrong_type_payload) == 16, "wrong-type regression payload must be exactly 16 bytes")
    wrong_type = signed_pkcs7(crypto, "1.2.840.113549.1.7.1",
                             der(4, wrong_type_payload), wrong_type_payload)
    changed_image = bytearray(pe_image(signature))
    changed_image[513] ^= 1
    contents = {
        "valid": pe_image(signature),
        "bad_signature": pe_image(altered_signature),
        "wrong_inner_type": pe_image(wrong_type),
        "bad_der": pe_image(bytes([0x30, 0x80, 0xff])),
        "unsigned": image,
        "not_pe": b"synthetic non-PE data",
        "changed_image": bytes(changed_image),
    }
    files = {}
    for name, content in contents.items():
        path = root/(name+".dll")
        path.write_bytes(content)
        files[name] = path
    return files


@dataclasses.dataclass
class Harness:
    driver: Path
    libraries: Path
    integrity: Path
    crypto: Crypto
    environment: dict
    root: Path
    timeout: float
    counter: int = 1000

    def sno(self):
        self.counter += 1
        return self.counter

    def open(self, sdk: str, *, library=None, cwd=None):
        if library is None:
            library = self.libraries/("wk_login.dll.so" if sdk == "login" else "wk_security.dll.so")
        return Driver(self.driver, sdk, library, self.environment, self.timeout, cwd or self.root)

    def key(self, driver: Driver):
        sno = self.sno()
        driver.send(message(1, sno, {"sso_pub_key": self.crypto.public_key}))
        require(driver.response(1, sno)["result"] == 0, "native public-key initialization failed")

    def encrypt(self, driver: Driver, plain: str) -> str:
        sno = self.sno()
        driver.send(message(13, sno, {"plain_text": plain}))
        reply = driver.response(13, sno)
        require(reply.get("result") == 0 and isinstance(reply.get("param"), dict),
                "native RSA response contract is wrong")
        encoded = reply["param"].get("encrypt_text")
        require(isinstance(encoded, str), "RSA response omitted encrypt_text")
        return encoded

    def auth(self, peer: Peer, grant: Grant, sno: int, *, password="", kind=None, ca=None):
        modes = {"normal": 0, "sso": 1, "qr": 2, "refresh-login": 4}
        mode = modes[grant.mode] if kind is None else kind
        param = {
            "platform": 100, "username": grant.username, "password": password,
            "tenantid": grant.tenant, "verify_mode": 1,
            "ca_cert_path": str(ca or self.crypto.ca),
            "middle_ground_addr": "localhost", "middle_ground_port": peer.port,
            "local_ip": "127.0.0.1", "is_speed_login": 0,
            "login_type": mode, "middle_ground_auth_code": grant.code,
            "third_auth_type": "1", "middle_ground_lang": "en",
            "auth_type": "phone", "auth_value": grant.auth_value, "tmp_code": grant.name,
            "proxy_addr": "", "proxy_port": 0, "proxy_account": "", "proxy_pwd": "",
        }
        if mode == 4:
            param["refreshtoken"] = "synthetic-seed-"+grant.name
        return message(4, sno, param, "synthetic-auth-"+grant.name)

    def online(self, driver: Driver, token: str, *, since=0, timeout=None, peer=None):
        return driver.wait_message(
            lambda m: m.get("notify") == 2 and m.get("param", {}).get("login_status") == 2 and
            m["param"].get("middle_ground_token") == token,
            since=since, timeout=timeout, peer=peer)

    def offline(self, driver: Driver, *, since=0):
        return driver.wait_message(
            lambda m: m.get("notify") == 2 and m.get("param", {}).get("login_status") == 0 and
            m["param"].get("loginIntent") == 0, since=since)


def absent_token(driver: Driver, token: str, since: int):
    # Token values are synthetic; failure output intentionally omits all payloads.
    for callback in driver.callbacks[since:]:
        param = callback.get("param") or {}
        require(param.get("middle_ground_token") != token and param.get("middleGroundToken") != token,
                "a cancelled authentication published its stale token")


def no_auth_success(driver: Driver, sno: int, since: int):
    require(not any(m.get("rsp") == 4 and m.get("sno") == sno and m.get("result") == 0
                    for m in driver.callbacks[since:]), "cancelled/failed authentication reported success")


def test_crypto_and_tokens(h: Harness):
    with Peer(h.crypto) as peer, h.open("login") as driver:
        h.key(driver)
        require(h.encrypt(driver, "") == "", "empty RSA input contract changed")
        normal = peer.add(Grant("normal-first", mode="normal"))
        password = h.encrypt(driver, normal.password)
        require(h.crypto.decrypt(password) == normal.password, "RSA OAEP/SHA1 is not interoperable")
        require(h.crypto.decrypt(h.encrypt(driver, "x"*342)) == "x"*342,
                "RSA maximum valid chunk did not round-trip")
        require(h.encrypt(driver, "x"*343) == "", "original oversized-chunk omission was not preserved")
        require(h.crypto.decrypt(h.encrypt(driver, "x"*344)) == "x",
                "original RSA block-advance framing changed")

        since = len(driver.callbacks)
        sno = h.sno()
        driver.send(h.auth(peer, normal, sno, password=password))
        peer.wait_seen(normal)
        require(normal.sent.wait(5), "synthetic TLS response was not sent")
        driver.idle(0.25, pump=False, peer=peer)
        require(len(driver.callbacks) == since, "worker completion invoked FFI before owner dispatch")
        reply = driver.response(4, sno, peer=peer)
        require(reply.get("result") == 0, "validated synthetic credentials did not authenticate")
        require(reply.get("description") == "synthetic-auth-"+normal.name, "request description was not preserved")
        param = reply.get("param") or {}
        expected = normal.response
        expected_fields = {
            "uuid": expected["uid"], "tenantid": expected["userType"],
            "middleGroundToken": expected["crypt_token"], "email": expected["email"],
            "middleGroundSetPasswordToken": expected["setPasswordToken"],
            "middleGroundExpiredPwdTip": expected["expiredPwdTip"],
            "middleGroundPhoneNumber": expected["phoneNumber"],
            "middleGroundCountryCode": expected["countryCode"],
            "middleGroundNeedChangePassword": True, "hmenus": expected["hmenus"],
            "middleGroundSetUMCookie": ";".join(peer.COOKIES),
        }
        for key, value in expected_fields.items():
            require(param.get(key) == value, "login success field mismatch: "+key)
        online = h.online(driver, expected["crypt_token"], since=since, peer=peer)["param"]
        for output_key, input_key in {
            "middle_ground_configuration": "welinkPcConfig", "busisets": "busisets",
            "hmenus": "hmenus", "maa_uri": "desktopMaa", "onebox_address": "oneboxUrl",
            "middle_ground_sso_login_url": "ssoLoginUrl", "meeting_login_url": "meetingurl",
            "middle_ground_refreshtoken": "refresh_token",
        }.items():
            require(online.get(output_key) == expected[input_key], "status/config field mismatch: "+output_key)
        require(online.get("is_refreshtoken_or_reconnect") is False, "initial auth was mislabeled as refresh")

        # Failure after identity allocation must not wipe its persistent strings.
        bad = Grant("oversized-username", mode="normal", username="x"*343)
        before = peer.count()
        bad_sno = h.sno()
        driver.send(h.auth(peer, bad, bad_sno, password=password))
        require(driver.response(4, bad_sno).get("result") == 10026,
                "request-encryption failure was not reported")
        require(peer.count() == before, "failed request encryption still contacted the service")
        recovered = peer.add(Grant("identity-after-rsa-failure", mode="normal"))
        recovered_sno = h.sno()
        driver.send(h.auth(peer, recovered, recovered_sno, password=password))
        require(driver.response(4, recovered_sno, peer=peer).get("result") == 0,
                "valid authentication did not recover after encryption failure")
        h.online(driver, recovered.response["crypt_token"], peer=peer)

        refresh = peer.refresh(recovered.response["refresh_token"], Grant(
            "regular-refresh", mode="refresh",
            response={"crypt_token": "synthetic-token-refreshed",
                      "refresh_token": "synthetic-refresh-refreshed", "expires_in": 3600}))
        refresh_sno = h.sno()
        driver.send(message(7, refresh_sno))
        require(driver.response(7, refresh_sno).get("result") == 0, "refresh request acknowledgement changed")
        refreshed = h.online(driver, refresh.response["crypt_token"], peer=peer)["param"]
        require(refreshed.get("is_refreshtoken_or_reconnect") is True, "refresh was not identified")
        require(refreshed.get("middle_ground_configuration") == recovered.response["welinkPcConfig"],
                "refresh discarded omitted configuration")
        require(refreshed.get("email") == recovered.response["email"], "refresh discarded omitted user fields")
        require(refreshed.get("imGray") == 0, "omitted refresh scalar default was not restored")

        forced = peer.refresh(refresh.response["refresh_token"], Grant(
            "forced-refresh", mode="refresh",
            response={"crypt_token": "synthetic-token-forced", "refresh_token": "synthetic-refresh-forced",
                      "expires_in": 3600}))
        forced_sno = h.sno()
        driver.send(message(11, forced_sno))
        require(driver.response(11, forced_sno).get("result") == 0, "forced refresh was not accepted")
        h.online(driver, forced.response["crypt_token"], peer=peer)
        before = peer.count(Peer.REFRESH)
        throttle_sno = h.sno()
        driver.send(message(7, throttle_sno))
        require(driver.response(7, throttle_sno).get("result") == 0, "throttled refresh acknowledgement changed")
        driver.idle(0.4, pump=True, peer=peer)
        require(peer.count(Peer.REFRESH) == before, "ordinary refresh ignored its 20-second guard")

        since = len(driver.callbacks)
        logout_sno = h.sno()
        driver.send(message(5, logout_sno, {"is_token_invalid": False}))
        require(driver.response(5, logout_sno, peer=peer).get("result") == 0, "real HTTPS logout failed")
        offline = h.offline(driver, since=since)["param"]
        require(offline.get("middle_ground_token") == "" and offline.get("middle_ground_refreshtoken") == "",
                "logout retained credential delivery")
        require(peer.count(Peer.LOGOUT) == 1, "logout was acknowledged without contacting the peer")
        peer.check_errors()


def test_login_modes_and_failures(h: Harness):
    with Peer(h.crypto) as peer, h.open("login") as driver:
        h.key(driver)
        for mode in ("sso", "qr", "refresh-login"):
            grant = peer.add(Grant("mode-"+mode, mode=mode))
            if mode == "refresh-login":
                peer.refresh("synthetic-seed-"+grant.name, grant)
            sno = h.sno()
            driver.send(h.auth(peer, grant, sno))
            require(driver.response(4, sno, peer=peer).get("result") == 0, "authentication mode failed: "+mode)
            h.online(driver, grant.response["crypt_token"], peer=peer)
            before = peer.count(Peer.LOGOUT)
            logout = h.sno()
            driver.send(message(5, logout, {"is_token_invalid": True}))
            require(driver.response(5, logout).get("result") == 0, "local invalid-token logout failed")
            require(peer.count(Peer.LOGOUT) == before, "invalid-token logout unexpectedly performed remote logout")

        for name, reply, expected in (
            ("empty-response", {}, 10001),
            ("invalid-json", b"synthetic non-JSON", 10025),
            ("server-rejection", {"code": 1100, "message": "synthetic rejection"}, 10006),
        ):
            grant = peer.add(Grant(name, response=reply))
            sno, since = h.sno(), len(driver.callbacks)
            driver.send(h.auth(peer, grant, sno))
            response = driver.response(4, sno, peer=peer)
            require(response.get("result") == expected, "server failure was misclassified: "+name)
            driver.idle(0.25, pump=True, peer=peer)
            no_auth_success(driver, sno, since)
            require(not any(m.get("notify") == 2 and (m.get("param") or {}).get("login_status") == 2
                            for m in driver.callbacks[since:]), "empty/error response fabricated an online state")

        untrusted = peer.add(Grant("untrusted-server"))
        sno, since = h.sno(), len(driver.callbacks)
        driver.send(h.auth(peer, untrusted, sno, ca=h.crypto.other_ca))
        require(driver.response(4, sno).get("result") == 10005, "untrusted TLS chain was accepted or misclassified")
        driver.idle(0.25, pump=True, peer=peer)
        no_auth_success(driver, sno, since)
        require(not any(m.get("notify") == 2 and (m.get("param") or {}).get("login_status") == 2
                        for m in driver.callbacks[since:]), "TLS rejection fabricated an online state")
        require(not untrusted.seen.is_set(), "credentials crossed TLS before certificate validation")
        peer.check_errors()


def test_tls_hostname(h: Harness):
    # This leaf chains to the correct local CA, but its SAN excludes localhost.
    # Offline chain verification in Crypto.create proves this is not a bad-CA test.
    with Peer(h.crypto, certificate=h.crypto.wrong_name_cert) as peer, h.open("login") as driver:
        h.key(driver)
        grant = peer.add(Grant("wrong-hostname"))
        sno, since = h.sno(), len(driver.callbacks)
        driver.send(h.auth(peer, grant, sno))
        require(driver.response(4, sno).get("result") == 10005, "TLS hostname verification was disabled")
        driver.idle(0.25, pump=True, peer=peer)
        require(not grant.seen.is_set(), "credentials were sent to an uncertified hostname")
        no_auth_success(driver, sno, since)
        require(not any(m.get("notify") == 2 and (m.get("param") or {}).get("login_status") == 2
                        for m in driver.callbacks[since:]), "wrong-hostname TLS failure fabricated login success")
        peer.check_errors()


def test_delayed_auth_cancellation(h: Harness):
    with Peer(h.crypto) as peer, h.open("login") as driver:
        h.key(driver)
        old = peer.add(Grant("delayed-logout-auth", hold=True))
        sno, since = h.sno(), len(driver.callbacks)
        driver.send(h.auth(peer, old, sno))
        peer.wait_seen(old)
        logout = h.sno()
        driver.send(message(5, logout, {"is_token_invalid": True}))
        old.release.set()
        require(driver.response(5, logout, peer=peer).get("result") == 0, "queued logout did not complete")
        h.offline(driver, since=since)
        driver.idle(0.4, pump=True, peer=peer)
        no_auth_success(driver, sno, since)
        absent_token(driver, old.response["crypt_token"], since)
        before = peer.count(Peer.REFRESH)
        refresh_sno = h.sno()
        driver.send(message(11, refresh_sno))
        driver.response(11, refresh_sno)
        driver.idle(0.3, pump=True, peer=peer)
        require(peer.count(Peer.REFRESH) == before, "cancelled auth installed a token usable for refresh")

        old = peer.add(Grant("delayed-replaced-auth", hold=True))
        replacement = peer.add(Grant("replacement-auth"))
        old_sno, new_sno, since = h.sno(), h.sno(), len(driver.callbacks)
        driver.send(h.auth(peer, old, old_sno))
        peer.wait_seen(old)
        driver.send(h.auth(peer, replacement, new_sno))
        old.release.set()
        require(driver.response(4, new_sno, peer=peer).get("result") == 0, "replacement authentication did not succeed")
        h.online(driver, replacement.response["crypt_token"], since=since, peer=peer)
        driver.idle(0.4, pump=True, peer=peer)
        no_auth_success(driver, old_sno, since)
        absent_token(driver, old.response["crypt_token"], since)

        held_refresh = peer.refresh(replacement.response["refresh_token"], Grant(
            "delayed-refresh", mode="refresh", hold=True,
            response={"crypt_token": "synthetic-cancelled-renewal",
                      "refresh_token": "synthetic-cancelled-refresh", "expires_in": 3600}))
        since, refresh_sno = len(driver.callbacks), h.sno()
        driver.send(message(11, refresh_sno))
        peer.wait_seen(held_refresh)
        kicked = h.sno()
        driver.send(message(9, kicked))
        held_refresh.release.set()
        require(driver.response(9, kicked, peer=peer).get("result") == 0, "kick-out was blocked by refresh")
        h.offline(driver, since=since)
        driver.idle(0.4, pump=True, peer=peer)
        absent_token(driver, held_refresh.response["crypt_token"], since)
        peer.check_errors()


def test_compass_cancellation(h: Harness):
    with Peer(h.crypto) as peer, h.open("login") as driver:
        h.key(driver)
        peer.compass.release.clear()
        rs_sno = h.sno()
        driver.send(message(8, rs_sno, {
            "rs_url": "localhost:"+str(peer.port), "verify_mode": 1, "ca_cert_path": str(h.crypto.ca),
            "proxy_addr": "", "proxy_port": 0, "proxy_account": "", "proxy_pwd": "",
        }))
        require(driver.response(8, rs_sno).get("result") == 0, "RS configuration was not accepted")
        grant = peer.add(Grant("auth-cancelled-during-compass"))
        sno, since = h.sno(), len(driver.callbacks)
        driver.send(h.auth(peer, grant, sno))
        peer.wait_seen(peer.compass)
        logout = h.sno()
        driver.send(message(5, logout, {"is_token_invalid": True}))
        peer.compass.release.set()
        require(driver.response(5, logout, peer=peer).get("result") == 0, "Compass request prevented cancellation")
        driver.idle(0.4, pump=True, peer=peer)
        require(peer.count(Peer.QR, grant.name) == 0, "cancelled Compass continuation still authenticated")
        no_auth_success(driver, sno, since)
        peer.check_errors()


def test_timer_refresh(h: Harness):
    with Peer(h.crypto) as peer, h.open("login") as driver:
        h.key(driver)
        grant = peer.add(Grant("timer-auth"))
        grant.response["expires_in"] = 2
        renewed = peer.refresh(grant.response["refresh_token"], Grant(
            "timer-renewal", mode="refresh",
            response={"crypt_token": "synthetic-timer-token", "refresh_token": "synthetic-timer-refresh",
                      "expires_in": 3600}))
        sno = h.sno()
        driver.send(h.auth(peer, grant, sno))
        require(driver.response(4, sno, peer=peer).get("result") == 0, "timer setup auth failed")
        h.online(driver, grant.response["crypt_token"], peer=peer)
        started = time.monotonic()
        h.online(driver, renewed.response["crypt_token"], timeout=40, peer=peer)
        elapsed = time.monotonic()-started
        require(28 <= elapsed < 40, "automatic renewal did not honor the 30-second minimum")
        require(peer.count(Peer.REFRESH, renewed.name) == 1, "timer did not issue one real renewal request")
        peer.check_errors()


def assert_reinit(driver: Driver, stale_sno: int, since: int):
    require(any(e.get("event") == "reinit_done" for e in driver.events), "callback never completed reentrant shutdown/init")
    require(not any(m.get("sno") == stale_sno for m in driver.callbacks[since:]),
            "queued completion from the old lifecycle epoch leaked")


def test_login_reentry(h: Harness):
    with h.open("login") as driver:
        h.key(driver)
        trigger, stale, key_sno, fresh = h.sno(), h.sno(), h.sno(), h.sno()
        since = len(driver.callbacks)
        driver.call("arm_reinit", trigger_sno=trigger, trigger_rsp=13, after=[
            message(1, key_sno, {"sso_pub_key": h.crypto.public_key}),
            message(13, fresh, {"plain_text": "synthetic after re-init"}),
        ])
        driver.send(message(13, trigger, {"plain_text": "synthetic trigger"}))
        driver.send(message(13, stale, {"plain_text": "synthetic stale completion"}))
        driver.idle(0.25, pump=False)
        response = driver.response(13, fresh, since=since)
        require(response.get("result") == 0, "new login epoch did not function")
        require(h.crypto.decrypt(response["param"]["encrypt_text"]) == "synthetic after re-init",
                "new login epoch retained the wrong encryption state")
        driver.idle(0.25, pump=True)
        assert_reinit(driver, stale, since)


def test_security(h: Harness, fixtures: dict[str, Path]):
    with h.open("security") as driver:
        cases = [
            ("valid", 0, 100), ("changed_image", 0, 100),
            ("bad_signature", 8, 90), ("wrong_inner_type", 6, 90),
            ("bad_der", 6, 90), ("unsigned", 5, 70), ("not_pe", 4, 40),
        ]
        for name, result, stage in cases:
            sno = h.sno()
            driver.send(message(1, sno, {"filePath": str(fixtures[name])}))
            response = driver.response(1, sno)
            require(response.get("result") == result, "real signature-envelope result mismatch: "+name)
            require((response.get("param") or {}).get("inWhere") == stage,
                    "signature-envelope failure stage mismatch: "+name)
        for path, result, stage in (("", 1, 30), (str(h.root/"does-not-exist.dll"), 3, 30)):
            sno = h.sno()
            driver.send(message(1, sno, {"filePath": path}))
            response = driver.response(1, sno)
            require(response.get("result") == result and response["param"].get("inWhere") == stage,
                    "missing/empty signature input was incorrectly accepted")
        disabled = h.sno()
        driver.send(message(3, disabled, {"isKIAFileDetection": False, "kiaDllDir": str(h.root)}))
        require(driver.response(3, disabled).get("result") == 3, "disabled KIA was represented as a clean verdict")
        single = h.sno()
        driver.send(message(4, single, {"filePath": str(fixtures["valid"])}))
        require(driver.response(4, single).get("result") == 3, "disabled KIA unexpectedly checked a file")
        enabled = h.sno()
        driver.send(message(3, enabled, {"isKIAFileDetection": True, "kiaDllDir": str(h.root)}))
        require(driver.response(3, enabled).get("result") == 2, "unavailable KIA falsely initialized successfully")
        for cmd, param, result in (
            (4, {"filePath": str(fixtures["valid"])}, 2),
            (5, {"filePathList": [str(fixtures["valid"])]}, 2),
            (5, {"filePathList": []}, -1),
            (5, {"filePathList": [str(fixtures["valid"])]*101}, -1),
            (3, {"isKIAFileDetection": True}, -1),
        ):
            sno = h.sno()
            driver.send(message(cmd, sno, param))
            require(driver.response(cmd, sno).get("result") == result, "KIA failure semantics were replaced with success")


def test_security_reentry(h: Harness, fixtures: dict[str, Path]):
    with h.open("security") as driver:
        trigger, stale, fresh = h.sno(), h.sno(), h.sno()
        since = len(driver.callbacks)
        driver.call("arm_reinit", trigger_sno=trigger, trigger_rsp=3, after=[
            message(4, fresh, {"filePath": str(fixtures["valid"])})])
        driver.send(message(3, trigger, {"isKIAFileDetection": True, "kiaDllDir": str(h.root)}))
        driver.send(message(1, stale, {"filePath": str(fixtures["valid"])}))
        driver.idle(0.25, pump=False)
        require(driver.response(4, fresh, since=since).get("result") == 3,
                "security re-init leaked its previous KIA enabled state")
        driver.idle(0.25, pump=True)
        assert_reinit(driver, stale, since)


def integrity_app(h: Harness, name: str) -> tuple[Path, Path, Path]:
    base = h.root/name
    app = base/"app"
    (app/"pedestal").mkdir(parents=True)
    for relative, data in INTEGRITY_FILES.items():
        path = app/relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    library = app/"pedestal"/"pedestal_integrity_fixture.so"
    shutil.copy2(h.integrity, library)
    unrelated = base/"dbdata"
    unrelated.mkdir()
    # An unrelated cwd with healthy copies must not substitute for the app root.
    for relative, data in INTEGRITY_FILES.items():
        path = unrelated/relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return app, library, unrelated


def test_integrity_files(h: Harness):
    for name, expected_result in (("intact", 0), ("modified", 101), ("missing", 102)):
        app, library, cwd = integrity_app(h, "integrity-"+name)
        if name == "modified":
            (app/"assets/one.dat").write_bytes(b"abd")
            # A mutable runtime sidecar must have no authority over the compiled baseline.
            (app/"native_integrity_manifest.h").write_text("runtime sidecar must not be trusted")
        elif name == "missing":
            (app/"assets/one.dat").unlink()
        with h.open("integrity", library=library, cwd=cwd) as driver:
            sno = h.sno()
            driver.send(message(80, sno, description="synthetic-integrity-description"))
            driver.idle(0.25, pump=False)
            require(not driver.callbacks, "integrity worker invoked FFI without pumping")
            response = driver.response(80, sno)
            require(response.get("result") == expected_result, "real asset verification failed: "+name)
            require(response.get("description") == "synthetic-integrity-description", "integrity rewrote request description")
            param = response.get("param") or {}
            require(param.get("integrity_profile") == "native-build" and
                    param.get("integrity_build") == "synthetic-native-baseline-v1",
                    "native integrity result falsely claimed the vendor baseline")
            if name == "intact":
                require(not any(k.startswith("errorFile_") for k in param), "intact real files produced errors")
            else:
                detail = param.get("errorFile_0") or {}
                require(detail.get("failReason") == "assets/one.dat", "integrity checked the wrong application path")
                if name == "modified":
                    require(detail.get("file_sha256") == hashlib.sha256(b"abd").hexdigest().upper(),
                            "integrity did not hash the modified bytes")
                    require(detail.get("expected_sha256") ==
                            "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD",
                            "integrity replaced its compile-time expected digest")
                    require(detail.get("fileLen") == "3", "integrity file metadata is not real")
                else:
                    require(param.get("error_count") == 1 and detail.get("error_file_msg") == "file is not exist",
                            "missing asset was represented as a successful verification")


def test_integrity_reentry(h: Harness):
    _app, library, cwd = integrity_app(h, "integrity-reentry")
    with h.open("integrity", library=library, cwd=cwd) as driver:
        trigger, stale, fresh = h.sno(), h.sno(), h.sno()
        driver.call("arm_reinit", trigger_sno=trigger, trigger_rsp=80,
                    after=[message(91, fresh, description="synthetic-new-integrity-epoch")])
        driver.send(message(80, trigger))
        driver.send(message(91, stale))
        driver.idle(0.25, pump=False)
        response = driver.response(91, fresh)
        require(response.get("result") == 0, "integrity did not perform a real scan after reentrant shutdown")
        require(response.get("description") == "synthetic-new-integrity-epoch", "new integrity epoch lost request identity")
        driver.idle(0.25, pump=True)
        assert_reinit(driver, stale, 0)


def elf32(path: Path):
    with path.open("rb") as source:
        prefix = source.read(5)
    require(prefix == bytes([0x7f, 0x45, 0x4c, 0x46, 1]), "an actual 32-bit ELF artifact is required")


def build_harness(args, root: Path):
    source = args.source_dir.resolve(strict=True)
    libraries = args.library_dir.resolve(strict=True)
    json_prefix = args.json_c_dir.resolve(strict=True)
    include = json_prefix/"include"
    archive = json_prefix/"lib"/"libjson-c.a"
    require((include/"json-c"/"json.h").is_file() and archive.is_file(),
            "--json-c-dir must be the private install prefix with include/json-c and lib/libjson-c.a")
    native_rpc = source/"native_rpc.h"
    if not native_rpc.is_file() and (source.parent/"native_rpc.h").is_file():
        native_rpc = source.parent/"native_rpc.h"  # The agent-host stage layout.
    require(native_rpc.is_file(), "native_rpc.h is required from the actual source tree")
    integrity_source = source/"pedestal_integrity.c"
    integrity_header = source/"pedestal_integrity.h"
    require(integrity_source.is_file() and integrity_header.is_file(),
            "actual pedestal_integrity.c/.h are required, not a replacement implementation")
    for name in ("wk_login.dll.so", "wk_security.dll.so"):
        require((libraries/name).is_file(), "required real SDK artifact is missing: "+name)
        elf32(libraries/name)
    build = root/"build"
    build.mkdir()
    (build/"driver.c").write_text(DRIVER_C)
    shutil.copy2(native_rpc, build/"native_rpc.h")
    # Exact source copies isolate the test header from a production native manifest.
    shutil.copy2(integrity_source, build/"pedestal_integrity.c")
    shutil.copy2(integrity_header, build/"pedestal_integrity.h")
    (build/"native_integrity_manifest.h").write_text(INTEGRITY_MANIFEST)
    environment = os.environ.copy()
    environment.setdefault("PKG_CONFIG_LIBDIR", "/usr/lib/i386-linux-gnu/pkgconfig:/usr/share/pkgconfig")
    ssl_flags = shlex.split(command(["pkg-config", "--cflags", "--libs", "openssl"],
                                   env=environment).decode())
    cc = shlex.split(args.cc)
    common = ["-m32", "-std=gnu11", "-O2", "-Wall", "-Wextra", "-pthread",
              "-fvisibility=hidden", "-I"+str(include), "-I"+str(build)]
    driver = build/"sdk-driver"
    command([*cc, *common, build/"driver.c", archive,
             "-Wl,--exclude-libs,ALL", "-Wl,-z,defs", "-lm", "-ldl", "-o", driver], env=environment)
    integrity = build/"pedestal_integrity_fixture.so"
    command([*cc, *common, "-shared", "-fPIC", "-DPEDESTAL_NATIVE_INTEGRITY",
             build/"pedestal_integrity.c", archive, *ssl_flags,
             "-Wl,--exclude-libs,ALL", "-Wl,-z,defs", "-lm", "-ldl", "-o", integrity], env=environment)
    elf32(driver); elf32(integrity)
    for name in ("SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE"):
        environment.pop(name, None)
    for name in ("http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        environment[name] = ""
    environment["NO_PROXY"] = environment["no_proxy"] = "localhost,127.0.0.1"
    library_paths = [str(libraries), str(json_prefix/"lib")]
    if environment.get("LD_LIBRARY_PATH"):
        library_paths.append(environment["LD_LIBRARY_PATH"])
    environment["LD_LIBRARY_PATH"] = os.pathsep.join(library_paths)
    crypto = Crypto.create(args.openssl, root/"crypto")
    return Harness(driver, libraries, integrity, crypto, environment, root, args.timeout)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--library-dir", type=Path, required=True,
                        help="directory containing the real 32-bit wk_login.dll.so and wk_security.dll.so")
    parser.add_argument("--json-c-dir", type=Path, required=True,
                        help="private JSON-C installation prefix; never falls back to system JSON-C")
    parser.add_argument("--source-dir", type=Path, default=Path(__file__).resolve().parent,
                        help="actual native source directory containing pedestal_integrity.c/.h and native_rpc.h")
    parser.add_argument("--cc", default=os.environ.get("CC", "gcc"))
    parser.add_argument("--openssl", default="openssl")
    parser.add_argument("--timeout", type=float, default=45,
                        help="callback deadline in seconds, at least 40 for the real minimum renewal timer")
    args = parser.parse_args(argv)
    if args.timeout < 40:
        parser.error("--timeout must be at least 40; the automatic-renewal case is not skipped")
    old_umask = os.umask(0o077)
    passed = []
    try:
        with tempfile.TemporaryDirectory(prefix="welink-login-security-") as temporary:
            h = build_harness(args, Path(temporary))
            fixtures = signature_fixtures(h.crypto, h.root/"signatures")
            cases = [
                ("real RSA, login tokens/config, renewal and HTTPS logout", lambda: test_crypto_and_tokens(h)),
                ("SSO/QR/refresh modes, server rejection and enforced TLS", lambda: test_login_modes_and_failures(h)),
                ("trusted chain with wrong hostname remains rejected", lambda: test_tls_hostname(h)),
                ("delayed authentication/renewal generation cancellation", lambda: test_delayed_auth_cancellation(h)),
                ("cancellation while real Compass HTTPS is delayed", lambda: test_compass_cancellation(h)),
                ("real automatic renewal timer", lambda: test_timer_refresh(h)),
                ("login owner callback shutdown/re-init", lambda: test_login_reentry(h)),
                ("real PKCS7 envelopes and unavailable KIA", lambda: test_security(h, fixtures)),
                ("security owner callback shutdown/re-init", lambda: test_security_reentry(h, fixtures)),
                ("compiled native asset baseline: intact/changed/missing", lambda: test_integrity_files(h)),
                ("integrity owner callback shutdown/re-init", lambda: test_integrity_reentry(h)),
            ]
            for name, run in cases:
                run()
                passed.append(name)
                print("PASS: "+name, flush=True)
            print(json.dumps({"passed": len(passed), "account_data": "synthetic only",
                              "network": "verified loopback HTTPS", "all_cases": True}), flush=True)
        return 0
    except (Failure, OSError, subprocess.SubprocessError) as exc:
        # Assertions never include raw native requests/device identifiers.
        print("FAIL: "+str(exc), flush=True)
        return 1
    finally:
        os.umask(old_umask)


if __name__ == "__main__":
    raise SystemExit(main())
