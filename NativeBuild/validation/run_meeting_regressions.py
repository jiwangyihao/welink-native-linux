#!/usr/bin/env python3
"""Run the six offline meeting regressions against an already sealed IMAGE.

Run as root (private mount/network/PID namespaces, then drop to nobody):
  python3 NativeBuild/validation/run_meeting_regressions.py \
    --image "$IMAGE" --evidence "$EVIDENCE"

EVIDENCE must be new or empty. No builds, package downloads, live campus access,
user profiles, real devices, or source-tree production modules are used. The
retained provider WWW, generated speech, NASA fixture, and private PulseAudio
root are test inputs; their defaults can be relocated with the named options.
The caller must verify/seal the image first. This runner does not replace image
signature/integrity verification, nor does it claim live enterprise acceptance.
"""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import signal
import subprocess
import sys
import tempfile
import time


SUITES = {
    "sdk": ("verify_native_capabilities.js", "Offline local SDK policy and original provider consumers; no real meeting or server grants"),
    "native-video-x11": ("meeting_render_surface_verify.js", "Actual native per-stream X11 windows and independent pixel observation of generated MediaStreamTracks"),
    "moderation": ("verify_moderation_capabilities.js", "Isolated authenticated CMS/HRTC, native consent and original web consumers; not enterprise admission"),
    "guest-voice": ("verify_guest_voice.js", "Generated speech, real PNR worker and decoded RTP; no real biometrics or live-room quality claim"),
    "custom-background": ("verify_custom_background.js", "Generated canvas from pinned public-domain NASA fixture, genuine HRTC tracks and decoded recipient video"),
    "participant-report": ("verify_participant_report.js", "Synthetic official-form-shaped loopback HTTPS only; NOT an accepted official participant report"),
}
COMPANIONS = (
    "verify_meeting_management.js", "verify_native_invited_share.js",
    "verify_offline_hrtc_peer.js", "verify_guest_voice_authority.js",
    "meeting_render_surface_probe.py", "meeting_render_surface_verify_preload.js",
)
PERSON_SHA256 = "88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5"
SPEECH_SHA256 = "7f7064e26499bebaa63d9b11df96e121c9d68ccd121e6517a71c59af9bc36f0f"
PROVIDER_SHA256 = {
    "static/js/main.6297930e.js": "3da44cce0fa14f9a225fcfbb15c84e2ffe5940f2a2d30f396cdb12ee08ccdf6d",
    "static/js/404.58f826ce.chunk.js": "4561e476301a2519f991974ca1b25e24d6065f0c4c22c54fe14bc8e9d473d47a",
}

BOOTSTRAP = r"""'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert').strict;
const electron = require('electron'), {app} = electron;
const suite = process.env.WELINK_QA_SUITE;
const scripts = {
  sdk: 'verify_native_capabilities.js',
  'native-video-x11': 'meeting_render_surface_verify.js',
  moderation: 'verify_moderation_capabilities.js',
  'guest-voice': 'verify_guest_voice.js',
  'custom-background': 'verify_custom_background.js',
  'participant-report': 'verify_participant_report.js'
};
assert(scripts[suite], 'Unknown regression suite');
const payload = process.env.WELINK_QA_PAYLOAD, native = path.join(payload, 'native');
assert.equal(process.env.WELINK_TEST_NATIVE, native);
assert.equal(fs.realpathSync(process.execPath), process.env.WELINK_QA_EXECUTABLE);
assert(!app.commandLine.hasSwitch('no-sandbox'), 'The packaged sandbox must stay enabled');
assert(!app.commandLine.hasSwitch('use-fake-ui-for-media-stream'), 'Do not bypass consent');
assert(!app.commandLine.hasSwitch('ignore-certificate-errors'), 'Do not bypass TLS checks');
app.on('quit', () => {
  const modules = Object.keys(require.cache).filter(filename => path.isAbsolute(filename));
  fs.writeFileSync(path.join(process.env.WELINK_QA_OUTPUT, 'loaded-modules.json'),
    JSON.stringify({executable: process.execPath, payload, modules}, null, 2) + '\n', {mode: 0o600});
});
if (suite === 'native-video-x11') {
  // Packaged Electron ignores a script pathname in argv; this is its real main.
  process.argv = [process.execPath, path.join(__dirname, scripts[suite]), payload, ...process.argv.slice(1)];
}
if (suite === 'custom-background') {
  app.setPath('userData', path.join(process.env.HOME, 'background-profile'));
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.on('window-all-closed', () => {});
  const watchdog = setTimeout(() => { console.error('Background acceptance timed out'); app.exit(2); }, 180000);
  app.whenReady().then(() => require('./verify_custom_background')({electron, native,
    personFixture: process.env.WELINK_QA_PERSON})).then(report => {
      fs.writeFileSync(path.join(process.env.WELINK_QA_OUTPUT, 'result.json'), JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
      clearTimeout(watchdog); app.exit(0);
    }, error => { clearTimeout(watchdog); console.error(error.stack || error); app.exit(1); });
} else {
  require('./' + scripts[suite]);
}
"""

DISPLAY_RUNNER = r"""#!/bin/bash
set -euo pipefail
umask 077
for attempt in {1..100}; do
  if xprop -root >/dev/null 2>&1; then break; fi
  sleep .05
done
xprop -root >/dev/null || { echo 'Private X server is not accepting clients' >&2; exit 1; }
openbox >"$WELINK_QA_OUTPUT/openbox.log" 2>&1 &
wm=$!
trap 'kill "$wm" 2>/dev/null || true; wait "$wm" 2>/dev/null || true' EXIT
ready=false
for attempt in {1..100}; do
  kill -0 "$wm"
  if xprop -root _NET_SUPPORTING_WM_CHECK | grep -q 'window id'; then ready=true; break; fi
  sleep .05
done
$ready || { echo 'Openbox did not acquire the private Xvfb display' >&2; exit 1; }
render_flags=()
if [[ $WELINK_QA_SUITE == custom-background ]]; then
  render_flags=(--use-gl=angle --use-angle=swiftshader --disable-dev-shm-usage --disable-gpu-memory-buffer-video-frames)
fi
"$WELINK_QA_EXECUTABLE" \
  "${render_flags[@]}" \
  --app-root="$WELINK_QA_PAYLOAD" --conference-dir="$WELINK_TEST_NATIVE" \
  --web-assets="$WELINK_TEST_WEBASSETS" --allow-synthetic-media \
  --synthetic-speech-wav="$WELINK_QA_SPEECH" --output="$WELINK_QA_OUTPUT/result.json" \
  --disable-features=WebRtcHideLocalIpsWithMdns --allow-loopback-in-peer-connection \
  --disable-background-networking --disable-component-update --ozone-platform=x11
"""

NAMESPACE_RUNNER = r"""#!/bin/bash
set -euo pipefail
umask 077
work=$1 image=$2 www=$3 pulse=$4 output=$5 suite=$6 uid=$7 gid=$8
cd "$work"
readonly_bind() {
  mount --bind "$1" "$2"
  mount -o remount,bind,ro "$2"
}
# Only this new network namespace gets the unrouted documentation-address pair.
ip link set lo up
ip link add qa0 type veth peer name qa1
ip addr add 192.0.2.1/24 dev qa0
ip addr add 192.0.2.2/24 dev qa1
ip link set qa0 up
ip link set qa1 up
[ -z "$(ip -4 route show default)" ] && [ -z "$(ip -6 route show default)" ]
[ "$(ip -o link show | wc -l)" -eq 3 ]
if [[ $suite == custom-background ]]; then
  # Chromium with media access denied can restrict host ICE to its default
  # interface. Both ends of this link are inside this namespace; no gateway,
  # host interface or external uplink is present.
  ip route add default dev qa0 src 192.0.2.1
fi
# No current-native overlay: every production module/worker/library is IMAGE.
# The sealed image root is private (0700); do not change its owner or mode.
# Give this namespace its own traversable root with read-only image children.
mount -t tmpfs -o mode=0755,nodev tmpfs "$work/runtime"
for src in "$image"/*; do
  name=${src##*/}; dst="$work/runtime/$name"
  if [[ $name == chrome-sandbox ]]; then
    install -m 0700 -- "$src" "$dst"
    echo "0e92e9a238217c5b66227b9bb34b216839d0bdb0e7e88fdb5d0ed679cf483aae  $dst" | sha256sum -c --status
    chmod 4755 "$dst"
  elif [[ -L $src ]]; then ln -s -- "$(readlink -- "$src")" "$dst"
  else
    if [[ -d $src ]]; then mkdir -m755 "$dst"; else touch "$dst"; fi
    readonly_bind "$src" "$dst"
  fi
done
mount -o remount,ro,nodev "$work/runtime"
readonly_bind "$image/resources/app" "$work/payload"
readonly_bind "$www" "$work/www"
readonly_bind "$pulse" "$work/pulse"
mount --bind "$output" "$work/evidence"
readonly_bind "$work/testapp" "$work/runtime/resources/app"
# Source trees, user profiles, inherited X sockets, buses and physical media are
# inaccessible after inputs have been bound. All mounts are namespace-private.
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /tmp
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /dev/shm
mount -t tmpfs -o mode=755,nosuid,nodev tmpfs /run
for home in /root /home; do
  if [ -d "$home" ]; then mount -t tmpfs -o mode=700,nosuid,nodev tmpfs "$home"; fi
done
if [ -d /dev/snd ]; then mount -t tmpfs -o mode=000 tmpfs /dev/snd; fi
shopt -s nullglob
for device in /dev/video* /dev/media*; do mount --bind /dev/null "$device"; done
mkdir -m1777 /tmp/.X11-unix
mkdir -m700 /tmp/h /tmp/r /tmp/t
s="$work/evidence/$suite"
mount --bind "$s/home" /tmp/h
mount --bind "$s/runtime" /tmp/r
mount --bind "$s/tmp" /tmp/t
# The socket is private and short enough for sockaddr_un; the null sink is paced.
pa="$work/pulse"
runuser -u nobody -- env -i HOME=/tmp/h USER=nobody LOGNAME=nobody LANG=C.UTF-8 \
  PATH=/usr/bin:/bin XDG_RUNTIME_DIR=/tmp/r TMPDIR=/tmp/t \
  LD_LIBRARY_PATH="$pa/usr/lib/x86_64-linux-gnu:$pa/usr/lib/x86_64-linux-gnu/pulseaudio:$pa/usr/lib/pulse-17.0+dfsg1/modules" \
  "$pa/usr/bin/pulseaudio" -n --daemonize=no --use-pid-file=no --exit-idle-time=-1 --disallow-exit \
  --dl-search-path="$pa/usr/lib/pulse-17.0+dfsg1/modules" \
  --load="module-native-protocol-unix socket=/tmp/r/pulse.sock auth-anonymous=1" \
  --load="module-null-sink sink_name=isolated rate=48000" >"$s/audio.log" 2>&1 &
audio=$!
trap 'kill "$audio" 2>/dev/null || true; wait "$audio" 2>/dev/null || true' EXIT
for attempt in {1..100}; do
  [ -S /tmp/r/pulse.sock ] && break
  kill -0 "$audio"
  sleep .05
done
[ -S /tmp/r/pulse.sock ] || { echo 'Private paced PulseAudio did not start' >&2; exit 1; }
# env -i also removes NODE_PATH, NODE_OPTIONS, preload hooks, proxy settings,
# ELECTRON_RUN_AS_NODE and every inherited desktop/session variable.
runuser -u nobody -- env -i HOME=/tmp/h USER=nobody LOGNAME=nobody LANG=C.UTF-8 \
  PATH=/usr/bin:/bin TMPDIR=/tmp/t XDG_RUNTIME_DIR=/tmp/r \
  XDG_CONFIG_HOME=/tmp/h/config XDG_CACHE_HOME=/tmp/h/cache XDG_DATA_HOME=/tmp/h/data \
  LIBGL_ALWAYS_SOFTWARE=1 \
  PULSE_SERVER=unix:/tmp/r/pulse.sock PULSE_SINK=isolated \
  CHROME_DEVEL_SANDBOX="$work/runtime/chrome-sandbox" \
  LD_LIBRARY_PATH="$work/runtime:$work/payload/native/lib/runtime" \
  WELINK_QA_SUITE="$suite" WELINK_QA_PAYLOAD="$work/payload" \
  WELINK_QA_EXECUTABLE="$work/runtime/electron" WELINK_QA_OUTPUT="$s" \
  WELINK_QA_PERSON="$work/fixtures/astronaut.png" WELINK_QA_SPEECH="$work/fixtures/synthetic.wav" \
  WELINK_TEST_NATIVE="$work/payload/native" WELINK_TEST_WEBASSETS="$work/www" WELINK_TEST_WWW="$work/www" \
  WELINK_TEST_OUTPUT="$s" WELINK_RENDER_TEST_DISPLAY=isolated \
  WELINK_REPORT_QA=isolated WELINK_REPORT_QA_OUTPUT="$s/result.json" \
  timeout -k 5s 300s xvfb-run -a -e "$s/xvfb.log" \
  -s '-screen 0 1280x960x24 -noreset -nolisten tcp +extension Composite' \
  /bin/bash "$work/run-display.sh"
"""


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def pinned(path, expected):
    actual = digest(path)
    if actual != expected:
        raise ValueError(f"Pinned test input hash mismatch: {path}: {actual} != {expected}")
    return actual


def write_json(path, data):
    Path(path).write_text(json.dumps(data, indent=2) + "\n")


def collect_receipt(suite, directory, work):
    if suite == "sdk":
        receipt = directory / "native-capabilities.json"
    elif suite == "native-video-x11":
        candidates = list((directory / "tmp").glob("welink-native-render-proof-*/evidence.json"))
        if len(candidates) != 1:
            raise ValueError(f"Expected one actual native X11 evidence file; found {len(candidates)}")
        receipt = candidates[0]
    else:
        receipt = directory / "result.json"
    data = json.loads(receipt.read_text())
    if suite == "sdk":
        passed = data.get("pass") is True and data.get("supportedTypes") == list(range(14))
    elif suite == "native-video-x11":
        passed = bool(data.get("observations")) and data.get("scope") == "isolated generated MediaStreamTracks; no production meeting"
    elif suite == "guest-voice":
        passed = data.get("result") == "passed" and data.get("realDevices") is False and data.get("realAccounts") is False
    elif suite == "custom-background":
        passed = (data.get("recipientFramesDecoded", 0) > 20 and data.get("permissionRequests") == 0
                  and data.get("externalRequests") == 0 and data.get("providerAuthorizationTested") is False)
    else:
        passed = data.get("ok") is True
    if not passed:
        raise ValueError(f"Verifier did not produce its successful receipt: {receipt}")
    if suite == "participant-report" and data.get("scope") != "private loopback TLS, synthetic identities; no official reports":
        raise ValueError("Participant report must retain its synthetic-only scope")
    # The real packaged main records loaded CJS modules before exit. In addition
    # to hiding the source tree, reject any accidental non-image production load.
    loaded = json.loads((directory / "loaded-modules.json").read_text())
    prefixes = (str(work / "payload") + "/", str(work / "runtime/resources/app") + "/")
    outside = [name for name in loaded["modules"] if not name.startswith(prefixes)]
    if outside:
        raise ValueError(f"Modules outside sealed payload or staged testapp: {outside}")
    if receipt != directory / "result.json":
        shutil.copyfile(receipt, directory / "result.json")
    return str(directory / "result.json")


def run_suite(command, log):
    # Killing the namespace init also retires its Xvfb, workers and PulseAudio.
    with log.open("wb") as stream:
        child = subprocess.Popen(command, stdout=stream, stderr=subprocess.STDOUT,
                                 env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"},
                                 cwd="/var/tmp", start_new_session=True)
        try:
            return child.wait(timeout=330)
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--image", required=True, type=Path)
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--source-root", type=Path, default=Path(__file__).resolve().parents[2],
                        help="Verifier scripts only; no production modules are copied from here")
    parser.add_argument("--web-assets", type=Path, default=Path("/tmp/hit-vendor-reference-9d0atqa7/www"))
    parser.add_argument("--pulse-root", type=Path, default=Path("/var/tmp/wl-clocked-audio-ihf72kzd/sys"))
    parser.add_argument("--person-fixture", type=Path, default=Path("/tmp/welink-custom-background-qa/astronaut.png"))
    parser.add_argument("--speech-fixture", type=Path, default=Path("/var/tmp/wl-guest-voice-INEgQ4/synthetic.wav"))
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("Run as root: isolated mount/network/PID namespaces are mandatory; suites run as nobody")
    os.umask(0o077)
    image = args.image.resolve(strict=True)
    source = args.source_root.resolve(strict=True) / "Conference"
    www = args.web_assets.resolve(strict=True)
    pulse = args.pulse_root.resolve(strict=True)
    evidence = args.evidence.resolve()
    if evidence == image or image in evidence.parents or evidence == source or source in evidence.parents:
        parser.error("Evidence must be outside the sealed image and Conference source directory")
    if evidence.exists() and (not evidence.is_dir() or any(evidence.iterdir())):
        parser.error("Evidence directory must be new or empty (stale results must never count as success)")
    tools = ("unshare", "mount", "ip", "runuser", "timeout", "xvfb-run", "Xvfb", "xauth", "openbox", "xdotool", "xprop", "openssl", "python3")
    missing = [tool for tool in tools if not shutil.which(tool)]
    if missing:
        parser.error("Missing offline host dependencies (nothing is downloaded): " + ", ".join(missing))
    tests = sorted({item[0] for item in SUITES.values()} | set(COMPANIONS))
    required = [source / name for name in tests] + [
        image / "electron", image / "chrome-sandbox", image / "resources/app/package.json",
        image / "resources/app/native/build.json", image / "resources/app/native/distribution-sha256.json",
        image / "resources/app/native/meeting_custom_background_host.js",
        image / "resources/app/native/lib/welink-voice-worker",
        image / "resources/app/native/lib/welink-render-surface-worker",
        pulse / "usr/bin/pulseaudio", pulse / "usr/lib/pulse-17.0+dfsg1/modules/module-null-sink.so",
        pulse / "usr/lib/pulse-17.0+dfsg1/modules/module-native-protocol-unix.so", www / "index.html",
    ]
    for path in required:
        if not path.is_file():
            parser.error(f"Required retained input or image artifact is absent: {path}")
    if (image / "resources/app.asar").exists():
        parser.error("This runner requires the observed unpacked resources/app layout, not app.asar")
    person_hash = pinned(args.person_fixture, PERSON_SHA256)
    speech_hash = pinned(args.speech_fixture, SPEECH_SHA256)
    provider_hashes = {name: pinned(www / name, value) for name, value in PROVIDER_SHA256.items()}
    nobody = pwd.getpwnam("nobody")
    evidence.mkdir(mode=0o700, parents=True, exist_ok=True)
    evidence.chmod(0o700)
    os.chown(evidence, nobody.pw_uid, nobody.pw_gid)
    summary = {
        "image": str(image), "started": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "scope": "Six offline sealed-image meeting regressions; no client cutover or live enterprise acceptance",
        "officialParticipantReportAccepted": False,
        "participantReportBoundary": "A successful suite proves only local confirmation, loopback synthetic HTTP success/refusal and owner retirement. Actual authenticated roster selection and official service acceptance remain untested; no official request is sent.",
        "suites": {}, "passed": False,
    }
    manifest = {
        "image": str(image), "productionOrigin": "Read-only IMAGE/resources/app; no source overlay",
        "imageArtifacts": {str(path.relative_to(image)): digest(path) for path in required if image in path.parents},
        "providerFixture": {"path": str(www), "sha256": provider_hashes},
        "speechFixture": {"path": str(args.speech_fixture), "sha256": speech_hash, "provenance": "Retained locally generated ffmpeg/flite synthetic speech from guest-voice acceptance"},
        "personFixture": {"path": str(args.person_fixture), "sha256": person_hash, "provenance": "NASA / Eileen Collins, public domain; generated canvas frames, not a real camera"},
        "pulseRoot": str(pulse), "pulseExecutableSha256": digest(pulse / "usr/bin/pulseaudio"),
        "runnerSha256": digest(__file__),
    }
    write_json(evidence / "summary.json", summary)
    with tempfile.TemporaryDirectory(prefix="welink-meeting-qa-", dir="/var/tmp") as temporary:
        work = Path(temporary)
        work.chmod(0o711)
        for name in ("runtime", "payload", "www", "pulse", "evidence", "testapp", "fixtures"):
            (work / name).mkdir(mode=0o755)
        # umask 077 protects writable state; only immutable test inputs are public.
        for name in ("testapp", "fixtures"):
            (work / name).chmod(0o755)
        for name in tests:
            target = work / "testapp" / name
            shutil.copyfile(source / name, target)
            target.chmod(0o644)
        (work / "testapp/meeting_custom_background_host.js").symlink_to(work / "payload/native/meeting_custom_background_host.js")
        (work / "testapp/main.js").write_text(BOOTSTRAP)
        (work / "testapp/main.js").chmod(0o644)
        write_json(work / "testapp/package.json", {"name": "sealed-meeting-regressions", "version": "1.0.0", "main": "main.js"})
        (work / "testapp/package.json").chmod(0o644)
        for original, name in ((args.person_fixture, "astronaut.png"), (args.speech_fixture, "synthetic.wav")):
            shutil.copyfile(original, work / "fixtures" / name)
            (work / "fixtures" / name).chmod(0o444)
        (work / "run-namespace.sh").write_text(NAMESPACE_RUNNER)
        (work / "run-display.sh").write_text(DISPLAY_RUNNER)
        (work / "run-display.sh").chmod(0o644)
        manifest["verifierSha256"] = {name: digest(work / "testapp" / name) for name in tests}
        write_json(evidence / "inputs.json", manifest)
        for suite, (_, scope) in SUITES.items():
            directory = evidence / suite
            directory.mkdir(mode=0o700)
            os.chown(directory, nobody.pw_uid, nobody.pw_gid)
            for name in ("home", "runtime", "tmp"):
                (directory / name).mkdir(mode=0o700)
                os.chown(directory / name, nobody.pw_uid, nobody.pw_gid)
            log = directory / "suite.log"
            command = ["unshare", "--mount", "--net", "--pid", "--fork", "--mount-proc", "--propagation", "private",
                       "/bin/bash", str(work / "run-namespace.sh"), str(work), str(image), str(www), str(pulse), str(evidence),
                       suite, str(nobody.pw_uid), str(nobody.pw_gid)]
            result = {"scope": scope, "log": str(log), "passed": False}
            start = time.monotonic()
            print(f"RUN {suite}: {log}", flush=True)
            try:
                result["exitCode"] = run_suite(command, log)
                if result["exitCode"] != 0:
                    raise ValueError(f"Suite process exited {result['exitCode']}; see {log}")
                result["receipt"] = collect_receipt(suite, directory, work)
                result["passed"] = True
            except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
                result["error"] = str(error)
                with log.open("a") as stream:
                    stream.write(f"\nRUNNER_FAILURE: {error}\n")
            result["elapsedSeconds"] = round(time.monotonic() - start, 3)
            summary["suites"][suite] = result
            write_json(evidence / "summary.json", summary)
            print(f"{'PASS' if result['passed'] else 'FAIL'} {suite}", flush=True)
    summary["passed"] = len(summary["suites"]) == len(SUITES) and all(result["passed"] for result in summary["suites"].values())
    summary["finished"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    write_json(evidence / "summary.json", summary)
    print(f"Summary: {evidence / 'summary.json'}", flush=True)
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print(f"SETUP_FAILURE: {error}", file=sys.stderr)
        sys.exit(2)
