#!/usr/bin/env python3
"""Offline numeric oracle for FIRST CONVOLUTION ONLY; not a deployed provider.

Run from the source root on Linux x86-64 with IA32 execution enabled:
    python3 Conference/meeting_voice_cluster_backbone_oracle.py --sdk-root /path/to/the/pinned/HwmSdk
The SDK must be lawfully obtained and supplied explicitly; it is not distributed here.
Requires Python 3, cc, GNU as/ld and a CPU with AVX2/FMA for the reference only.

The runner builds the independent C stage and a freestanding 32-bit Linux ELF.
The latter contains only the listed, hash-authenticated original math routines,
initializer, binder, float-copy/fill helpers and stack-cookie check. Original
instructions are not patched. The original dispatch setter selects the desktop
kernel (0). Neither Windows startup nor imports are needed. An unexpected call
outside the listed numerical routines fails the reference process.
Only bounded original math runs; the PE entry point/DllMain never runs. No
original executable bytes enter the native C stage or a production artifact.

Each synthetic 100x80 block is mean-zero per frequency and is compared over all
64000 outputs, bit for bit. The first-layer wrapper, not a Python recreation of
its padding or transpose, supplies the reference. Output layout is [50][40][32].
A successful run proves only this layer for desktop dispatch; it does not prove
the complete 256-value encoder, enrollment or voice shielding.
All generated executables/input copies are confined to an auto-removed temp dir.
"""

import argparse
import ctypes
import hashlib
from pathlib import Path
import platform
import struct
import subprocess
import sys
import tempfile


PE_SHA256 = "bea0ed34f106dca1ae9131d43ffc62bff498e90d59a13d1058c6bd7c549450c9"
MODEL_SHA256 = "41b53dec9271a94640313157db73bcab65e49bb07dd8e1bd9e85535cedcb500a"
MODEL_BYTES = 2896332
INPUT_FLOATS = 8000
OUTPUT_FLOATS = 64000

# Original function ranges, end-exclusive, in the authenticated .text section.
# All other bytes in .orig are INT3 traps, not replacement implementations.
TEXT_RANGES = (
    (0x10203C10, 0x10203C78),  # original numeric dispatch getter/setter
    (0x10206B00, 0x10206BD5),  # float-copy dispatcher
    (0x10207040, 0x10207056),  # float fill
    (0x10207090, 0x102070BB),  # byte fill
    (0x10249A40, 0x10249D85),  # complete streaming first-layer wrapper
    (0x1024AA30, 0x1024ACCA),  # original state initializer
    (0x1024B730, 0x1024B79F),  # ReLU6 dispatcher
    (0x1024B7A0, 0x1024B86B),  # 8000-float input import/reset
    (0x1024B910, 0x1024BB07),  # original model binder
    (0x1024C3F0, 0x1024C473),  # original first-convolution descriptor
    (0x1024D930, 0x1024D971),  # desktop float copy
    (0x102ABC60, 0x102ABCF9),  # desktop ReLU6
    (0x102ADA20, 0x102ADBE9),  # convolution: patches, bias, GEMM
    (0x102AE0E0, 0x102AE32E),  # GEMM dispatcher
    (0x102AF070, 0x102AF301),  # original 3x3 im2col
    (0x102D51E0, 0x102D59BE),  # desktop dot product with scalar remainder
)
EXTRA_SECTIONS = (
    (".cookie", "ax", 0x1079B1EF, 0x11, 0x10000A00),
    (".clip_float", "a", 0x10A514D0, 4, 0x10001E00),
    (".clip_double", "a", 0x10A5D2F8, 8, 0x10001E00),
    (".modelinfo", "a", 0x10A6AD88, 288, 0x10001E00),
    (".clip_vector", "a", 0x10A87AC0, 32, 0x10001E00),
    (".dispatch", "aw", 0x10CB2BC8, 2, 0x10001E00),
    (".guard", "a", 0x10CC1BA4, 4, 0x10001E00),
)

DRIVER_ASM = r"""
.section .text
.globl _start
_start:
    cld
    ldmxcsr mxcsr
    mov $features, %ecx
    mov $32000, %edx
read_block:
    mov $3, %eax
    xor %ebx, %ebx
    int $0x80
    test %eax, %eax
    jle failed
    add %eax, %ecx
    sub %eax, %edx
    jne read_block
    mov $3, %eax
    xor %ebx, %ebx
    mov $extra_byte, %ecx
    mov $1, %edx
    int $0x80
    test %eax, %eax
    jne failed

    pushl $0
    call 0x10203c10
    add $4, %esp
    test %eax, %eax
    jne failed
    pushl $engine
    call 0x1024aa30
    add $4, %esp
    test %eax, %eax
    jne failed
    pushl $model+4
    pushl $engine
    call 0x1024b910
    add $8, %esp
    test %eax, %eax
    jne failed
    pushl $features
    pushl $engine
    call 0x1024b7a0
    add $8, %esp
    test %eax, %eax
    jne failed

    mov $engine+0x148, %esi
    mov $result, %edi
    mov $100, %ebx
next_frame:
    push %edi
    mov $engine+8, %edi
    mov $80, %ecx
    rep movsl
    pop %edi
    incl engine
    pushl $first_args
    pushl $engine
    call 0x10249a40
    add $8, %esp
    cmpl $0, engine+4
    je no_output
    cmpl $1, engine+4
    jne failed
    cmp $result+256000, %edi
    jae failed
    push %esi
    mov $scratch, %esi
    mov $1280, %ecx
    rep movsl
    pop %esi
no_output:
    dec %ebx
    jne next_frame
    cmpl $50, engine+0x83a4
    jne failed
    cmp $result+256000, %edi
    jne failed

    mov $result, %ecx
    mov $256000, %edx
write_result:
    mov $4, %eax
    mov $1, %ebx
    int $0x80
    test %eax, %eax
    jle failed
    add %eax, %ecx
    sub %eax, %edx
    jne write_result
    xor %ebx, %ebx
    jmp exit_process
failed:
    mov $1, %ebx
exit_process:
    mov $1, %eax
    int $0x80

.section .rodata
.p2align 4
mxcsr: .long 0x1f80
first_args: .long engine+8, scratch, scratch+0x5000, scratch+0x5400
.p2align 4
model: .incbin "model.bin"
.section .bss
.p2align 4
engine: .skip 0x10c500
scratch: .skip 0x6800
features: .skip 32000
result: .skip 256000
extra_byte: .skip 1
.section .note.GNU-stack,"",@progbits
"""


def authenticated(path, digest):
    data = path.read_bytes()
    actual = hashlib.sha256(data).hexdigest()
    if actual != digest:
        raise SystemExit(f"Rejected unpinned artifact {path}: SHA-256 {actual}")
    return data


def oracle_assembly():
    pieces = [DRIVER_ASM, '.section .orig,"ax",@progbits\n']
    for start, end in TEXT_RANGES:
        pieces.append(
            f'.org {start - 0x10200000}, 0xcc\n'
            f'.incbin "pe.bin", {start - 0x10000A00}, {end - start}\n'
        )
    for name, flags, address, size, delta in EXTRA_SECTIONS:
        pieces.append(
            f'.section {name},"{flags}",@progbits\n'
            f'.incbin "pe.bin", {address - delta}, {size}\n'
        )
    return "".join(pieces)


def synthetic_blocks():
    yield "zero", [0.0] * INPUT_FLOATS
    yield "alternating", [
        (1 if t % 2 == 0 else -1) * ((f % 13) - 6) / 8
        for t in range(100) for f in range(80)
    ]
    yield "centered-ramp", [
        (2*t - 99) * (2*f - 79) / 4096
        for t in range(100) for f in range(80)
    ]
    for divisor in (256, 16):
        x = [0.0] * INPUT_FLOATS
        state = 0x9E3779B9
        for t in range(50):
            for f in range(80):
                state ^= (state << 13) & 0xFFFFFFFF
                state ^= state >> 17
                state ^= (state << 5) & 0xFFFFFFFF
                value = ((state & 2047) - 1024) / divisor
                x[t*80 + f] = value
                x[(99-t)*80 + f] = -value
        yield f"paired-xorshift-div{divisor}", x
    for t, f in ((0, 0), (1, 1), (98, 78), (99, 79)):
        x = [0.0] * INPUT_FLOATS
        x[t*80 + f] = 4.0
        x[(99-t)*80 + f] = -4.0
        yield f"paired-impulse-{t}-{f}", x


def compare(native, model, oracle):
    model_buffer = ctypes.create_string_buffer(model)
    input_type = ctypes.c_float * INPUT_FLOATS
    output_type = ctypes.c_float * OUTPUT_FLOATS
    call = native.welink_pnr_cluster_first_conv_v2
    call.argtypes = [ctypes.c_void_p, ctypes.c_size_t,
                     ctypes.POINTER(ctypes.c_float), ctypes.POINTER(ctypes.c_float)]
    call.restype = ctypes.c_int
    case_count = 0
    aggregate = hashlib.sha256()
    for name, values in synthetic_blocks():
        feature_bytes = struct.pack(f"<{INPUT_FLOATS}f", *values)
        reference = subprocess.run(
            [str(oracle)], input=feature_bytes, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, check=True, timeout=30
        ).stdout
        if len(reference) != OUTPUT_FLOATS * 4:
            raise SystemExit(f"{name}: oracle returned {len(reference)} bytes")
        features = input_type(*values)
        output = output_type()
        status = call(model_buffer, len(model), features, output)
        if status != 0:
            raise SystemExit(f"{name}: native stage returned {status}")
        actual = bytes(output)
        if actual != reference:
            expected_values = struct.unpack(f"<{OUTPUT_FLOATS}f", reference)
            mismatches = [i for i in range(OUTPUT_FLOATS)
                          if actual[4*i:4*i+4] != reference[4*i:4*i+4]]
            index = mismatches[0]
            maximum = max(abs(output[i] - expected_values[i])
                          for i in mismatches)
            t, remainder = divmod(index, 40*32)
            f, c = divmod(remainder, 32)
            raise SystemExit(
                f"{name}: {len(mismatches)} bit mismatches; max_abs={maximum}; "
                f"first [t={t},f={f},c={c}] native={output[index]!r} "
                f"original={expected_values[index]!r}; "
                f"bits native={actual[4*index:4*index+4].hex()} "
                f"original={reference[4*index:4*index+4].hex()}"
            )
        aggregate.update(reference)
        case_count += 1
        print(f"{name}: {OUTPUT_FLOATS} float32 values bitwise equal")
    print(f"PASS: {case_count} cases, {case_count*OUTPUT_FLOATS} outputs; "
          "max_abs_error=0, desktop original dispatch=0")
    print(f"Concatenated reference-output SHA-256: {aggregate.hexdigest()}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk-root", type=Path, required=True,
                        help="lawfully obtained pinned HwmSdk directory containing mmr_media.dll and mmrModel")
    args = parser.parse_args()
    if (sys.platform != "linux" or sys.byteorder != "little" or
            platform.machine() not in ("x86_64", "i386", "i686")):
        raise SystemExit("This precise offline oracle requires Linux x86/IA32 execution")
    flags = next((line.partition(":")[2].split() for line in Path("/proc/cpuinfo").read_text().splitlines()
                  if line.partition(":")[0].strip() == "flags"), [])
    if not {"avx2", "fma"}.issubset(flags):
        raise SystemExit("The pinned desktop reference requires AVX2 and FMA; the native C code does not")
    pe = authenticated(args.sdk_root / "mmr_media.dll", PE_SHA256)
    model = authenticated(args.sdk_root / "mmrModel/pnrClusterModel.bin", MODEL_SHA256)
    if len(model) != MODEL_BYTES or model[:4] != b"\0\0\0\2":
        raise SystemExit("Pinned model has an unexpected layout")
    source = Path(__file__).resolve().with_name("meeting_voice_cluster_backbone.c")
    print(f"PE SHA-256: {PE_SHA256}")
    print(f"Model SHA-256: {MODEL_SHA256}")
    with tempfile.TemporaryDirectory(prefix="welink-pnr-first-conv-") as directory:
        work = Path(directory)
        (work / "pe.bin").write_bytes(pe)
        (work / "model.bin").write_bytes(model)
        (work / "oracle.s").write_text(oracle_assembly(), encoding="ascii")
        subprocess.run(["as", "--32", "-o", "oracle.o", "oracle.s"],
                       cwd=work, check=True, timeout=30)
        sections = ["--section-start=.orig=0x10200000"] + [
            f"--section-start={name}={address:#x}"
            for name, _, address, _, _ in EXTRA_SECTIONS
        ]
        subprocess.run(["ld", "-m", "elf_i386", "-z", "noexecstack", *sections,
                        "-o", "oracle", "oracle.o"], cwd=work, check=True, timeout=30)
        subprocess.run(["cc", "-std=c11", "-O2", "-fno-fast-math",
                        "-ffp-contract=off", "-fPIC", "-shared", str(source),
                        "-o", str(work / "native.so")], check=True, timeout=30)
        native = ctypes.CDLL(str(work / "native.so"))
        compare(native, model, work / "oracle")


if __name__ == "__main__":
    main()
