#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <poll.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int namespace_child;

static int selected(void) {
  char path[4096];
  ssize_t length = readlink("/proc/self/exe", path, sizeof(path) - 1);
  if (length < 0) _exit(92);
  path[length] = 0;
  return !strcmp(path, PROCESS_PROOF_UNSHARE);
}

/* 実物の unshare の OS 呼出しだけを止める。launcher/Bun/target は差し替えない。 */
static void gate(const char *stage) {
  const char *requested = getenv("PROCESS_PROOF_GATE");
  if (!requested || strcmp(requested, stage) || !selected()) return;
  dprintf(2, "namespace-gate:%s:%ld\n", stage, (long)getpid());
  char byte;
  ssize_t result;
  do { result = read(3, &byte, 1); } while (result < 0 && errno == EINTR);
  if (result != 1) _exit(93);
  close(3);
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
  return result;
}

int execvp(const char *path, char *const argv[]) {
  int (*original)(const char *, char *const []) = dlsym(RTLD_NEXT, "execvp");
  gate("exec-before");
  return original(path, argv);
}
