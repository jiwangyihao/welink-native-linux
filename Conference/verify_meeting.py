#!/usr/bin/env python3
"""Exercise the real ia32 meeting adapter against isolated loopback HTTPS.

Usage (run by the integration owner, not while editing):
    python3 verify_meeting.py --library /absolute/path/meeting_adapter.so

Requires a Linux 32-bit C toolchain/runtime and openssl. The embedded driver is
compiled once with -m32 and dlopens the supplied library; it does not compile,
replace, interpose, or mock the adapter. All service replies and credentials are
synthetic fixtures. TLS uses a temporary local CA and an IP-SAN server certificate.
No real account, meeting, media device, Wine process, or keystore is accessed.

The C callbacks stay at fixed addresses until process exit. A worker wake only
signals the owner pipe; Python explicitly asks the owner to dispatch, permitting
deterministic reset-before-delivery interleavings. Graceful shutdown here means
real cmd1030 completion followed by reset, not an invented native shutdown API.
"""

from __future__ import annotations

import argparse
import collections
import dataclasses
import errno
import http.server
import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import traceback
from typing import Any


DRIVER_SOURCE = r'''
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

_Static_assert(sizeof(void *) == 4, "the meeting verification driver must be ia32");
typedef void (*json_callback)(const char *);
typedef void (*wake_callback)(void);
static int (*api_log)(const char *);
static int (*api_callback)(json_callback);
static int (*api_register)(wake_callback);
static int (*api_init)(const char *);
static void (*api_reset)(void);
static const char *(*api_capabilities)(void);
static int (*api_send)(const char *);
static int (*api_dispatch)(void);
static pthread_t owner;
static int wake_pipe[2];
static _Atomic int probe_next_wake;
static int callback_action;
static unsigned callback_skip;
static pthread_t race_thread;
static int race_join_pending;
static pthread_mutex_t race_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t race_condition = PTHREAD_COND_INITIALIZER;
static int race_started, race_finished;

static void fail(const char *message)
{
    fprintf(stderr, "driver assertion: %s\n", message);
    fflush(stderr);
    _Exit(2);
}
static void require(int condition, const char *message)
{
    if (!condition) fail(message);
}
static struct timespec deadline_ms(long milliseconds)
{
    struct timespec value;
    require(clock_gettime(CLOCK_REALTIME, &value) == 0, "clock_gettime");
    value.tv_sec += milliseconds / 1000;
    value.tv_nsec += (milliseconds % 1000) * 1000000L;
    if (value.tv_nsec >= 1000000000L) { ++value.tv_sec; value.tv_nsec -= 1000000000L; }
    return value;
}
static void data_event(const char *kind, const char *data)
{
    require(data != NULL, "null JSON from the real adapter");
    flockfile(stdout);
    fprintf(stdout, "{\"kind\":\"%s\",\"data\":", kind);
    fputs(data, stdout);
    fputs("}\n", stdout);
    fflush(stdout);
    funlockfile(stdout);
}
static void return_event(char operation, int result)
{
    flockfile(stdout);
    fprintf(stdout, "{\"kind\":\"return\",\"op\":\"%c\",\"result\":%d}\n", operation, result);
    fflush(stdout);
    funlockfile(stdout);
}
static void literal_event(const char *json)
{
    flockfile(stdout);
    fputs(json, stdout);
    fputc('\n', stdout);
    fflush(stdout);
    funlockfile(stdout);
}
static void join_with_deadline(pthread_t thread, const char *failure)
{
    struct timespec until = deadline_ms(2000);
    require(pthread_timedjoin_np(thread, NULL, &until) == 0, failure);
}
static void *reset_probe(void *unused)
{
    (void)unused;
    api_reset();
    data_event("probe-capabilities", api_capabilities());
    return NULL;
}
static void wake(void)
{
    require(!pthread_equal(owner, pthread_self()), "wake must originate in the real worker");
    if (atomic_exchange(&probe_next_wake, 0)) {
        pthread_t probe;
        require(pthread_create(&probe, NULL, reset_probe, NULL) == 0, "create wake lock probe");
        join_with_deadline(probe, "wake holds an adapter lock needed by another thread's reset/capabilities");
        literal_event("{\"kind\":\"wake-lock-probe\",\"completed\":true}");
    }
    unsigned char byte = 1;
    ssize_t written;
    do { written = write(wake_pipe[1], &byte, 1); } while (written < 0 && errno == EINTR);
    require(written == 1, "wake pipe write");
}
static void other_wake(void) { fail("replacement wake must never be installed"); }
static void *concurrent_reset(void *unused)
{
    (void)unused;
    pthread_mutex_lock(&race_mutex);
    race_started = 1;
    pthread_cond_signal(&race_condition);
    pthread_mutex_unlock(&race_mutex);
    api_reset();
    pthread_mutex_lock(&race_mutex);
    race_finished = 1;
    pthread_cond_signal(&race_condition);
    pthread_mutex_unlock(&race_mutex);
    return NULL;
}
static void json_received(const char *json)
{
    require(pthread_equal(owner, pthread_self()), "JSON was published outside the FFI owner");
    data_event("callback", json);
    if (!callback_action) return;
    if (callback_skip) { --callback_skip; return; }
    int action = callback_action;
    callback_action = 0; /* Nested logout ACKs must not recurse into the action. */
    if (action == 1) {
        api_reset();
        literal_event("{\"kind\":\"callback-action\",\"action\":\"reset\",\"result\":0}");
    } else if (action == 2) {
        int result = api_send("{\"cmd\":1030,\"sno\":900001,\"param\":{}}");
        flockfile(stdout);
        fprintf(stdout, "{\"kind\":\"callback-action\",\"action\":\"shutdown\",\"result\":%d}\n", result);
        fflush(stdout);
        funlockfile(stdout);
    } else if (action == 3) {
        require(!race_join_pending, "overlapping publication race probes");
        pthread_mutex_lock(&race_mutex);
        race_started = race_finished = 0;
        require(pthread_create(&race_thread, NULL, concurrent_reset, NULL) == 0, "create publication reset probe");
        struct timespec started_deadline = deadline_ms(2000);
        while (!race_started)
            require(pthread_cond_timedwait(&race_condition, &race_mutex, &started_deadline) == 0,
                    "reset probe never reached its call");
        struct timespec held_deadline = deadline_ms(100);
        int wait_result = 0;
        while (!race_finished && wait_result == 0)
            wait_result = pthread_cond_timedwait(&race_condition, &race_mutex, &held_deadline);
        require(!race_finished && wait_result == ETIMEDOUT,
                "concurrent reset returned before the token callback publication completed");
        pthread_mutex_unlock(&race_mutex);
        race_join_pending = 1;
        literal_event("{\"kind\":\"publication-held\",\"resetReturned\":false}");
    }
}
static void settle_reset_probe(void)
{
    if (!race_join_pending) return;
    join_with_deadline(race_thread, "reset did not resume after callback publication returned");
    race_join_pending = 0;
    pthread_mutex_lock(&race_mutex);
    require(race_finished, "reset probe joined without completing reset");
    pthread_mutex_unlock(&race_mutex);
    literal_event("{\"kind\":\"publication-reset-completed\",\"completed\":true}");
}
static void *foreign_calls(void *unused)
{
    (void)unused;
    int dispatch = api_dispatch();
    int command = api_send("{\"cmd\":1001,\"sno\":900002,\"param\":{}}");
    int registration = api_register(wake);
    flockfile(stdout);
    fprintf(stdout, "{\"kind\":\"foreign-thread\",\"dispatch\":%d,\"command\":%d,\"registration\":%d}\n",
            dispatch, command, registration);
    fflush(stdout);
    funlockfile(stdout);
    return NULL;
}
static void expired(int signal_number)
{
    (void)signal_number;
    static const char message[] = "driver watchdog expired\n";
    (void)write(STDERR_FILENO, message, sizeof(message) - 1);
    _Exit(124);
}
#define LOAD(variable, name) do { \
    void *symbol = dlsym(library, name); \
    require(symbol != NULL, "missing required real adapter export: " name); \
    _Static_assert(sizeof(variable) == sizeof(symbol), "function pointer size"); \
    memcpy(&(variable), &symbol, sizeof(symbol)); \
} while (0)
int main(int argc, char **argv)
{
    require(argc == 2, "usage: ia32-driver /absolute/library/path");
    owner = pthread_self();
    signal(SIGALRM, expired);
    alarm(60);
    setvbuf(stdin, NULL, _IONBF, 0);
    require(pipe2(wake_pipe, O_CLOEXEC | O_NONBLOCK) == 0, "create owner wake pipe");
    void *library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!library) { fprintf(stderr, "dlopen: %s\n", dlerror()); fail("cannot load supplied ia32 library"); }
    LOAD(api_log, "init_config");
    LOAD(api_callback, "set_c2js_callback");
    LOAD(api_register, "meeting_native_auth_set_dispatch_callback");
    LOAD(api_init, "meeting_native_auth_init");
    LOAD(api_reset, "meeting_native_auth_reset");
    LOAD(api_capabilities, "meeting_native_auth_capabilities");
    LOAD(api_send, "js2c_sendmsg");
    LOAD(api_dispatch, "meeting_native_auth_dispatch");
    require(api_callback(json_received) == 2, "original JSON callback registration result must be 2");
    literal_event("{\"kind\":\"loaded\",\"bits\":32,\"jsonCallbackRegistered\":true}");
    char line[65536];
    for (;;) {
        struct pollfd descriptors[] = {{STDIN_FILENO, POLLIN, 0}, {wake_pipe[0], POLLIN, 0}};
        int ready;
        do { ready = poll(descriptors, 2, -1); } while (ready < 0 && errno == EINTR);
        require(ready > 0, "owner poll");
        if (descriptors[1].revents & POLLIN) {
            unsigned char bytes[32];
            ssize_t count;
            while ((count = read(wake_pipe[0], bytes, sizeof(bytes))) > 0)
                for (ssize_t i = 0; i < count; ++i) literal_event("{\"kind\":\"wake\"}");
            require(count < 0 && errno == EAGAIN, "owner wake pipe read");
        }
        if (descriptors[0].revents & (POLLIN | POLLHUP)) {
            require(fgets(line, sizeof(line), stdin) != NULL, "owner command stream ended without Q");
            size_t length = strlen(line);
            require(length && line[length - 1] == '\n', "owner command exceeds bounded input");
            line[length - 1] = 0;
            int result = 0;
            switch (line[0]) {
            case 'L': result = api_log(line + 1); break;
            case 'S': result = api_register(wake); break;
            case 'U': result = api_register(NULL); break;
            case 'V': result = api_register(other_wake); break;
            case 'I': result = api_init(line + 1); break;
            case 'C': result = api_send(line + 1); break;
            case 'R': api_reset(); break;
            case 'D': result = api_dispatch(); break;
            case 'P': data_event("capabilities", api_capabilities()); break;
            case 'B': atomic_store(&probe_next_wake, 1); break;
            case 'A': {
                char action[32];
                require(sscanf(line + 1, "%31s %u", action, &callback_skip) == 2, "invalid callback action");
                callback_action = strcmp(action, "reset") == 0 ? 1 : strcmp(action, "shutdown") == 0 ? 2 :
                                  strcmp(action, "race") == 0 ? 3 : 0;
                require(callback_action != 0, "unknown callback action");
                break;
            }
            case 'F': {
                pthread_t thread;
                require(pthread_create(&thread, NULL, foreign_calls, NULL) == 0, "create foreign caller");
                join_with_deadline(thread, "foreign caller deadlocked");
                break;
            }
            case 'Q':
                api_reset();
                return_event('Q', 0);
                /* No dlclose and no freed callback: the native worker is process-lifetime. */
                _Exit(0);
            default: fail("unknown owner command");
            }
            settle_reset_probe();
            return_event(line[0], result);
        }
    }
}
'''

ACCOUNT = "隔离会议测试@example.invalid"
SECOND_ACCOUNT = "replacement@example.invalid"
DEVICE = "synthetic-loopback-device"
USER_AGENT = "WeLinkNativeVerification/1"
TICKET = "synthetic-workplace-ticket-not-a-real-credential"
TOKEN_A = "synthetic-usg-access-token-A"
TOKEN_B = "synthetic-usg-access-token-B"
REFRESH_A = "synthetic-usg-refresh-token-A"
REFRESH_B = "synthetic-usg-refresh-token-B"
LOGIN_PATH = "/v1/usg/acs/login/proxy"
TOKEN_PATH = "/v1/usg/acs/token"
REFRESH_PATH = "/v2/usg/acs/token"
ACK_NAMES = {1032: "loginLogicAuthorize", 1001: "GetMeetingToken", 110: "RefreshMeetingToken", 1030: "Logout", 50: "InitConfSdkParam"}
NOTIFY_NAMES = {1032: "OnLoginByTokenResult", 1001: "OnGetMeetingTokenResult", 110: "OnRefreshMeetingTokenResult", 1030: "OnLogoutResult"}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def encoded(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def token_reply(token: str = TOKEN_A, refresh: str | None = REFRESH_A, ttl: int = 120) -> dict[str, Any]:
    reply: dict[str, Any] = {"accessToken": token, "validPeriod": ttl}
    if refresh is not None:
        reply["refreshToken"] = refresh
    return reply


@dataclasses.dataclass
class Step:
    method: str
    path: str
    credential: str
    response: Any = None
    status: int = 200
    body: Any = None
    device: str = DEVICE
    disconnect: bool = False
    gate: threading.Event | None = None
    received: threading.Event = dataclasses.field(default_factory=threading.Event)
    completed: threading.Event = dataclasses.field(default_factory=threading.Event)


def login_step(response: Any, *, account: str = ACCOUNT, device: str = DEVICE, gated: bool = False) -> Step:
    return Step("POST", LOGIN_PATH, TICKET, response, body={"account": account, "authServerType": "workplace", "authType": "ShortTicket"},
                device=device, gate=threading.Event() if gated else None)


def refresh_step(response: Any, *, credential: str = REFRESH_A, gated: bool = False) -> Step:
    return Step("PUT", REFRESH_PATH, credential, response, gate=threading.Event() if gated else None)


def logout_step(*, credential: str = TOKEN_A, device: str = DEVICE, status: int = 200, disconnect: bool = False) -> Step:
    response = {"error_code": "USG.100001", "error_msg": "Synthetic unauthorized"} if status == 401 else None
    return Step("DELETE", TOKEN_PATH, credential, response, status=status, device=device, disconnect=disconnect)


class FixtureServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, certificate: Path, key: Path, steps: list[Step]):
        self.steps = collections.deque(steps)
        self.all_steps = steps
        self.lock = threading.Lock()
        self.failures: list[str] = []
        self.request_count = 0
        super().__init__(("127.0.0.1", 0), FixtureHandler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(certificate, key)
        self.socket = context.wrap_socket(self.socket, server_side=True)
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    def check(self) -> None:
        for step in self.all_steps:
            require(step.completed.wait(2), f"fixture did not finish expected {step.method} {step.path}")
        with self.lock:
            require(not self.failures, "; ".join(self.failures))
            require(not self.steps, "the adapter omitted an expected HTTPS operation")
            require(self.request_count == len(self.all_steps), "unexpected HTTPS request count")

    def close(self) -> None:
        for step in self.all_steps:
            if step.gate:
                step.gate.set()
        self.shutdown()
        self.server_close()
        self.thread.join(2)

    def handle_error(self, request: Any, client_address: Any) -> None:
        failure = traceback.format_exc()
        with self.lock:
            self.failures.append("fixture handler raised unexpectedly:\n" + failure)


class FixtureHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args: Any) -> None:
        pass

    def do_POST(self) -> None:
        self.handle_fixture()

    def do_PUT(self) -> None:
        self.handle_fixture()

    def do_DELETE(self) -> None:
        self.handle_fixture()

    def handle_fixture(self) -> None:
        server: FixtureServer = self.server  # type: ignore[assignment]
        with server.lock:
            server.request_count += 1
            step = server.steps.popleft() if server.steps else None
        errors: list[str] = []
        if step is None:
            errors.append("unexpected HTTPS operation")
        else:
            if (self.command, self.path) != (step.method, step.path):
                errors.append("HTTPS method/path does not match the recovered contract")
            for key, expected in {"X-Auth-Token": step.credential, "X-Token-Type": "LongTicket", "User-Agent": USER_AGENT,
                                  "x-device-id": step.device, "Content-Type": "application/json;charset=UTF-8"}.items():
                if self.headers.get(key) != expected:
                    errors.append(f"incorrect {key} header")
            try:
                size = int(self.headers.get("Content-Length", "0"))
                require(0 <= size <= 65536, "unexpected request body length")
                raw = self.rfile.read(size)
                body = json.loads(raw) if raw else None
                if body != step.body:
                    errors.append("request JSON differs from the recovered contract")
            except (ValueError, AssertionError):
                errors.append("invalid request JSON/body length")
        if errors:
            with server.lock:
                server.failures.extend(errors)
        if step:
            step.received.set()
            if step.gate and not step.gate.wait(10):
                with server.lock:
                    server.failures.append("deterministic response gate was not released")
        try:
            if step and step.disconnect:
                self.close_connection = True
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            status = 500 if errors else step.status if step else 500
            response = {"error_code": "USG.100002", "error_msg": "Fixture contract mismatch"} if errors else step.response if step else None
            raw_reply = b"" if response is None else encoded(response).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json;charset=UTF-8")
            self.send_header("Content-Length", str(len(raw_reply)))
            self.send_header("Connection", "close")
            self.end_headers()
            if raw_reply:
                self.wfile.write(raw_reply)
                self.wfile.flush()
            self.close_connection = True
        finally:
            if step:
                step.completed.set()


class Driver:
    def __init__(self, executable: Path, library: Path, directory: Path):
        self.events: list[dict[str, Any]] = []
        self.condition = threading.Condition()
        self.reader_error: str | None = None
        self.reader_done = False
        self.sno = 0
        self.stderr_path = directory / "driver.stderr"
        self.stderr_file = self.stderr_path.open("w", encoding="utf-8")
        try:
            self.process = subprocess.Popen([str(executable), str(library)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                            stderr=self.stderr_file, text=True, encoding="utf-8", bufsize=1, cwd=directory)
        except BaseException:
            self.stderr_file.close()
            raise
        self.reader = threading.Thread(target=self.read_events, daemon=True)
        self.reader.start()
        try:
            _, event = self.wait(lambda e: e.get("kind") == "loaded", 0)
            require(event.get("bits") == 32 and event.get("jsonCallbackRegistered") is True, "real ia32 driver initialization failed")
        except BaseException:
            self.close(False)
            raise

    def read_events(self) -> None:
        assert self.process.stdout is not None
        try:
            for line in self.process.stdout:
                event = json.loads(line)
                require(isinstance(event, dict), "non-object driver event")
                with self.condition:
                    self.events.append(event)
                    self.condition.notify_all()
        except Exception as failure:
            with self.condition:
                self.reader_error = str(failure)
        finally:
            with self.condition:
                self.reader_done = True
                self.condition.notify_all()

    def mark(self) -> int:
        with self.condition:
            return len(self.events)

    def wait(self, predicate: Any, start: int, timeout: float = 8) -> tuple[int, dict[str, Any]]:
        deadline = time.monotonic() + timeout
        with self.condition:
            while True:
                for index in range(start, len(self.events)):
                    if predicate(self.events[index]):
                        return index, self.events[index]
                require(self.reader_error is None, f"driver emitted invalid JSON: {self.reader_error}")
                remaining = deadline - time.monotonic()
                if remaining <= 0 or self.reader_done and self.process.poll() is not None:
                    detail = self.stderr_path.read_text(encoding="utf-8", errors="replace")
                    raise AssertionError(f"driver event missing (exit={self.process.poll()}): {detail.strip()}")
                self.condition.wait(min(remaining, 0.05))

    def call(self, operation: str, payload: str = "", expected: int = 0) -> int:
        start = self.mark()
        assert self.process.stdin is not None
        self.process.stdin.write(operation + payload + "\n")
        self.process.stdin.flush()
        _, event = self.wait(lambda e: e.get("kind") == "return" and e.get("op") == operation, start)
        require(event.get("result") == expected, f"native operation {operation} returned {event.get('result')}, expected {expected}")
        return start

    def capabilities(self) -> dict[str, Any]:
        start = self.call("P")
        _, event = self.wait(lambda e: e.get("kind") == "capabilities", start)
        return event["data"]

    def idle(self) -> None:
        deadline = time.monotonic() + 2
        while True:
            capabilities = self.capabilities()
            if not capabilities.get("operationPending"):
                require(capabilities.get("loginPending") is False and capabilities.get("logoutPending") is False,
                        "pending-operation flags disagree after completion")
                return
            require(time.monotonic() < deadline, "real worker did not retire its completed job")
            time.sleep(0.005)

    def command(self, command: int, param: Any = None, expected: int = 0) -> tuple[int, int]:
        self.sno += 1
        start = self.call("C", encoded({"cmd": command, "sno": self.sno, "param": {} if param is None else param}), expected)
        index, event = self.wait(lambda e: e.get("kind") == "callback" and e.get("data", {}).get("rsp") == command and
                                e.get("data", {}).get("sno") == self.sno, start)
        ack = event["data"]
        require(ack.get("notify") is None and "notify" in ack, "ACK lacks the original null notify field")
        require(ack.get("description") == ACK_NAMES[command] and ack.get("result") == expected, "ACK identity/result mismatch")
        return start, index

    def notification(self, command: int, start: int, result: int, *, after: int | None = None) -> dict[str, Any]:
        index, event = self.wait(lambda e: e.get("kind") == "callback" and e.get("data", {}).get("notify") == command, start)
        notice = event["data"]
        require(after is None or index > after, "completion preceded its command ACK")
        require(notice.get("rsp") is None and "rsp" in notice, "notification lacks original null rsp")
        require(notice.get("description") == NOTIFY_NAMES[command], "notification description mismatch")
        require(notice.get("result") == result, f"notification {command} result {notice.get('result')} != {result}")
        require(notice.get("param", {}).get("reason_code") == result, "reason_code does not preserve actual operation result")
        if result:
            require(not notice.get("param", {}).get("token"), "failure published a credential")
        return notice

    def dispatch_after_wake(self, start: int) -> None:
        self.wait(lambda e: e.get("kind") == "wake", start)
        self.call("D")

    def read_token(self, expected: str) -> dict[str, Any]:
        start, ack = self.command(1001)
        notice = self.notification(1001, start, 0, after=ack)
        require(notice["param"].get("token") == expected, "GetMeetingToken returned the wrong cache generation")
        return notice

    def close(self, successful: bool) -> None:
        try:
            if successful:
                self.idle()
                self.call("Q")
                require(self.process.wait(3) == 0, "driver failed during process-lifetime shutdown")
            elif self.process.poll() is None:
                self.process.kill()
                self.process.wait(3)
        finally:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait(3)
            if self.process.stdin:
                self.process.stdin.close()
            self.reader.join(1)
            if self.process.stdout:
                self.process.stdout.close()
            self.stderr_file.close()


class Case:
    def __init__(self, environment: Any, name: str, steps: list[Step], *, trusted: bool = True, check_registration: bool = False):
        self.directory = environment.root / name
        self.directory.mkdir()
        self.server = FixtureServer(environment.certificate, environment.key, steps)
        driver = None
        try:
            driver = Driver(environment.driver, environment.library, self.directory)
            self.driver = driver
            self.config: dict[str, Any] = {"server": "127.0.0.1", "port": self.server.server_port,
                                           "userAgent": USER_AGENT, "deviceId": DEVICE}
            if trusted:
                self.config["caBundle"] = str(environment.ca)
            driver.call("L", encoded({"param": {"nativelogpath": str(self.directory / "logs"), "log_name": "meeting-verification.log"}}))
            if check_registration:
                driver.call("I", encoded(self.config), -errno.ENODEV)
            driver.call("S")
            driver.call("I", encoded(self.config))
            self.successful = False
        except BaseException:
            try:
                if driver is not None:
                    driver.close(False)
            finally:
                self.server.close()
            raise

    def __enter__(self) -> Case:
        return self

    def __exit__(self, kind: Any, value: Any, traceback: Any) -> None:
        try:
            if kind is None:
                self.server.check()
                self.successful = True
        finally:
            try:
                self.driver.close(self.successful)
            finally:
                self.server.close()

    def login(self, *, account: str = ACCOUNT, expected: int = 0) -> tuple[int, int]:
        start, ack = self.driver.command(1032, {"username": account, "middleGroundToken": TICKET})
        self.driver.dispatch_after_wake(start)
        self.driver.notification(1032, start, expected, after=ack)
        self.driver.idle()
        return start, ack

    def logout(self, expected: int = 0) -> None:
        start, ack = self.driver.command(1030)
        self.driver.dispatch_after_wake(start)
        self.driver.notification(1030, start, expected, after=ack)
        self.driver.idle()
        capabilities = self.driver.capabilities()
        require(capabilities.get("hasToken") is False and capabilities.get("hasRefreshToken") is False,
                "logout retained local credentials")


def lifecycle(environment: Any) -> None:
    with Case(environment, "lifecycle", [login_step(token_reply()), refresh_step(token_reply(TOKEN_B, REFRESH_B)),
                                          logout_step(credential=TOKEN_B)], check_registration=True) as case:
        driver = case.driver
        driver.call("S")
        driver.call("U", expected=-errno.EINVAL)
        driver.call("V", expected=-errno.EALREADY)
        start = driver.call("F")
        _, foreign = driver.wait(lambda e: e.get("kind") == "foreign-thread", start)
        require((foreign.get("dispatch"), foreign.get("command"), foreign.get("registration")) ==
                (-errno.EPERM, -errno.EPERM, -errno.EALREADY), "owner guard did not reject foreign calls")
        before = driver.mark()
        driver.call("D")
        require(not any(e.get("kind") == "callback" for e in driver.events[before:]), "empty dispatch emitted a completion")
        driver.command(50, expected=-errno.ENODEV)
        require(driver.capabilities().get("mediaReady") is False, "authentication manufactured media readiness")
        driver.read_token("")  # Original pre-login cache semantics, not an authenticated service result.
        case.login()
        require(driver.capabilities().get("expiryKnown") is True, "server lease was not retained")
        driver.read_token(TOKEN_A)
        start, ack = driver.command(110)
        driver.dispatch_after_wake(start)
        driver.notification(110, start, 0, after=ack)
        driver.idle()
        driver.read_token(TOKEN_B)
        case.logout()
        driver.read_token("")


def invalid_reply(environment: Any, name: str, reply: Any, result: int) -> None:
    with Case(environment, name, [login_step(reply)]) as case:
        case.login(expected=result)
        capabilities = case.driver.capabilities()
        require(capabilities.get("hasToken") is False and capabilities.get("hasRefreshToken") is False,
                "invalid token/lease response established authentication")
        case.driver.read_token("")


def absolute_expiry(environment: Any) -> None:
    reply = {"accessToken": TOKEN_A, "refreshToken": REFRESH_A, "expireTime": int(time.time()) + 120}
    with Case(environment, "absolute-expiry", [login_step(reply), logout_step()]) as case:
        case.login()
        require(case.driver.capabilities().get("expiryKnown") is True, "absolute server expiry was ignored")
        case.driver.read_token(TOKEN_A)
        case.logout()


def stale_generation(environment: Any, *, queued: bool, reinitialize: bool) -> None:
    name = ("queued" if queued else "delayed") + ("-reinitialize" if reinitialize else "-reset")
    old = login_step(token_reply(), gated=not queued)
    device = DEVICE + "-second" if reinitialize else DEVICE
    replacement = login_step(token_reply(TOKEN_B, REFRESH_B), account=SECOND_ACCOUNT, device=device)
    with Case(environment, name, [old, replacement, logout_step(credential=TOKEN_B, device=device)]) as case:
        driver = case.driver
        start, ack = driver.command(1032, {"username": ACCOUNT, "middleGroundToken": TICKET})
        require(old.received.wait(3), "old real HTTPS login did not enter the response barrier")
        if queued:
            driver.wait(lambda e: e.get("kind") == "wake", start)
            require(driver.capabilities().get("hasToken") is True, "queued-race precondition: response was not cached")
        if reinitialize:
            case.config["deviceId"] = device
            driver.call("I", encoded(case.config))
        else:
            driver.call("R")
        require(driver.capabilities().get("hasToken") is False, "reset/reinitialize did not clear the old cache")
        if old.gate:
            old.gate.set()
        driver.dispatch_after_wake(start)
        driver.notification(1032, start, -errno.ECANCELED, after=ack)
        driver.idle()
        driver.read_token("")
        case.login(account=SECOND_ACCOUNT)
        driver.read_token(TOKEN_B)
        case.logout()


def queued_refresh_token_reset(environment: Any) -> None:
    refreshing = refresh_step(token_reply(TOKEN_B, REFRESH_B), gated=True)
    with Case(environment, "queued-refresh-token-reset", [login_step(token_reply()), refreshing]) as case:
        driver = case.driver
        case.login()
        refresh_start, refresh_ack = driver.command(110)
        require(refreshing.received.wait(3), "refresh did not enter its HTTPS barrier")
        token_start, token_ack = driver.command(1001)
        require(not any(e.get("kind") == "callback" and e.get("data", {}).get("notify") == 1001
                        for e in driver.events[token_start:]), "token read did not share the in-flight refresh")
        assert refreshing.gate is not None
        refreshing.gate.set()
        driver.wait(lambda e: e.get("kind") == "wake", refresh_start)
        driver.call("R")
        driver.call("D")
        driver.notification(110, refresh_start, -errno.ECANCELED, after=refresh_ack)
        driver.notification(1001, token_start, -errno.ECANCELED, after=token_ack)
        driver.idle()
        driver.read_token("")


def queued_refresh_expiry(environment: Any) -> None:
    # Explicitly clear the server refresh credential so automatic renewal cannot
    # hide the expired publication while this single batch waits for its owner.
    reply = {"accessToken": TOKEN_B, "validPeriod": 1, "refreshToken": None}
    refreshing = refresh_step(reply, gated=True)
    with Case(environment, "queued-refresh-expiry", [login_step(token_reply()), refreshing]) as case:
        driver = case.driver
        case.login()
        refresh_start, refresh_ack = driver.command(110)
        require(refreshing.received.wait(3), "short-lease refresh did not enter its HTTPS barrier")
        token_start, token_ack = driver.command(1001)
        assert refreshing.gate is not None
        refreshing.gate.set()
        driver.wait(lambda e: e.get("kind") == "wake", refresh_start)
        capabilities = driver.capabilities()
        require(capabilities.get("hasToken") is True and capabilities.get("expiryKnown") is True and
                capabilities.get("hasRefreshToken") is False, "short-lease publication precondition was not established")
        # This is the real monotonic-clock lease, not a mocked clock or adapter.
        time.sleep(1.2)
        driver.call("D")
        driver.notification(110, refresh_start, -errno.EKEYEXPIRED, after=refresh_ack)
        driver.notification(1001, token_start, -errno.EKEYEXPIRED, after=token_ack)
        driver.idle()
        expired_start, _ = driver.command(1001, expected=-errno.EKEYEXPIRED)
        require(not any(e.get("kind") == "callback" and e.get("data", {}).get("notify") == 1001 and
                        e.get("data", {}).get("result") == 0 for e in driver.events[expired_start:]),
                "an expired cache read published success")
        driver.call("R")
        driver.read_token("")


def wake_lock_probe(environment: Any) -> None:
    with Case(environment, "wake-lock-probe", [login_step(token_reply())]) as case:
        driver = case.driver
        driver.call("B")
        start, ack = driver.command(1032, {"username": ACCOUNT, "middleGroundToken": TICKET})
        _, probe = driver.wait(lambda e: e.get("kind") == "wake-lock-probe", start)
        require(probe.get("completed") is True, "worker wake lock probe did not complete")
        _, capabilities = driver.wait(lambda e: e.get("kind") == "probe-capabilities", start)
        require(capabilities["data"].get("hasToken") is False, "wake probe reset did not invalidate the queued token")
        driver.dispatch_after_wake(start)
        driver.notification(1032, start, -errno.ECANCELED, after=ack)
        driver.idle()
        driver.read_token("")


def callback_reset(environment: Any, *, concurrent: bool) -> None:
    name = "publication-reset-barrier" if concurrent else "callback-reset-reentry"
    with Case(environment, name, [login_step(token_reply())]) as case:
        driver = case.driver
        case.login()
        driver.call("A", ("race" if concurrent else "reset") + " 1")  # Skip ACK; act inside the token notification.
        start = driver.mark()
        driver.read_token(TOKEN_A)
        if concurrent:
            held_index, held = driver.wait(lambda e: e.get("kind") == "publication-held", start)
            done_index, done = driver.wait(lambda e: e.get("kind") == "publication-reset-completed", start)
            require(held.get("resetReturned") is False and done.get("completed") is True and done_index > held_index,
                    "reset/publication ordering was not linearized")
        else:
            _, event = driver.wait(lambda e: e.get("kind") == "callback-action", start)
            require(event.get("action") == "reset" and event.get("result") == 0, "owner reset callback did not return")
        require(driver.capabilities().get("hasToken") is False, "callback reset left the old token cached")
        driver.read_token("")


def callback_shutdown(environment: Any) -> None:
    with Case(environment, "callback-shutdown-reentry", [login_step(token_reply()), logout_step()]) as case:
        driver = case.driver
        start, ack = driver.command(1032, {"username": ACCOUNT, "middleGroundToken": TICKET})
        driver.wait(lambda e: e.get("kind") == "wake", start)
        driver.call("A", "shutdown 0")
        driver.call("D")
        driver.notification(1032, start, 0, after=ack)
        action_index, action = driver.wait(lambda e: e.get("kind") == "callback-action", start)
        require(action.get("action") == "shutdown" and action.get("result") == 0, "reentrant real logout admission failed")
        logout_ack, event = driver.wait(lambda e: e.get("kind") == "callback" and e.get("data", {}).get("rsp") == 1030, start)
        require(event["data"].get("sno") == 900001 and event["data"].get("result") == 0,
                "reentrant logout did not emit its original ACK")
        driver.dispatch_after_wake(action_index + 1)
        driver.notification(1030, start, 0, after=logout_ack)
        driver.idle()
        driver.call("R")
        require(driver.capabilities().get("hasToken") is False, "shutdown retained authentication")


def logout_failure(environment: Any, *, disconnected: bool) -> None:
    name = "logout-network-failure" if disconnected else "logout-http-401"
    step = logout_step(disconnect=disconnected, status=200 if disconnected else 401)
    with Case(environment, name, [login_step(token_reply()), step]) as case:
        case.login()
        case.logout(expected=-errno.EIO if disconnected else 200100001)
        case.driver.read_token("")


def invalid_refresh(environment: Any) -> None:
    bad = {"accessToken": TOKEN_B, "refreshToken": REFRESH_B}
    with Case(environment, "refresh-missing-expiry", [login_step(token_reply()), refresh_step(bad), logout_step()]) as case:
        driver = case.driver
        case.login()
        start, ack = driver.command(110)
        driver.dispatch_after_wake(start)
        driver.notification(110, start, -errno.EPROTO, after=ack)
        driver.idle()
        driver.read_token(TOKEN_A)
        case.logout()  # Must revoke the previous, still-valid token, not the rejected replacement.


def automatic_refresh(environment: Any) -> None:
    with Case(environment, "automatic-refresh", [login_step(token_reply(ttl=4)), refresh_step(token_reply(TOKEN_B, REFRESH_B)),
                                                  logout_step(credential=TOKEN_B)]) as case:
        driver = case.driver
        login_start, _ = case.login()
        first_wake, _ = driver.wait(lambda e: e.get("kind") == "wake", login_start)
        start = first_wake + 1
        driver.dispatch_after_wake(start)
        driver.notification(110, start, 0)
        require(not any(e.get("kind") == "callback" and e.get("data", {}).get("rsp") == 110 for e in driver.events[start:]),
                "automatic refresh invented a command ACK")
        driver.idle()
        driver.read_token(TOKEN_B)
        case.logout()


def untrusted_tls(environment: Any) -> None:
    with Case(environment, "untrusted-tls", [], trusted=False) as case:
        case.login(expected=-errno.EIO)
        require(case.driver.capabilities().get("hasToken") is False, "untrusted TLS established authentication")
        case.driver.read_token("")


def provision(environment: Any, compiler: str, extra_flags: list[str]) -> None:
    openssl = shutil.which("openssl")
    require(openssl is not None, "openssl is required to generate the isolated test CA")
    source = environment.root / "meeting-driver.c"
    source.write_text(DRIVER_SOURCE, encoding="utf-8")
    command = shlex.split(compiler) + ["-m32", "-std=gnu11", "-O2", "-pthread"] + extra_flags + [str(source), "-ldl", "-o", str(environment.driver)]
    subprocess.run(command, check=True, capture_output=True, text=True)
    ca_key = environment.root / "ca.key"
    request = environment.root / "server.csr"
    extensions = environment.root / "server.ext"
    extensions.write_text("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n", encoding="ascii")
    commands = [
        [openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-subj", "/CN=WeLink isolated verification CA",
         "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", str(ca_key), "-out", str(environment.ca)],
        [openssl, "req", "-newkey", "rsa:2048", "-nodes", "-sha256", "-subj", "/CN=127.0.0.1", "-keyout", str(environment.key), "-out", str(request)],
        [openssl, "x509", "-req", "-in", str(request), "-CA", str(environment.ca), "-CAkey", str(ca_key), "-CAcreateserial", "-days", "1", "-sha256",
         "-extfile", str(extensions), "-out", str(environment.certificate)],
    ]
    for command in commands:
        subprocess.run(command, check=True, capture_output=True, text=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--library", type=Path, required=True, help="real rebuilt ia32 meeting_adapter.so/.dll.so")
    parser.add_argument("--cc", default=os.environ.get("CC", "cc"), help="32-bit-capable C compiler command")
    parser.add_argument("--cflag", action="append", default=[], help="additional driver compiler flag; use --cflag=-flag")
    parser.add_argument("--case", dest="cases", action="append", metavar="NAME",
                        help="run only this exact scenario name; repeat to select multiple scenarios")
    args = parser.parse_args()
    library = args.library.resolve(strict=True)
    with library.open("rb") as handle:
        header = handle.read(20)
    require(header[:5] == b"\x7fELF\x01" and header[5] == 1 and int.from_bytes(header[18:20], "little") == 3,
            "--library must be a real little-endian ELF32 i386 shared object")
    previous_umask = os.umask(0o077)
    try:
        with tempfile.TemporaryDirectory(prefix="welink-meeting-verify-") as temporary:
            from types import SimpleNamespace
            root = Path(temporary)
            environment = SimpleNamespace(root=root, library=library, driver=root / "meeting-driver", ca=root / "ca.pem",
                                          certificate=root / "server.pem", key=root / "server.key")
            provision(environment, args.cc, args.cflag)
            tests: list[tuple[str, Any]] = [("lifecycle / TLS / owner ABI / ACK ordering", lambda: lifecycle(environment))]
            invalid = [
                ("missing-token", {"validPeriod": 120}, -errno.EPROTO),
                ("empty-token", {"accessToken": "", "validPeriod": 120}, -errno.EPROTO),
                ("embedded-nul-token", {"accessToken": "synthetic\u0000suffix", "validPeriod": 120}, -errno.EPROTO),
                ("missing-expiry", {"accessToken": TOKEN_A, "refreshToken": REFRESH_A}, -errno.EPROTO),
                ("zero-expiry", token_reply(ttl=0), -errno.EKEYEXPIRED),
                ("expired-absolute", {"accessToken": TOKEN_A, "expireTime": int(time.time()) - 10}, -errno.EKEYEXPIRED),
                ("contradictory-expiry", {**token_reply(), "expireTime": int(time.time()) - 10}, -errno.EKEYEXPIRED),
            ]
            tests.extend((name, lambda name=name, reply=reply, result=result: invalid_reply(environment, name, reply, result))
                         for name, reply, result in invalid)
            tests.append(("absolute server expiry", lambda: absolute_expiry(environment)))
            tests.extend((("queued" if queued else "delayed") + (" reinitialize" if reinitialize else " reset"),
                          lambda queued=queued, reinitialize=reinitialize: stale_generation(environment, queued=queued, reinitialize=reinitialize))
                         for queued in (False, True) for reinitialize in (False, True))
            tests.extend([
                ("queued refresh/token-read cancellation", lambda: queued_refresh_token_reset(environment)),
                ("queued refresh expires before owner dispatch", lambda: queued_refresh_expiry(environment)),
                ("worker wake holds neither adapter lock", lambda: wake_lock_probe(environment)),
                ("owner callback reset reentry", lambda: callback_reset(environment, concurrent=False)),
                ("publication/concurrent-reset barrier", lambda: callback_reset(environment, concurrent=True)),
                ("owner callback graceful shutdown reentry", lambda: callback_shutdown(environment)),
                ("HTTP 401 is not server logout", lambda: logout_failure(environment, disconnected=False)),
                ("network failure is not server logout", lambda: logout_failure(environment, disconnected=True)),
                ("invalid refresh does not replace cache", lambda: invalid_refresh(environment)),
                ("automatic refresh uses server lease", lambda: automatic_refresh(environment)),
                ("untrusted TLS is rejected", lambda: untrusted_tls(environment)),
            ])
            if args.cases:
                selected = set(args.cases)
                unknown = selected - {name for name, _ in tests}
                require(not unknown, "unknown scenario name(s): " + ", ".join(sorted(unknown)))
                tests = [(name, test) for name, test in tests if name in selected]
            for name, test in tests:
                test()
                print("PASS " + name, flush=True)
            print(f"PASS {len(tests)} isolated scenarios using the supplied real ia32 adapter; no real meeting/media operations.")
    finally:
        os.umask(previous_umask)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as failure:
        raise SystemExit(f"Verification prerequisite/driver command failed ({failure.returncode}):\n{failure.stderr or failure.stdout or ''}") from failure
