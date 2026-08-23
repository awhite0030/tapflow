// tapflow — tell an iOS simulator's app that it is off the network (#607).
//
// The simulator has no NIC to attach a shaper to: it is native processes on the host kernel sharing
// the host's network stack, so Network Link Conditioner, `dnctl`, and every other traffic-shaping
// route reach the whole Mac or nothing. Apple ships no per-simulator conditioning API — checked
// across `simctl`, CoreSimulator's private selectors and the runtime itself on Xcode 26.6.
//
// **Blocking the traffic is not this file's job.** The host content filter (`ios-netfilter`) drops
// the flows of one simulator at the kernel. What no host-side filter can do is change what the app
// *believes*: an app reads `nw_path_get_status` inside its update handler, the real path never
// changed — the Mac is still on Wi-Fi — so the handler never fires again and the offline banner
// never appears. Measured: traffic dead, `path=satisfied` for the life of the process. That half
// needs a hook inside the app, and it is what remains here.
//
// **Inline patching, because neither of the pointer-rewriting techniques reaches.** dyld's
// `__DATA,__interpose` does not fire in a real `.app`, and fishhook — which rewrites indirect symbol
// pointers — reaches only images outside the dyld shared cache, where every system framework calls
// its neighbours with direct branches. Both were measured here, and fishhook's apparent success was
// this dylib's own imports being rebound, which is also what made the first self-check pass while
// nothing was blocked. `inline-hook.c` patches the target function's body instead.
//
// This is deliberately a **QA instrument that lies to one app**, so everything here is built around
// one question: can it lie *silently*? A hook that does not install produces a false QA result —
// someone signs off "offline handling works" on an app that was never offline. `rebind_symbols`
// returns 0 whether or not it rebound anything, so nothing here trusts that it worked;
// `tf_self_check` proves it by trying.

#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <Network/Network.h>
#import <arpa/inet.h>
#import <netdb.h>
#import <netinet/in.h>
#import <stdlib.h>
#import <sys/resource.h>
#import <sys/socket.h>
#import <os/log.h>
#import <stdatomic.h>
#import <stdio.h>
#import <string.h>
#import <sys/stat.h>
#import <unistd.h>

#import "inline-hook.h"

static os_log_t tf_log(void) {
  static os_log_t log;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ log = os_log_create("io.tapflow.nethook", "hook"); });
  return log;
}

// ── what makes this process a target ─────────────────────────────────────────

/**
 * The dylib is delivered simulator-wide (`launchctl setenv DYLD_INSERT_LIBRARIES`), so it loads in
 * every process in the simulator — SpringBoard, backboardd, the lot — and the defence is **this
 * function, not the delivery**. Anything not recognised gets no hooks at all.
 *
 * **The reason originally given for that breadth has been measured false.** It said simulator-wide
 * delivery was the only way to reach an app's WebView, `WebKit.Networking` being a sibling process
 * under `launchd_sim` that `SIMCTL_CHILD_…` could not follow. The sibling part is true; the reach is
 * not. Measured 2026-08-23 with an app holding a real `WKWebView`: `WebKit.Networking`,
 * `WebKit.WebContent` and `WebKit.GPU` all spawned, and **not one of them loaded this library** —
 * they are restricted enough that dyld drops `DYLD_*`. Ordinary daemons in the same simulator loaded
 * it in the same run, so the delivery itself works.
 *
 * Two things follow, and neither is fixed here. The `com.apple.WebKit.` branch below has never
 * matched anything, and a hybrid app's web half is **not** told it is offline — its traffic is still
 * blocked, because the host content filter works at the kernel for every process, but the path it
 * reads is real. And simulator-wide delivery no longer has the justification it was chosen for, which
 * matters because it is the mechanism that can take a whole simulator down at once.
 *
 * **The default is off.** With no target named, or no bundle identifier to compare, this returns
 * false: a bug in the identification leaves the simulator unhooked rather than hooking the system.
 */
static BOOL tf_is_target_app(void) {
  const char *target = getenv("TAPFLOW_TARGET_BUNDLE");
  if (target == NULL || *target == '\0') return NO;
  NSString *me = NSBundle.mainBundle.bundleIdentifier;
  return me != nil && [me isEqualToString:@(target)];
}

static BOOL tf_should_activate(void) {
  if (tf_is_target_app()) return YES;

  const char *target = getenv("TAPFLOW_TARGET_BUNDLE");
  if (target == NULL || *target == '\0') return NO;
  NSString *me = NSBundle.mainBundle.bundleIdentifier;
  if (me == nil) return NO;

  // The app's WebView helpers — **measured never to reach here**, see above. Kept rather than
  // deleted because the branch is what a future runtime that stops restricting those processes would
  // need, and because deleting it would leave nothing saying the coverage is absent. It is not a
  // claim that the coverage exists.
  //
  // Were it ever reached, the prefix would not separate this app's WebView from Safari's, which is
  // one reason the verdict is written only by the target app.
  return [me hasPrefix:@"com.apple.WebKit."];
}

// ── the condition file ───────────────────────────────────────────────────────

/**
 * `/tmp/tapflow-offline-<udid>`, and the udid is not decoration.
 *
 * The host's `/tmp` is visible at the same path inside **every** simulator on that Mac — measured
 * with two runtimes reading a file written once on the host. Without the udid, one session going
 * offline takes every other session on the machine with it, and `TAPFLOW_TARGET_BUNDLE` above does
 * not help: both simulators activate correctly and then read the same flag.
 */
static const char *tf_condition_path(void) {
  static char path[PATH_MAX];
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    const char *udid = getenv("SIMULATOR_UDID");
    snprintf(path, sizeof(path), "/tmp/tapflow-offline-%s", udid && *udid ? udid : "unknown");
  });
  return path;
}

/**
 * Read on every call rather than cached, which is what makes the toggle live.
 *
 * dyld injects at process start, so arming on demand would mean relaunching the app — and "I got to
 * the payment screen and now I want to cut the network" is the scenario this feature is for. The
 * cost is a `stat` per outbound call; with no condition file present the hooks are a `stat` and a
 * tail call to the original.
 */
static BOOL tf_offline(void) {
  struct stat st;
  return stat(tf_condition_path(), &st) == 0;
}

// A self-check in progress forces `tf_offline` true for this process only, without touching the file
// that every other process reads.
static atomic_bool g_forced_offline = ATOMIC_VAR_INIT(false);

static BOOL tf_blocking(void) {
  return atomic_load_explicit(&g_forced_offline, memory_order_relaxed) || tf_offline();
}

// ── the name lookup ──────────────────────────────────────────────────────────

/**
 * **`connect` and `sendto` used to be hooked here, and are not any more.**
 *
 * They cannot be. Both share a 16K page of libsystem_kernel with `mach_vm_protect`, and
 * `inline-hook.c` refuses that page by design — patching it un-maps the code performing the patch
 * and the app dies in its dyld initialisers (measured three times, see the comment there). Since the
 * install is all-or-none, keeping them meant **no hooks installed at all**, which is what shipped:
 * measured on iOS 17.2 and 26.4, `installed:false` with `connect: refused` and the path hooks never
 * even attempted. The three that remain were measured patchable on both runtimes.
 *
 * That is not a loss, because blocking traffic is no longer this dylib's job. The host content
 * filter (`ios-netfilter`) drops the flows, at the kernel, for **every** process in the simulator
 * rather than the target app and its WebKit helpers — which is strictly wider than these hooks ever
 * reached. The plan recorded that hand-off on 2026-08-22 ("앱-내부 dylib으로 실제 트래픽을 끊는
 * 길이 불가로 확정된 뒤의 재설계"); this file, written the day before, had not caught up.
 *
 * What is left here is the half only an in-process hook can do: **what the app is told.**
 */
static int (*o_getaddrinfo)(const char *, const char *, const struct addrinfo *, struct addrinfo **);

static int tf_getaddrinfo(const char *node, const char *service,
                          const struct addrinfo *hints, struct addrinfo **res) {
  if (tf_blocking() && node != NULL) {
    // Names only, and `localhost` is exempt: tapflow's own instrumentation runs inside the simulator
    // and talks to itself (the UI-tree runner on a fixed port, #433), and a dev build talking to a
    // local Metro server keeps that connection — the honest reading of "no internet", and a line for
    // the user docs. A numeric address is not a lookup at all; `127.0.0.1` arrives here as a string.
    struct in_addr v4;
    struct in6_addr v6;
    BOOL numeric = inet_pton(AF_INET, node, &v4) == 1 || inet_pton(AF_INET6, node, &v6) == 1;
    BOOL local = strcmp(node, "localhost") == 0;
    if (!numeric && !local) return EAI_NONAME;
  }
  return o_getaddrinfo(node, service, hints, res);
}

// ── what the app is told ─────────────────────────────────────────────────────

/**
 * Blocking the traffic is not enough on its own: the offline banner does not appear.
 *
 * An app reads `nw_path_get_status` **inside its update handler** and nowhere else. The real path
 * has not changed — the host is still on Wi-Fi — so the handler never fires again and the app keeps
 * the status it was given at startup. Measured: traffic dead, `path=1` (satisfied) forever.
 *
 * So this captures the app's block, keeps the last `nw_path_t` it was called with, and calls it
 * again when the flag changes. A read hook alone cannot do it; something has to **push**.
 */
static nw_path_status_t (*o_nw_path_get_status)(nw_path_t);
static void (*o_nw_path_monitor_set_update_handler)(nw_path_monitor_t, nw_path_monitor_update_handler_t);

static nw_path_status_t tf_nw_path_get_status(nw_path_t path) {
  if (tf_blocking()) return nw_path_status_unsatisfied;
  return o_nw_path_get_status(path);
}

// The app's handlers, and the last path each was called with. Multiple monitors are ordinary —
// `URLSession` keeps its own alongside the app's.
static NSMutableArray *g_handlers;   // of nw_path_monitor_update_handler_t (copied)
static NSMutableArray *g_paths;      // of nw_path_t, index-aligned with the above
static NSMutableArray *g_monitors;   // of nw_path_monitor_t, index-aligned with the above
static dispatch_queue_t g_handler_queue;

static void tf_nw_path_monitor_set_update_handler(nw_path_monitor_t monitor,
                                                  nw_path_monitor_update_handler_t handler) {
  // Clearing a handler is legal and captures nothing — there is no block to re-fire. A stale entry
  // for this monitor may remain; calling it later is redundant, not unsafe, because of the ownership
  // below.
  if (handler == NULL) {
    o_nw_path_monitor_set_update_handler(monitor, handler);
    return;
  }

  // **Own everything we will later call.** This used to store the block as passed, reasoning that
  // ARC copies it on assignment to a strong local. It does not reliably, and the monitor was not
  // retained at all — so the first live toggle jumped to address 0 inside `tf_push_path_update`
  // (SIGSEGV, measured 2026-08-23, the first run in which the hooks ever installed). A caller that
  // sets a handler and then lets its monitor go is ordinary: `URLSession` does it, and so did this
  // file's own self-check.
  //
  // The monitor is held for the life of the process. That is a bounded leak — a handful of monitors
  // — and it is the price of being able to re-fire a handler at a moment of tapflow's choosing.
  nw_path_monitor_update_handler_t app = [handler copy];

  // The slot is read **inside** the queue. Reading `count` after the barrier let two concurrent
  // registrations derive the same index, which would leave one monitor writing over the other's path.
  __block NSUInteger slot;
  dispatch_sync(g_handler_queue, ^{
    [g_handlers addObject:app];
    [g_paths addObject:[NSNull null]];
    [g_monitors addObject:monitor];
    slot = g_handlers.count - 1;
  });

  o_nw_path_monitor_set_update_handler(monitor, ^(nw_path_t path) {
    dispatch_sync(g_handler_queue, ^{ g_paths[slot] = path; });
    app(path);
  });
}

/**
 * Re-run every captured handler with the path it last saw. `tf_nw_path_get_status` answers.
 *
 * **Snapshot under the queue, call outside it.** These are the app's blocks and they run arbitrary
 * code: a handler that registers another monitor — `URLSession` does — would re-enter this serial
 * queue through `dispatch_sync` and deadlock the app inside its own network callback.
 */
static void tf_push_path_update(void) {
  __block NSArray *handlers, *paths;
  dispatch_sync(g_handler_queue, ^{
    handlers = [g_handlers copy];
    paths = [g_paths copy];
  });

  for (NSUInteger i = 0; i < handlers.count; i++) {
    id path = paths[i];
    if (path == [NSNull null]) continue;   // never delivered one; nothing to replay
    nw_path_monitor_update_handler_t h = handlers[i];
    h((nw_path_t)path);
  }
}

// ── the connections the app already holds ────────────────────────────────────

/**
 * Cutting the connections that were open before the toggle, from inside the app.
 *
 * The host content filter cannot do this, and that is not a gap in tapflow's use of it — Apple is
 * explicit that the decision is one-way: "Once you've allowed a connection to proceed, there's no way
 * to go back on that decision. That's true for both content filter and transparent proxy."
 * (https://developer.apple.com/forums/thread/710166). Keeping every simulator flow under a data
 * verdict instead was built and measured, and `peekBytes` leaves no usable setting: 8192 delivered
 * zero callbacks (an HTTP request never reaches the threshold), 1 delivered 815,869 in forty seconds
 * and timed out even the simulator no rule had named.
 *
 * It matters because `URLSession` holds one connection for a whole session. Without this, a tester
 * who goes offline mid-session watches the app keep talking over the socket it already had, while
 * every *new* request fails — the half-state this feature exists to prevent.
 *
 * `shutdown`, not `close`. The descriptor stays open and owned, so nothing can reuse the number
 * underneath `URLSession` and no other thread's write lands in a stranger's socket; the owner simply
 * sees the connection go away, which is what a phone losing signal looks like.
 */
static BOOL tf_peer_is_loopback(const struct sockaddr *addr) {
  if (addr->sa_family == AF_INET) {
    const struct sockaddr_in *v4 = (const struct sockaddr_in *)addr;
    return (ntohl(v4->sin_addr.s_addr) >> 24) == 127;
  }
  if (addr->sa_family == AF_INET6) {
    const struct sockaddr_in6 *v6 = (const struct sockaddr_in6 *)addr;
    if (IN6_IS_ADDR_LOOPBACK(&v6->sin6_addr)) return YES;
    // ::ffff:127.0.0.0/8 — a v4 loopback reached through a v6 socket, which is what a dual-stack
    // resolver hands back for `localhost` here.
    if (IN6_IS_ADDR_V4MAPPED(&v6->sin6_addr)) {
      return (ntohl(*(const uint32_t *)&v6->sin6_addr.s6_addr[12]) >> 24) == 127;
    }
  }
  return NO;
}

/**
 * The descriptors are walked with plain POSIX rather than `libproc`, which the simulator SDK does not
 * expose. It is not a workaround — the two calls answer exactly the questions that need asking, and
 * their *failures* are the filter:
 *
 *  - `getsockopt(SO_TYPE)` fails on anything that is not a socket, so files and pipes fall out
 *  - `getpeername` fails with `ENOTCONN` on a listening or unconnected socket, so tapflow's own
 *    in-simulator listener (the UI-tree runner, #433) is never touched
 */
static void tf_cut_open_connections(void) {
  struct rlimit rl;
  int max = (getrlimit(RLIMIT_NOFILE, &rl) == 0 && rl.rlim_cur != RLIM_INFINITY) ? (int)rl.rlim_cur : 1024;
  if (max > 8192) max = 8192;   // a bounded scan; an app does not hold more than this

  int cut = 0;
  for (int fd = 0; fd < max; fd++) {
    int type = 0;
    socklen_t tlen = sizeof(type);
    if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &tlen) != 0) continue;
    if (type != SOCK_STREAM) continue;   // UDP has nothing to tear down; its next send is refused anyway

    struct sockaddr_storage peer;
    socklen_t plen = sizeof(peer);
    if (getpeername(fd, (struct sockaddr *)&peer, &plen) != 0) continue;
    if (peer.ss_family != AF_INET && peer.ss_family != AF_INET6) continue;   // AF_UNIX is not the internet
    if (tf_peer_is_loopback((struct sockaddr *)&peer)) continue;             // Metro, and our own runner

    if (shutdown(fd, SHUT_RDWR) == 0) cut++;
  }
  os_log(tf_log(), "cut %{public}d open connection(s)", cut);
}

/**
 * Watch the condition file and push on change.
 *
 * Polled rather than watched with a `DISPATCH_SOURCE_TYPE_VNODE`: the interesting transitions are
 * the file being *created* and *deleted*, and a vnode source needs an open descriptor on a file that
 * does not exist yet. Half a second is below what a tester perceives as a delay and costs one
 * `stat` — the same call the hooks already make per connection.
 */
// **Held in a static, not a local.** Dispatch objects are ARC-managed here, so a
// `dispatch_source_t` local is released when the function returns and the timer stops — measured:
// the install line logged, `installed: true` was written, and not one condition change was ever seen
// because the source had already been torn down.
static dispatch_source_t g_watch_timer;

static void tf_start_watching(void) {
  static BOOL last;
  last = tf_offline();
  dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
                                                   dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
  g_watch_timer = timer;
  dispatch_source_set_timer(timer, DISPATCH_TIME_NOW, 500ull * NSEC_PER_MSEC, 100ull * NSEC_PER_MSEC);
  dispatch_source_set_event_handler(timer, ^{
    BOOL now = tf_offline();
    if (now == last) return;
    last = now;
    os_log(tf_log(), "condition changed: offline=%{public}d — pushing path update", now);
    tf_push_path_update();
    // Only on the way *into* offline. Coming back needs nothing torn down — the app reconnects on its
    // next request, and the push above has already told it the path is satisfied again.
    if (now) tf_cut_open_connections();
  });
  dispatch_resume(timer);
}

// ── proving the hooks took ───────────────────────────────────────────────────

/**
 * Prove the hooks took — **through the API the app uses, never through our own imports**.
 *
 * The first version of this called `connect()` from inside this dylib. That is the one binding a
 * symbol-rebinding hook is guaranteed to catch, so it reported success while real `URLSession`
 * traffic went completely unhooked, and every judgement built on that was wrong. The technique has
 * changed and the trap has not: a probe that exercises our own call sites measures our own call
 * sites.
 *
 * So this drives the stack a real app drives — a real `nw_path_monitor`, which must report
 * `unsatisfied` — with this process forced offline, so the verdict is about the hooks and not about
 * the condition file.
 *
 * **One assertion, deliberately, and the missing one is not an omission.** This used to also require
 * `-1009` from a `URLSession` against a documentation address (RFC 5737 TEST-NET-3), which is what a
 * hooked `connect` yielded. That hook is gone — traffic is the content filter's job now — and no
 * honest in-process replacement exists for it:
 *
 *  - the filter runs on the host, so nothing here can force it on for one process the way
 *    `g_forced_offline` does, and a probe that needed the real toggle would report on the tester's
 *    current state rather than on the hooks
 *  - `getaddrinfo` is still hooked, but its effect cannot be told apart from an unhooked stack
 *    without real DNS traffic: a name that resolves to nothing (`.invalid`, RFC 2606) fails with
 *    `-1003` either way, and a name that does resolve means this self-check phones a real host on
 *    every app launch. The rule this file lives by is *require the specific failure, not any
 *    failure* — for that hook the specific failure is unobservable, so nothing is claimed about it
 *
 * It is still installed, and the install itself is verified: `wanted[]` is all-or-none, so a refused
 * `getaddrinfo` fails the whole install before this runs. What is not verified here is its *effect*.
 * The other half of the feature — that traffic is actually blocked — is verified where it can be, by
 * the agent against the content filter, and reported through `NetworkState`.
 */
static BOOL tf_self_check(void) {
  atomic_store_explicit(&g_forced_offline, true, memory_order_relaxed);

  __block BOOL layer2 = NO;

  nw_path_monitor_t monitor = nw_path_monitor_create();
  nw_path_monitor_set_queue(monitor, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
  dispatch_semaphore_t sawPath = dispatch_semaphore_create(0);
  // **Registered through the original, so this handler is never captured.** It is tapflow's, not the
  // app's: there is no reason to re-fire it later, and capturing it made `tf_push_path_update` call
  // into a monitor this function had already cancelled and a frame it had already left. The hook it
  // bypasses is verified by the install itself (`wanted[]` is all-or-none), and its *effect* —
  // re-firing on a condition change — has nothing to fire against at install time anyway. The
  // assertion below still runs through the hook that matters: `nw_path_get_status`.
  o_nw_path_monitor_set_update_handler(monitor, ^(nw_path_t path) {
    if (!layer2) {
      layer2 = nw_path_get_status(path) == nw_path_status_unsatisfied;
      dispatch_semaphore_signal(sawPath);
    }
  });
  nw_path_monitor_start(monitor);

  dispatch_semaphore_wait(sawPath, dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC));
  nw_path_monitor_cancel(monitor);

  atomic_store_explicit(&g_forced_offline, false, memory_order_relaxed);

  if (!layer2) os_log_error(tf_log(), "self-check: the path was not reported unsatisfied");
  return layer2;
}

/**
 * Where the verdict goes.
 *
 * The agent runs on the host and cannot see into the process, so the result is written where it can
 * read it — beside the condition file, in the same udid-scoped namespace and for the same reason.
 * It is written on **every** launch, including a failing one: an absent file and a failing one mean
 * different things, and only one of them is "no app has run yet".
 */
static void tf_write_verdict(BOOL ok) {
  const char *udid = getenv("SIMULATOR_UDID");
  char path[PATH_MAX];
  snprintf(path, sizeof(path), "/tmp/tapflow-nethook-%s.json", udid && *udid ? udid : "unknown");

  NSString *bundle = NSBundle.mainBundle.bundleIdentifier ?: @"";
  NSString *json = [NSString stringWithFormat:
      @"{\"installed\":%@,\"bundleId\":\"%@\",\"at\":%.0f}\n",
      ok ? @"true" : @"false", bundle, NSDate.date.timeIntervalSince1970];

  FILE *f = fopen(path, "w");
  if (f == NULL) {
    os_log_error(tf_log(), "could not write the verdict to %{public}s", path);
    return;
  }
  fputs(json.UTF8String, f);
  fclose(f);
}

// ── install ──────────────────────────────────────────────────────────────────

__attribute__((constructor))
static void tf_install(void) {
  if (!tf_should_activate()) return;   // every other process in the simulator stops here

  g_handlers = [NSMutableArray array];
  g_paths = [NSMutableArray array];
  g_monitors = [NSMutableArray array];
  g_handler_queue = dispatch_queue_create("io.tapflow.nethook.handlers", DISPATCH_QUEUE_SERIAL);

  // Every hook, or none — and the rule is narrower now than the set it used to guard, not weaker.
  // Faking the status without capturing the handlers gives an app a lie it is never told (nothing
  // re-fires), and capturing them without faking the status re-delivers `satisfied`. Either half
  // alone is a control that appears to work; the first refusal is reported rather than worked around.
  static const struct { const char *name; void *replacement; void **original; } wanted[] = {
    {"getaddrinfo", tf_getaddrinfo, (void **)&o_getaddrinfo},
    {"nw_path_get_status", tf_nw_path_get_status, (void **)&o_nw_path_get_status},
    {"nw_path_monitor_set_update_handler", tf_nw_path_monitor_set_update_handler,
     (void **)&o_nw_path_monitor_set_update_handler},
  };

  BOOL installed = YES;
  for (size_t i = 0; i < sizeof(wanted) / sizeof(wanted[0]); i++) {
    void *target = dlsym(RTLD_DEFAULT, wanted[i].name);
    if (target == NULL) {
      os_log_error(tf_log(), "%{public}s: not found", wanted[i].name);
      installed = NO;
      break;
    }
    tf_hook_error_t err;
    // The slot is handed over rather than assigned from the result: the patch goes live inside this
    // call, so anything written after it returns is written a thread too late.
    if (!tf_hook_install(target, wanted[i].replacement, wanted[i].original, &err)) {
      // Logged after the fact by design — `tf_hook_install` never logs from inside a thread
      // suspension, where `os_log` would deadlock on a lock a stopped thread holds.
      os_log_error(tf_log(), "%{public}s: refused — %{public}s", wanted[i].name, tf_hook_strerror(err));
      installed = NO;
      break;
    }
  }

  // **The verdict is the target app's answer, and only the target app writes it.**
  //
  // The file is keyed by udid alone, and `tf_should_activate` above admits every WebKit process in
  // the simulator — so whichever wrote last used to win. A web view starting anywhere could report
  // `installed:true` while the app under test had never run, and the control then claimed hooks over
  // an app that had none: the exact sign-off this file's preamble calls the worst failure available.
  // The reverse was reachable too, a helper's failure overwriting a healthy app's success.
  //
  // The self-check is inside the same condition rather than beside it. It blocks a dyld initialiser
  // on a 3s semaphore, and running that in every WebKit process the simulator starts delays web view
  // creation for no answer anyone reads.
  BOOL isTarget = tf_is_target_app();
  BOOL ok = installed;
  if (isTarget) {
    ok = installed && tf_self_check();
    tf_write_verdict(ok);
  }
  // Two words for two claims. "verified" is the target app's, and it means the check below actually
  // drove `nw_path_monitor` and saw `unsatisfied`; a helper only ever gets "installed", because
  // nothing proved anything about it.
  os_log(tf_log(), "hooks %{public}s in %{public}@",
         ok ? (isTarget ? "verified" : "installed") : "DID NOT INSTALL",
         NSBundle.mainBundle.bundleIdentifier);

  // Watching is gated on the hooks being in, not on the verdict: a WebView helper has to react to the
  // condition file the same way the app does, and it never runs the check that would produce one.
  if (ok) tf_start_watching();
}
