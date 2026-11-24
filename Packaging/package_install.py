#!/usr/bin/env python3
"""Per-user first installation from a packaged, precompiled, hash-locked image recipe."""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import seed
sys.path.insert(0, str(ROOT / "tools"))
from acquire_image_inputs import add_input_arguments, prepare_image_inputs

APM_PACKAGE = "cn.edu.hit.welink.native.apm"
CONSENT = ("此非官方原生版需要从 HIT／华为固定上游下载原版资源（约 307 MB），仅解包，不运行 Windows 安装程序。"
           "商业素材不包含在此软件包中。请确认你有权按上游条款获取、使用这些资源。"
           "安装将在用户目录重建镜像，不导入 Wine 账号，不改变已有默认关联。是否继续？")


def status(message):
    print(message, flush=True)


def context():
    if os.geteuid() == 0:
        raise RuntimeError("请以桌面用户运行；不要使用 sudo 启动应用或整个安装器。")
    home = Path.home().absolute()
    if home.resolve() != home or home.stat().st_uid != os.getuid():
        raise RuntimeError("HOME 必须是当前用户拥有的真实目录。")
    apm = os.environ.get("WELINK_NATIVE_APM_PACKAGE", "")
    if apm and (apm != APM_PACKAGE or os.environ.get("IS_ACE_ENV") != "1" or os.environ.get("APM_PKG_NAME") != apm):
        raise RuntimeError("APM 安装必须通过真实 APM 启动器进入指定容器。")
    install = home / (".local/opt/hit-welink-native-apm" if apm else ".local/opt")
    profile = Path(os.environ.get("WELINK_NATIVE_PROFILE_DIR", str(home / (
        ".local/share/hit-welink-native-apm/profile" if apm else ".local/share/hit-welink-native/profile"))))
    if not profile.is_absolute() or profile.resolve() != profile:
        raise RuntimeError("资料目录必须是绝对、规范路径。")
    launcher = home / (".local/bin/hit-welink-native-apm" if apm else ".local/bin/hit-welink-native")
    return home, install, profile, launcher, apm


def installed_image(launcher, install):
    if not launcher.is_file() or launcher.is_symlink():
        return None
    text = launcher.read_text()
    if "# HIT native desktop integration" not in text:
        raise RuntimeError("已有同名启动器不属于本项目，拒绝覆盖。")
    entries = [shlex.split(line[6:]) for line in text.splitlines() if line.startswith("image=")]
    if len(entries) != 1 or len(entries[0]) != 1:
        raise RuntimeError("无法识别已有原生启动器。")
    image = Path(entries[0][0])
    if image.resolve() != image or image.parent.parent != install:
        raise RuntimeError("已有启动器指向不同安装根目录，拒绝自动迁移。")
    value = json.loads((image / "resources/app/native/build.json").read_text())
    match = seed.VERSION.fullmatch(value.get("build", ""))
    if not match or not (image / "electron").is_file():
        raise RuntimeError("已有原生镜像不完整。")
    return image, int(match.group(1).split(".")[1])


def protected_sandbox(source, directory, expected, namespace_sandbox):
    if seed.digest(source) != expected:
        raise RuntimeError("软件包沙箱散列不匹配。")
    if namespace_sandbox:
        shutil.copyfile(source, directory / "chrome-sandbox")
        (directory / "chrome-sandbox").chmod(0o755)
        return
    helper = ROOT / "sandbox_helper.py"
    for path, mode in ((source, 0o4755), (helper, 0o755)):
        info = path.stat()
        if path.is_symlink() or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != mode:
            raise RuntimeError("请先通过系统包管理器安装 .deb；受保护的沙箱或授权辅助程序缺失。")
    src = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    dst = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        command = ["/usr/bin/python3", "-I", str(helper), "--parent-pid", str(os.getpid()),
                   "--source-fd", str(src), "--directory-fd", str(dst), "--sha256", expected]
        status("授权仅用于从系统软件包复制已验证的沙箱；应用和安装器仍以普通用户运行")
        if shutil.which("sudo") and subprocess.run(["sudo", "-n", "--", *command],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            return
        if os.environ.get("DISPLAY") and shutil.which("pkexec"):
            subprocess.run(["pkexec", *command], check=True)
        elif sys.stdin.isatty() and shutil.which("sudo"):
            subprocess.run(["sudo", "--", *command], check=True)
        else:
            raise RuntimeError("沙箱需要一次系统授权；请在图形会话或交互终端中运行安装。")
    finally:
        os.close(src)
        os.close(dst)


def supervisor_module(image):
    spec = importlib.util.spec_from_file_location("welink_package_supervisor", image / "resources/app/native/update_supervisor.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def activate(home, profile, launcher, image, apm, previous):
    supervisor = supervisor_module(image)
    gate = supervisor.open_profile_gate(profile)
    try:
        try:
            fcntl.flock(gate, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("当前 WeLink 或资料操作仍在运行；请正常退出后重新打开安装入口，或使用客户端内置更新。") from error
        if supervisor.profile_processes(profile):
            raise RuntimeError("当前 WeLink 仍在运行；未改动会话，请正常退出后重试。")
        command = [sys.executable, "-I", str(ROOT / "tools/install_desktop.py"), "--image", str(image),
                   "--home", str(home), "--profile", str(profile), "--preserve-defaults"]
        if apm:
            command += ["--apm-package", apm]
        if previous:
            command += ["--previous-image", str(previous[0])]
        plan = json.loads(subprocess.check_output([*command, "--plan"], text=True))
        before = {item["path"]: supervisor.snapshot(Path(item["path"])) for item in plan}
        if profile.exists():
            if not profile.is_dir() or profile.stat().st_uid != os.getuid() or profile.stat().st_mode & 0o077:
                raise RuntimeError("已有资料目录不是私有的原生资料目录。")
            if (profile / ".welink-native-profile").read_text().strip() != "welink-native-profile-v1":
                raise RuntimeError("拒绝导入非原生资料。")
            backup_root = profile.parent / "package-backups"
            backup_root.mkdir(mode=0o700, exist_ok=True)
            supervisor.private(backup_root)
            backup = Path(tempfile.mkdtemp(prefix="before-" + image.parent.name + "-", dir=backup_root))
            status("旧实例已退出；备份原生资料与桌面入口")
            shutil.copytree(profile, backup / "profile", symlinks=True)
            (backup / "integration.json").write_text(json.dumps(before, sort_keys=True) + "\n")
        try:
            subprocess.run(command, check=True)
        except BaseException:
            for item in reversed(plan):
                wanted = {key: item[key] for key in ("data", "mode", "sha256")}
                if supervisor.snapshot(Path(item["path"])) == wanted:
                    supervisor.restore_file(Path(item["path"]), before[item["path"]], wanted)
            raise
        if not launcher.is_file():
            raise RuntimeError("未生成实际桌面启动器。")
    finally:
        os.close(gate)


def setup(args):
    home, install, profile, launcher, apm = context()
    manifest = seed.load(ROOT)
    previous = installed_image(launcher, install)
    target_version = int(manifest["version"].split(".")[1])
    if previous and previous[1] >= target_version:
        status("保留当前或更新的原生镜像，不降级、不覆盖资料")
        return launcher
    install.mkdir(parents=True, mode=0o700, exist_ok=True)
    if install.resolve() != install or install.stat().st_uid != os.getuid():
        raise RuntimeError("安装根目录必须由当前用户拥有且不能经过符号链接。")
    lock = os.open(install / ".native-image-install.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        destination = install / ("hit-welink-native-" + manifest["version"])
        if destination.is_symlink():
            raise RuntimeError("拒绝链接形式的安装目标。")
        image = destination / "image"
        if destination.exists():
            status("复核此前完整准备的镜像")
            seed.verify(image, manifest, bool(apm))
        else:
            if not args.accept_vendor_terms:
                raise RuntimeError("首次安装必须确认上游使用授权；运行 --accept-vendor-terms 或从桌面菜单确认。")
            stage = Path(tempfile.mkdtemp(prefix=".package-" + manifest["version"] + "-", dir=install))
            try:
                args.output = stage / "inputs"
                args.cache = args.cache or home / (".cache/hit-welink-native-apm/archives" if apm else ".cache/hit-welink-native/archives")
                status("获取并校验固定上游输入；不执行原版 Windows 安装程序")
                inputs = prepare_image_inputs(args)
                seed.materialize(ROOT, inputs, stage / "image", manifest,
                    lambda source, directory, expected: protected_sandbox(source, directory, expected, bool(apm)),
                    status, namespace_sandbox=bool(apm))
                shutil.rmtree(inputs)
                subprocess.run(["mv", "-T", "--no-clobber", "--", str(stage), str(destination)], check=True)
                if stage.exists():
                    raise RuntimeError("安装目标被其他进程创建，未覆盖。")
            finally:
                if stage.exists():
                    shutil.rmtree(stage)
        activate(home, profile, launcher, image, apm, previous)
        status("原生镜像与桌面入口安装完成；默认关联和账号资料保留")
        return launcher
    finally:
        os.close(lock)


def gui_setup(args):
    home, install, profile, launcher, apm = context()
    manifest = seed.load(ROOT)
    previous = installed_image(launcher, install)
    if previous and previous[1] >= int(manifest["version"].split(".")[1]):
        return launcher
    image = install / ("hit-welink-native-" + manifest["version"]) / "image"
    if not image.exists() and not args.accept_vendor_terms:
        if subprocess.run(["zenity", "--question", "--title=WeLink Native 首次安装", "--width=520", "--text=" + CONSENT]).returncode:
            raise InterruptedError("用户取消安装，未修改原有安装或资料。")
    arguments = [sys.executable, "-I", str(Path(__file__).resolve()), "--no-gui", "--no-launch", "--accept-vendor-terms"]
    for name in ("cache", "vendor_installer", "hrtc_bundle", "background_archive", "background_license"):
        value = getattr(args, name)
        if value is not None:
            arguments += ["--" + name.replace("_", "-"), str(value)]
    log_root = home / (".cache/hit-welink-native-apm" if apm else ".cache/hit-welink-native")
    log_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (log_root / "package-install.log").open("wb") as log:
        worker = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=log, start_new_session=True)
        dialog = subprocess.Popen(["zenity", "--progress", "--pulsate", "--auto-close", "--width=520",
            "--title=WeLink Native 安装", "--text=准备经过校验的原生镜像"], stdin=subprocess.PIPE)
        handles = [os.pidfd_open(worker.pid), os.pidfd_open(dialog.pid)]
        watcher = selectors.DefaultSelector()
        watcher.register(handles[0], selectors.EVENT_READ, "worker")
        watcher.register(handles[1], selectors.EVENT_READ, "dialog")
        watcher.register(worker.stdout, selectors.EVENT_READ, "output")
        finished = False
        try:
            while not finished:
                for key, _ in watcher.select():
                    if key.data == "worker":
                        finished = True
                        break
                    if key.data == "dialog":
                        raise InterruptedError("用户取消安装，原有版本与资料保持不变。")
                    data = os.read(worker.stdout.fileno(), 4096)
                    if data:
                        for line in data.decode("utf-8", errors="replace").splitlines():
                            dialog.stdin.write(("# " + line + "\n").encode())
                        dialog.stdin.flush()
                    else:
                        watcher.unregister(worker.stdout)
            result = worker.wait()
            if result:
                raise RuntimeError("安装未完成。详情见 " + str(log_root / "package-install.log"))
            dialog.stdin.write(b"100\n")
            dialog.stdin.close()
            dialog.wait()
        finally:
            if worker.poll() is None:
                os.killpg(worker.pid, signal.SIGTERM)
                worker.wait()
            if dialog.poll() is None:
                dialog.terminate()
                dialog.wait()
            worker.stdout.close()
            watcher.close()
            for fd in handles:
                os.close(fd)
    return launcher


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    add_input_arguments(parser)
    parser.add_argument("--cache", type=Path, help="hash-checked upstream archive cache")
    parser.add_argument("--no-launch", action="store_true", help="prepare and activate without opening the application")
    parser.add_argument("--no-gui", action="store_true", help="use terminal output and explicit upstream consent")
    parser.add_argument("application_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    def canceled(_signum, _frame):
        raise InterruptedError("安装已取消。")
    signal.signal(signal.SIGTERM, canceled)
    graphical = not args.no_gui and bool(os.environ.get("DISPLAY")) and shutil.which("zenity")
    try:
        launcher = gui_setup(args) if graphical else setup(args)
        if not args.no_launch:
            forwarded = args.application_args
            if forwarded and forwarded[0] == "--":
                forwarded = forwarded[1:]
            os.execv(str(launcher), [str(launcher), *forwarded])
        return 0
    except (InterruptedError, KeyboardInterrupt) as error:
        print(str(error), file=sys.stderr)
        return 130
    except Exception as error:
        print(f"WeLink Native 安装失败：{error}", file=sys.stderr)
        if graphical:
            subprocess.run(["zenity", "--error", "--width=520", "--title=WeLink Native 安装失败", "--text=" + str(error)], check=False)
        return 1


if __name__ == "__main__":
    sys.exit(main())
