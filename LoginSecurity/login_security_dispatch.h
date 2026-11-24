/* Linux owner-thread callback pumps for the original login/security ABIs.
 * Init, send_msg, shutdown and these pumps are called from the same JS/FFI owner
 * thread. Each dispatch consumes at most 64 queued completions, invokes callbacks
 * without any SDK lock held, and returns the number actually delivered (0..64).
 * Zero also covers recursive dispatch or discarded stale completions; it is not
 * a promise that the entire queue is empty. Continue pumping periodically.
 *
 * Shutdown is nonblocking: it disables callbacks, advances the lifecycle epoch,
 * cancels in-flight work and discards queued requests/results. Init after shutdown
 * creates a new epoch; the persistent worker clears old SDK state before processing
 * its new requests. An old completion can never be delivered to the new callback.
 * Libraries and ffi.Callback objects MUST remain pinned until process exit. */
#ifndef WELINK_LOGIN_SECURITY_DISPATCH_H
#define WELINK_LOGIN_SECURITY_DISPATCH_H
int welink_login_dispatch(void);
int welink_security_dispatch(void);
#endif
