#!/usr/bin/python3 -I
"""Copy one existing trusted SUID sandbox through held FDs; never run an installer as root."""
import argparse
import hashlib
import os
import re
import stat


def copy_sandbox(parent_pid, source_fd, directory_fd, expected):
    if os.geteuid() != 0 or not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("Invalid sandbox authorization")
    uid = int(os.environ.get("PKEXEC_UID", os.environ.get("SUDO_UID", "-1")))
    if uid <= 0 or min(parent_pid, source_fd, directory_fd) <= 0 or os.stat(f"/proc/{parent_pid}").st_uid != uid:
        raise ValueError("Invalid sandbox requester")
    source = os.open(f"/proc/{parent_pid}/fd/{source_fd}", os.O_RDONLY)
    directory = os.open(f"/proc/{parent_pid}/fd/{directory_fd}", os.O_RDONLY | os.O_DIRECTORY)
    target = None
    try:
        info = os.fstat(source)
        destination = os.fstat(directory)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o4755:
            raise ValueError("Source is not an existing protected sandbox")
        if not 0 < info.st_size <= 1024 * 1024:
            raise ValueError("Unexpected sandbox size")
        if destination.st_uid != uid or stat.S_IMODE(destination.st_mode) != 0o700:
            raise ValueError("Destination must be a private user-owned staging directory")
        with os.fdopen(os.dup(source), "rb") as stream:
            data = stream.read(1024 * 1024 + 1)
        if len(data) != info.st_size or hashlib.sha256(data).hexdigest() != expected:
            raise ValueError("Protected sandbox bytes changed")
        target = os.open("chrome-sandbox", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o700, dir_fd=directory)
        with os.fdopen(os.dup(target), "wb") as stream:
            stream.write(data)
            stream.flush()
        os.fchown(target, 0, 0)
        os.fchmod(target, 0o4755)
        os.fsync(target)
        os.fsync(directory)
    finally:
        if target is not None:
            os.close(target)
        os.close(directory)
        os.close(source)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parent-pid", type=int, required=True)
    parser.add_argument("--source-fd", type=int, required=True)
    parser.add_argument("--directory-fd", type=int, required=True)
    parser.add_argument("--sha256", required=True)
    args = parser.parse_args()
    copy_sandbox(args.parent_pid, args.source_fd, args.directory_fd, args.sha256)


if __name__ == "__main__":
    main()
