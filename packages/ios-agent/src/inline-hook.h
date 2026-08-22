// arm64 inline hooking for the iOS simulator (#607).
//
// **Why this exists rather than fishhook.** fishhook rewrites a Mach-O image's indirect symbol
// pointers, which reaches only images outside the dyld shared cache. Measured in a real `.app`:
// every system framework calls its neighbours with direct branches inside the cache, so neither the
// socket layer nor the path layer was reachable — the hooks that appeared to work were our own
// dylib's imports, which is also what made the first self-check a false positive.
//
// This patches the **target function's own body**, so it does not care how the call site reached it.
//
// **It refuses more than it handles, on purpose.** tapflow signs off on other people's apps, and the
// worst failure here is not a crash — it is lying: a tester reporting "offline handling works" for an
// app that was never offline. A hook that cannot be installed correctly is not installed, and says so.

#ifndef TAPFLOW_INLINE_HOOK_H
#define TAPFLOW_INLINE_HOOK_H

#include <stdbool.h>
#include <stdint.h>

/** Why an install was refused. Present on failure, `NULL` on success. */
typedef enum {
  TF_HOOK_OK = 0,
  TF_HOOK_ERR_UNRELOCATABLE,   // the first instruction is PC-relative or a return
  TF_HOOK_ERR_NO_MEMORY,       // trampoline or island could not be allocated
  TF_HOOK_ERR_BUSY,            // a thread is parked inside the bytes we must overwrite
  TF_HOOK_ERR_WRITE,           // the page refused to become writable
} tf_hook_error_t;

typedef struct tf_hook tf_hook_t;

/**
 * Route `target` to `replacement`, and hand back a handle whose `tf_hook_original` reaches the
 * unhooked code.
 *
 * Returns `NULL` and sets `*err` when it refuses. **Refusal is a normal outcome** — the caller
 * reports it rather than proceeding as if the hook were live.
 */
tf_hook_t *tf_hook_install(void *target, void *replacement, tf_hook_error_t *err);

/** Call this to reach the original function. Valid for the life of the process. */
void *tf_hook_original(const tf_hook_t *hook);

/** Human-readable reason, for logging **after** any thread suspension has ended. */
const char *tf_hook_strerror(tf_hook_error_t err);

#endif
