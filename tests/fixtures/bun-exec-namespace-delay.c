#define _GNU_SOURCE
/* 自前の open hook と衝突させないため、fortify の inline 定義を使わない。 */
#undef _FORTIFY_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sched.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int namespace_child;

static int executable(const char *expected) {
  char path[4096];
  ssize_t length = readlink("/proc/self/exe", path, sizeof(path) - 1);
  if (length < 0) _exit(92);
  path[length] = 0;
  return !strcmp(path, expected);
}

/* launcher の方式選択 probe（本番と同じ argv で /usr/bin/true を実行する）は止めない。 */
static int probe(void) {
  char content[8192];
  int descriptor = open("/proc/self/cmdline", O_RDONLY | O_CLOEXEC);
  if (descriptor < 0) _exit(92);
  ssize_t length = read(descriptor, content, sizeof(content));
  close(descriptor);
  if (length <= 1) return 0;
  content[length - 1] = 0;
  char *last = memrchr(content, 0, (size_t)length - 1);
  return !strcmp(last ? last + 1 : content, "/usr/bin/true");
}

static int selected(void) { return executable(PROCESS_PROOF_UNSHARE) && !probe(); }

/* 実物の OS 呼出しの前後で止める。launcher 自身の停止点は中断で解放し、signal の処理を妨げない。 */
static void pause_at(const char *stage, int interruptible) {
  const char *requested = getenv("PROCESS_PROOF_GATE");
  if (!requested || strcmp(requested, stage)) return;
  dprintf(2, "namespace-gate:%s:%ld\n", stage, (long)getpid());
  char byte;
  ssize_t result;
  do { result = read(3, &byte, 1); } while (result < 0 && errno == EINTR && !interruptible);
  if (result != 1 && !(result < 0 && errno == EINTR)) _exit(93);
  close(3);
}

static void gate(const char *stage) {
  if (selected()) pause_at(stage, 0);
}

int unshare(int flags) {
  int (*original)(int) = dlsym(RTLD_NEXT, "unshare");
  gate("namespace-before");
  if (selected() && getenv("PROCESS_PROOF_DENY_NAMESPACE")) {
    dprintf(2, "namespace-denied\n");
    errno = EPERM;
    return -1;
  }
  return original(flags);
}

int pidfd_open(pid_t pid, unsigned int flags) {
  int (*original)(pid_t, unsigned int) = dlsym(RTLD_NEXT, "pidfd_open");
  gate("pidfd-before");
  int result = original(pid, flags);
  gate("pidfd-after");
  if (executable(PROCESS_PROOF_LAUNCHER)) pause_at("watchdog-after", 1);
  return result;
}

pid_t fork(void) {
  pid_t (*original)(void) = dlsym(RTLD_NEXT, "fork");
  gate("fork-before");
  pid_t result = original();
  if (result == 0 && selected()) {
    namespace_child = 1;
    // group kill が parent-death 検出の不備を隠さないよう、PID 1 自身も離脱する。
    if (getenv("PROCESS_PROOF_DETACH_INIT") && setsid() < 0) _exit(94);
    gate("fork-child");
  }
  return result;
}

int poll(struct pollfd *fds, nfds_t count, int timeout) {
  int (*original)(struct pollfd *, nfds_t, int) = dlsym(RTLD_NEXT, "poll");
  if (namespace_child && selected()) gate("parent-check");
  int result = original(fds, count, timeout);
  if (namespace_child && selected() && getenv("PROCESS_PROOF_HIDE_PARENT_DEATH") && result > 0) {
    dprintf(2, "namespace-hidden-parent-death\n");
    return 0;
  }
  // 独自 session の watchdog だけが launcher の死亡を見落とす対照。
  if (getenv("PROCESS_PROOF_HIDE_LAUNCHER_DEATH") && count == 1 && getsid(0) == getpid() &&
      executable(PROCESS_PROOF_LAUNCHER))
    for (;;) pause();
  return result;
}

int execvp(const char *path, char *const argv[]) {
  int (*original)(const char *, char *const []) = dlsym(RTLD_NEXT, "execvp");
  gate("exec-before");
  return original(path, argv);
}

int execv(const char *path, char *const argv[]) {
  int (*original)(const char *, char *const []) = dlsym(RTLD_NEXT, "execv");
  if (!strcmp(path, PROCESS_PROOF_SYSTEMD_RUN)) pause_at("systemd-run-before", 0);
  else if (strcmp(path, PROCESS_PROOF_UNSHARE) && executable(PROCESS_PROOF_LAUNCHER))
    pause_at("prepare-exec-before", 0);
  return original(path, argv);
}

int connect(int descriptor, const struct sockaddr *address, socklen_t length) {
  int (*original)(int, const struct sockaddr *, socklen_t) = dlsym(RTLD_NEXT, "connect");
  static int connected;
  if (!connected++ && executable(PROCESS_PROOF_SYSTEMD_RUN)) pause_at("scope-before", 0);
  return original(descriptor, address, length);
}

int open(const char *path, int flags, ...) {
  int (*original)(const char *, int, ...) = dlsym(RTLD_NEXT, "open");
  mode_t mode = 0;
  if (flags & (O_CREAT | O_TMPFILE)) {
    va_list arguments;
    va_start(arguments, flags);
    mode = va_arg(arguments, mode_t);
    va_end(arguments);
  }
  size_t length = strlen(path);
  if (!strcmp(path, "/proc/self/cgroup") && executable(PROCESS_PROOF_LAUNCHER))
    pause_at("scope-after", 0);
  else if (length > 12 && !strcmp(path + length - 12, "/cgroup.kill") &&
           executable(PROCESS_PROOF_LAUNCHER))
    pause_at("watchdog-before", 1);
  return original(path, flags, mode);
}
