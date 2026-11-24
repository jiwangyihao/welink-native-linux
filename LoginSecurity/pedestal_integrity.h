/* Pedestal cmd80/cmd91 application-asset integrity, independent of databases.
 * execute retains its own request copy and emits one asynchronous reply with
 * rsp=request.cmd, sno=request.sno and the caller's description (or the original
 * tup_sqlite_examin_encrypt_file default). result: 0 intact, 101 digest mismatch,
 * 102 inspection failure. The worker never calls the FFI callback directly.
 *
 * dispatch must run on the JS/FFI owner thread: it consumes at most 64 queued
 * completions and returns callbacks delivered (0..64). Zero includes recursive
 * dispatch or discarded stale completions and need not mean the queue is empty.
 * No lock is held across a callback. Callbacks may reenter shutdown/execute.
 *
 * shutdown returns immediately, cancels the current epoch and clears queues.
 * A later execute starts a new epoch; cancelled work cannot publish into it.
 * The worker is process-lived. Pin this library and every ffi.Callback until
 * process exit; shutdown is not permission to unload code or free callbacks.
 *
 * Compile with PEDESTAL_NATIVE_INTEGRITY only after generating a trusted,
 * compiled-in native_integrity_manifest.h defining:
 *   static const struct pedestal_integrity_asset pedestal_native_integrity_assets[];
 *   static const char pedestal_native_integrity_build[];
 * Paths are relative to resources/app (the native app directory); digests are
 * exactly 64 hexadecimal SHA256 characters. Do not include the checker itself.
 * No runtime sidecar manifests or self-generated baselines are accepted. */
#ifndef PEDESTAL_INTEGRITY_H
#define PEDESTAL_INTEGRITY_H
#include "native_rpc.h"
struct pedestal_integrity_asset {
    const char *relative_path;
    const char *sha256_hex;
};
__attribute__((visibility("default")))
void pedestal_integrity_execute(const struct native_request *request,native_callback callback);
__attribute__((visibility("default"))) int pedestal_integrity_dispatch(void);
__attribute__((visibility("default"))) void pedestal_integrity_shutdown(void);
#endif
