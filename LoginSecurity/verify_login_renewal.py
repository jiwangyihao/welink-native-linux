#!/usr/bin/env python3
"""Only the newly added renewal/reconnect regressions; never reruns the old 11.

Requires the adjacent, parent-validated verify_login_security.py, or an explicit
--base-fixture path to that file. Its real 32-bit driver, private JSON-C setup,
synthetic CA and protocol-checking TLS peer are reused, without editing it.

Evidence: wk_login.dll 7.47.6.95 FSM at RVA 0x7c428; terminal predicate 0x1a480;
renewal failure -> request kind 2 at 0x1acb0; credential selection 0x24510,
0x26e60, 0x27360, 0x26c50, 0x27880. Request kind 2 is NOT login_type 2 and is NOT
permission to replay a consumed SSO/QR authorization code.

No library implementation is mocked. Requests go through the supplied .so and
verified loopback HTTPS; only the synthetic remote peer's response sequence is
controlled. Native files are not rebuilt, patched or replaced by this program.
The base fixture prepares its ordinary driver/test artifacts in a temporary dir;
none of its old test functions or integrity scenarios are invoked.
"""
from __future__ import annotations

import argparse
import collections
import importlib.util
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import time


CASE_NAMES = (
    "missing-refresh",
    "consumed-code",
    "caller-refresh-source",
    "immediate-reconnect",
    "reconnect-backoff",
    "terminal-errors",
    "cancel-reconnect",
)


def load_fixture(path: Path):
    spec = importlib.util.spec_from_file_location("_welink_renewal_base", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load the parent-validated base fixture")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def peer_type(f):
    class RenewalPeer(f.Peer):
        def __init__(self, crypto):
            self.plans = {}
            self.all_grants = []
            self.consumed_codes = set()
            self.failed_name_handshakes = 0
            super().__init__(crypto)
            inherited = self.server.RequestHandlerClass

            class Handler(inherited):
                def handle_one_request(self):
                    self._renewal_post_started = False
                    try:
                        return super().handle_one_request()
                    except (ConnectionResetError, BrokenPipeError):
                        # Same observed pre-parse transport exception allowed by
                        # the parent fixture; no parsed-protocol failures ignored.
                        if self._renewal_post_started:
                            raise
                        self.close_connection = True

                def do_POST(self):
                    self._renewal_post_started = True
                    return super().do_POST()

            self.server.RequestHandlerClass = Handler

        def plan(self, path, selector, *grants):
            f.require(bool(grants), "renewal response plan must not be empty")
            with self.lock:
                key = (path, selector)
                f.require(key not in self.plans, "duplicate renewal response plan")
                self.plans[key] = collections.deque(grants)
                self.all_grants.extend(grants)
            return grants

        def handle(self, path, headers, raw):
            if path not in (self.LOGIN, self.SSO, self.QR, self.REFRESH):
                return super().handle(path, headers, raw)
            try:
                body = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                raise f.Failure("renewal peer received invalid JSON") from None
            f.require(isinstance(body, dict), "renewal body is not an object")
            if path == self.LOGIN:
                selector = headers.get("tmpCode", "")
            elif path in (self.SSO, self.QR):
                selector = body.get("code")
            else:
                selector = body.get("refresh_token")
            f.require(isinstance(selector, str), "renewal used the wrong credential field")
            with self.lock:
                if path in (self.SSO, self.QR):
                    f.require(selector not in self.consumed_codes,
                              "native renewal replayed a consumed one-use SSO/QR code")
                plan = self.plans.get((path, selector))
                f.require(plan is not None and bool(plan),
                          "unexpected credential, endpoint or extra renewal/reconnect attempt")
                grant = plan.popleft()
                if path == self.REFRESH:
                    self.refreshes[selector] = grant
                else:
                    self.grants[headers.get("tmpCode", "")] = grant
            result = super().handle(path, headers, raw)
            # The base peer decrypts/validates every RSA credential and checks
            # the actual wire schema before minting these synthetic tokens.
            if path in (self.SSO, self.QR) and isinstance(result[1], dict) and result[1].get("crypt_token"):
                with self.lock:
                    self.consumed_codes.add(selector)
            return result

        def use_wrong_hostname_certificate(self):
            # A listening SSLSocket has no connected _sslobj for its context
            # setter. Future accepts use the existing mutable SSLContext.
            context = self.server.socket.context
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            context.load_cert_chain(str(self.crypto.wrong_name_cert), str(self.crypto.tls_key))

            def count_handshake(_socket, _server_name, _context):
                with self.lock:
                    self.failed_name_handshakes += 1

            context.set_servername_callback(count_handshake)

        def handshake_count(self):
            with self.lock:
                return self.failed_name_handshakes

        def request_time(self, name):
            with self.lock:
                matches = [r["time"] for r in self.requests if r["name"] == name]
            f.require(len(matches) == 1, "expected exactly one planned HTTPS request")
            return matches[0]

        def close(self):
            for grant in self.all_grants:
                grant.release.set()
            super().close()

    return RenewalPeer


def wait_until(f, driver, peer, predicate, timeout=5):
    deadline = time.monotonic()+timeout
    while True:
        peer.check_errors()
        if predicate():
            return
        if time.monotonic() >= deadline:
            raise f.Failure("timed out waiting for the new renewal state transition")
        driver.idle(0.02, pump=True, peer=peer)


def notices(driver, since, event, *, error=None):
    values = [m for m in driver.callbacks[since:] if m.get("notify") == event]
    if error is not None:
        values = [m for m in values if (m.get("param") or {}).get("error_code") == error]
    return values


def server_errors(driver, since, code):
    return [m for m in notices(driver, since, 4)
            if (m.get("param") or {}).get("middleGroundErrorCode") == str(code)]


def no_terminal_failure(f, driver, since):
    f.require(not notices(driver, since, 1), "recoverable renewal produced a terminal OnError")
    f.require(not any((m.get("param") or {}).get("loginIntent") == 0
                      for m in notices(driver, since, 2)),
              "recoverable renewal cleared login intent")


def no_new_token(f, driver, since, token):
    f.absent_token(driver, token, since)


def start_auth(f, h, driver, peer, grant, *, kind=None, password=""):
    sno = h.sno()
    driver.send(h.auth(peer, grant, sno, kind=kind, password=password))
    f.require(driver.response(4, sno, peer=peer).get("result") == 0,
              "synthetic initial authentication did not succeed")
    h.online(driver, grant.response["crypt_token"], peer=peer)
    return sno


def renew(f, h, driver, command_id=7):
    sno = h.sno()
    driver.send(f.message(command_id, sno))
    f.require(driver.response(command_id, sno).get("result") == 0,
              "renewal command acknowledgement changed")
    return sno


def busy(f, name):
    return f.Grant(name, mode="refresh", response={"code": 41524, "message": "synthetic server busy"})


def terminal(f, h, driver, peer, since, error, server_code=None):
    driver.wait_message(lambda m: m.get("notify") == 1 and
                        (m.get("param") or {}).get("error_code") == error,
                        since=since, timeout=5, peer=peer)
    offline = h.offline(driver, since=since)["param"]
    f.require(offline.get("middle_ground_token") == "" and
              offline.get("middle_ground_refreshtoken") == "",
              "terminal renewal failure retained published credentials")
    f.require(not any((m.get("param") or {}).get("login_status") == 2
                      for m in notices(driver, since, 2)),
              "terminal renewal fabricated a successful online event")
    if server_code is not None:
        matches = server_errors(driver, since, server_code)
        f.require(len(matches) == 1, "nonempty server error was not delivered exactly once")
        events = driver.callbacks[since:]
        i4 = next(i for i, m in enumerate(events) if m in matches)
        i1 = next(i for i, m in enumerate(events) if m.get("notify") == 1 and
                  (m.get("param") or {}).get("error_code") == error)
        i0 = next(i for i, m in enumerate(events) if m.get("notify") == 2 and
                  (m.get("param") or {}).get("loginIntent") == 0)
        f.require(i4 < i1 < i0, "terminal server/error/offline notification ordering changed")


def missing_refresh(f, h, Peer):
    for kind in (0, 3):
        with Peer(h.crypto) as peer, h.open("login") as driver:
            h.key(driver)
            initial = f.Grant("missing-refresh-initial-"+str(kind), mode="normal")
            initial.response.pop("refresh_token")
            recovered = f.Grant("missing-refresh-recovered-"+str(kind), mode="normal")
            peer.plan(peer.LOGIN, initial.name, initial, recovered)
            password = h.encrypt(driver, initial.password)
            start_auth(f, h, driver, peer, initial, kind=kind, password=password)
            since = len(driver.callbacks)
            renew(f, h, driver)
            peer.wait_seen(recovered, timeout=3)
            event = h.online(driver, recovered.response["crypt_token"], since=since, peer=peer)
            f.require(event["param"].get("is_refreshtoken_or_reconnect") is True,
                      "credential-based renewal was mislabeled as initial login")
            f.require(peer.count(peer.LOGIN) == 2 and peer.count(peer.REFRESH) == 0,
                      "missing refresh token did not reuse retained normal/penetrate credentials")
            no_terminal_failure(f, driver, since)
            peer.check_errors()


def consumed_code(f, h, Peer):
    for mode in ("sso", "qr"):
        for has_refresh in (True, False):
            with Peer(h.crypto) as peer, h.open("login") as driver:
                h.key(driver)
                initial = f.Grant("consumed-"+mode+"-"+str(int(has_refresh)), mode=mode)
                if not has_refresh:
                    initial.response.pop("refresh_token")
                path = peer.SSO if mode == "sso" else peer.QR
                peer.plan(path, initial.code, initial)
                if has_refresh:
                    response = f.Grant("consumed-code-renewed-"+mode, mode="refresh")
                    refresh_token = initial.response["refresh_token"]
                else:
                    response = f.Grant("consumed-code-empty-refresh-"+mode, mode="refresh",
                                       response={"errorCode": "4004", "errorMessage": "synthetic missing refresh token"})
                    refresh_token = ""
                peer.plan(peer.REFRESH, refresh_token, response)
                start_auth(f, h, driver, peer, initial)
                since = len(driver.callbacks)
                renew(f, h, driver, 11)
                peer.wait_seen(response, timeout=3)
                if has_refresh:
                    h.online(driver, response.response["crypt_token"], since=since, peer=peer)
                    no_terminal_failure(f, driver, since)
                else:
                    terminal(f, h, driver, peer, since, 10013, "4004")
                driver.idle(0.3, pump=True, peer=peer)
                f.require(peer.count(path) == 1 and peer.count(peer.REFRESH) == 1 and
                          peer.count(peer.LOGIN) == 0,
                          "consumed code was replayed or replaced with guessed password credentials")
                peer.check_errors()


def caller_refresh_source(f, h, Peer):
    with Peer(h.crypto) as peer, h.open("login") as driver:
        h.key(driver)
        initial = f.Grant("caller-refresh-initial", mode="refresh-login")
        # Intentionally differs from the supplied type-4 credential. RVA 24510
        # uses the original caller-supplied refreshtoken for this login type.
        initial.response["refresh_token"] = "synthetic-rotated-token-not-the-type4-input"
        recovered = f.Grant("caller-refresh-renewed", mode="refresh")
        seed = "synthetic-seed-"+initial.name
        peer.plan(peer.REFRESH, seed, initial, recovered)
        start_auth(f, h, driver, peer, initial)
        since = len(driver.callbacks)
        renew(f, h, driver, 11)
        peer.wait_seen(recovered, timeout=3)
        h.online(driver, recovered.response["crypt_token"], since=since, peer=peer)
        no_terminal_failure(f, driver, since)
        f.require(peer.count(peer.REFRESH) == 2, "type-4 refresh credential source changed")
        peer.check_errors()


def immediate_reconnect(f, h, Peer):
    with Peer(h.crypto) as peer, h.open("login") as driver:
        h.key(driver)
        initial = f.Grant("immediate-reconnect-initial")
        rejected = busy(f, "immediate-reconnect-busy")
        recovered = f.Grant("immediate-reconnect-success", mode="refresh", hold=True)
        peer.plan(peer.QR, initial.code, initial)
        peer.plan(peer.REFRESH, initial.response["refresh_token"], rejected, recovered)
        start_auth(f, h, driver, peer, initial)
        since = len(driver.callbacks)
        renew(f, h, driver)
        peer.wait_seen(recovered, timeout=3)
        f.require(peer.request_time(recovered.name)-peer.request_time(rejected.name) < 3,
                  "recoverable renewal waited for reconnect backoff before its first reconnect")
        recovered.release.set()
        h.online(driver, recovered.response["crypt_token"], since=since, peer=peer)
        no_terminal_failure(f, driver, since)
        f.require(len(server_errors(driver, since, 41524)) == 1,
                  "recoverable service rejection lost its original server-error notification")
        f.require(peer.count(peer.QR) == 1 and peer.count(peer.REFRESH) == 2,
                  "immediate reconnect used the wrong credential path")
        peer.check_errors()


def reconnect_backoff(f, h, Peer):
    with Peer(h.crypto) as peer, h.open("login") as driver:
        h.key(driver)
        initial = f.Grant("backoff-initial")
        first, second, third = (busy(f, "backoff-busy-"+str(i)) for i in range(1, 4))
        recovered = f.Grant("backoff-wakeup-success", mode="refresh")
        peer.plan(peer.QR, initial.code, initial)
        peer.plan(peer.REFRESH, initial.response["refresh_token"], first, second, third, recovered)
        start_auth(f, h, driver, peer, initial)
        since = len(driver.callbacks)
        renew(f, h, driver)
        peer.wait_seen(second, timeout=3)
        wait_until(f, driver, peer, lambda: len(server_errors(driver, since, 41524)) == 2)
        # Events 4/5 are absent from the original CONNECTING state. Their
        # acknowledgements must not start another renewal or cancel its timer.
        renew(f, h, driver, 7)
        renew(f, h, driver, 11)
        driver.idle(0.4, pump=True, peer=peer)
        f.require(peer.count(peer.REFRESH) == 2, "cmd7/11 restarted refresh during reconnect backoff")
        peer.wait_seen(third, timeout=14)
        delta = peer.request_time(third.name)-peer.request_time(second.name)
        f.require(8 <= delta < 14, "first failed-reconnect backoff did not use the original ten seconds")
        wait_until(f, driver, peer, lambda: len(server_errors(driver, since, 41524)) == 3)
        driver.idle(1.0, pump=True, peer=peer)
        f.require(peer.count(peer.REFRESH) == 3,
                  "reconnect timer restarted kind-1 renewal and immediately doubled the next request")
        wake = h.sno()
        driver.send(f.message(3, wake))
        f.require(driver.response(3, wake).get("result") == 0, "wakeup acknowledgement changed")
        peer.wait_seen(recovered, timeout=3)
        h.online(driver, recovered.response["crypt_token"], since=since, peer=peer)
        no_terminal_failure(f, driver, since)
        f.require(peer.count(peer.QR) == 1, "reconnect timer/wakeup replayed the consumed code")
        peer.check_errors()


def terminal_errors(f, h, Peer):
    for name, response, error, server_code in (
        ("general", {"code": 41580, "message": "synthetic terminal failure"}, 10001, "41580"),
        ("expired", {"errorCode": "4004", "errorMessage": "synthetic expired refresh"}, 10013, "4004"),
    ):
        with Peer(h.crypto) as peer, h.open("login") as driver:
            h.key(driver)
            initial = f.Grant("terminal-"+name+"-initial", mode="normal")
            rejected = f.Grant("terminal-"+name+"-response", mode="refresh", response=response)
            peer.plan(peer.LOGIN, initial.name, initial)
            peer.plan(peer.REFRESH, initial.response["refresh_token"], rejected)
            password = h.encrypt(driver, initial.password)
            start_auth(f, h, driver, peer, initial, password=password)
            since = len(driver.callbacks)
            renew(f, h, driver, 11)
            terminal(f, h, driver, peer, since, error, server_code)
            driver.idle(6.0, pump=True, peer=peer)
            renew(f, h, driver, 11)
            driver.idle(0.3, pump=True, peer=peer)
            f.require(peer.count(peer.LOGIN) == 1 and peer.count(peer.REFRESH) == 1,
                      "terminal service rejection was converted into a delayed refresh/password replay")
            f.require(len(notices(driver, since, 1, error=error)) == 1,
                      "terminal renewal failure continued to notify/retry")
            peer.check_errors()
    with Peer(h.crypto) as peer, h.open("login") as driver:
        h.key(driver)
        initial = f.Grant("terminal-certificate-initial")
        unexpected = f.Grant("terminal-certificate-must-not-authenticate", mode="refresh")
        peer.plan(peer.QR, initial.code, initial)
        peer.plan(peer.REFRESH, initial.response["refresh_token"], unexpected)
        start_auth(f, h, driver, peer, initial)
        peer.use_wrong_hostname_certificate()
        since = len(driver.callbacks)
        renew(f, h, driver, 11)
        terminal(f, h, driver, peer, since, 10005)
        attempts = peer.handshake_count()
        f.require(attempts > 0 and peer.count(peer.REFRESH) == 0,
                  "certificate-failure scenario did not enforce TLS before sending credentials")
        driver.idle(6.0, pump=True, peer=peer)
        renew(f, h, driver, 11)
        driver.idle(0.3, pump=True, peer=peer)
        f.require(peer.handshake_count() == attempts,
                  "terminal certificate error was converted into five-second refresh retries")
        f.require(len(notices(driver, since, 1, error=10005)) == 1,
                  "certificate failure was repeatedly retried")
        no_new_token(f, driver, since, unexpected.response["crypt_token"])
        peer.check_errors()


def cancel_reconnect(f, h, Peer):
    for action in ("logout", "replace", "reinit"):
        with Peer(h.crypto) as peer, h.open("login") as driver:
            h.key(driver)
            initial = f.Grant("cancel-reconnect-initial-"+action)
            rejected = busy(f, "cancel-reconnect-busy-"+action)
            held = f.Grant("cancel-reconnect-held-"+action, mode="refresh", hold=True)
            replacement = f.Grant("cancel-reconnect-replacement-"+action)
            peer.plan(peer.QR, initial.code, initial)
            peer.plan(peer.REFRESH, initial.response["refresh_token"], rejected, held)
            if action != "logout":
                peer.plan(peer.QR, replacement.code, replacement)
            start_auth(f, h, driver, peer, initial)
            since = len(driver.callbacks)
            refresh_sno = h.sno()
            new_sno = h.sno()
            if action == "reinit":
                # Do not pump the cmd7 acknowledgement until kind-2 HTTP is
                # actually blocked. Re-init then occurs inside that callback.
                driver.call("arm_reinit", trigger_sno=refresh_sno, trigger_rsp=7, after=[
                    f.message(1, h.sno(), {"sso_pub_key": h.crypto.public_key}),
                    h.auth(peer, replacement, new_sno),
                ])
            driver.send(f.message(7, refresh_sno))
            peer.wait_seen(held, timeout=3)
            if action == "logout":
                logout = h.sno()
                driver.send(f.message(5, logout, {"is_token_invalid": True}))
                held.release.set()
                f.require(driver.response(5, logout, peer=peer).get("result") == 0,
                          "logout did not cancel an in-flight reconnect")
                h.offline(driver, since=since)
            elif action == "replace":
                driver.send(h.auth(peer, replacement, new_sno))
                held.release.set()
                f.require(driver.response(4, new_sno, peer=peer).get("result") == 0,
                          "replacement auth did not supersede reconnect")
                h.online(driver, replacement.response["crypt_token"], since=since, peer=peer)
            else:
                driver.pump()
                f.require(any(e.get("event") == "reinit_done" for e in driver.events),
                          "owner callback shutdown/re-init did not return during reconnect")
                held.release.set()
                f.require(driver.response(4, new_sno, peer=peer).get("result") == 0,
                          "new SDK epoch did not authenticate after reconnect cancellation")
                h.online(driver, replacement.response["crypt_token"], since=since, peer=peer)
            driver.idle(0.4, pump=True, peer=peer)
            no_new_token(f, driver, since, held.response["crypt_token"])
            f.require(peer.count(peer.QR, initial.name) == 1,
                      "cancelled reconnect replayed the old authorization code")
            peer.check_errors()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--library-dir", type=Path, required=True)
    parser.add_argument("--json-c-dir", type=Path, required=True)
    parser.add_argument("--source-dir", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--base-fixture", type=Path,
                        default=Path(__file__).resolve().with_name("verify_login_security.py"),
                        help="parent-validated base fixture; imported, never overwritten or run as a suite")
    parser.add_argument("--case", action="append", choices=("all", *CASE_NAMES),
                        help="only new renewal groups; default runs all seven new groups")
    parser.add_argument("--cc", default=os.environ.get("CC", "gcc"))
    parser.add_argument("--openssl", default="openssl")
    parser.add_argument("--timeout", type=float, default=45)
    args = parser.parse_args(argv)
    selected = set(args.case or ["all"])
    old_umask = os.umask(0o077)
    try:
        f = load_fixture(args.base_fixture.resolve(strict=True))
        Peer = peer_type(f)
        cases = {
            "missing-refresh": missing_refresh,
            "consumed-code": consumed_code,
            "caller-refresh-source": caller_refresh_source,
            "immediate-reconnect": immediate_reconnect,
            "reconnect-backoff": reconnect_backoff,
            "terminal-errors": terminal_errors,
            "cancel-reconnect": cancel_reconnect,
        }
        passed = []
        with tempfile.TemporaryDirectory(prefix="welink-renewal-regression-") as temporary:
            h = f.build_harness(args, Path(temporary))
            for name, run in cases.items():
                if "all" not in selected and name not in selected:
                    continue
                run(f, h, Peer)
                passed.append(name)
                print("PASS: renewal/"+name, flush=True)
        print(json.dumps({"new_renewal_groups_passed": passed, "old_suite_rerun": False}), flush=True)
        return 0
    except (Exception, KeyboardInterrupt) as exc:
        # Base fixture errors intentionally contain no raw identity or credentials.
        print("FAIL: renewal/"+type(exc).__name__+": "+str(exc), flush=True)
        return 1
    finally:
        os.umask(old_umask)


if __name__ == "__main__":
    raise SystemExit(main())
