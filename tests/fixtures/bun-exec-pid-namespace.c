/* Linux の正式実証用。製品の起動入口には組み込まない。
 * 準備のたびに方式を選ぶ（ADR 0005）。本番と同じ argv の unshare probe が成功すれば PID namespace、
 * 失敗すれば systemd-run の委譲 scope と cgroup.kill、どちらも使えなければ準備を始めずに拒否する。 */
#define _GNU_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/pidfd.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static int namespace_execv(const char *, char *const []);
static int adaptive_select(const sigset_t *);
static int adaptive_start(void);
static ssize_t adaptive_read(int, void *, size_t);
static int adaptive_await_preparation(void);
static int adaptive_kill(void);
static int adaptive_finish(void);
int launcher_main(int, char **);
#define PROOF_HOOKS
#define PROOF_INTERRUPT() adaptive_kill()
#define PROOF_FINISH() adaptive_finish()
#define PROOF_BEFORE_PREPARATION(mask) adaptive_select(mask)
#define PROOF_AFTER_PREPARATION() adaptive_start()
#define PROOF_READ adaptive_read
#define PROOF_AWAIT_PREPARATION() adaptive_await_preparation()
#define execv namespace_execv
#define main launcher_main
#include "bun-exec-launcher.c"
#undef execv
#undef main

#define GATE_ARGUMENT "--process-proof-cgroup-gate"
#define REFUSED_STATUS 69

static const char *const namespace_prefix[] = {PROCESS_PROOF_UNSHARE, "--user", "--map-current-user",
                                               "--pid", "--fork", "--kill-child=SIGKILL",
#ifndef PROCESS_PROOF_NO_PROC
                                               "--mount-proc",
#endif
                                               "--"};
#define NAMESPACE_PREFIX (sizeof(namespace_prefix) / sizeof(namespace_prefix[0]))

static enum { NAMESPACE, CGROUP } containment;
static char self[4096], scope_path[sizeof(self) + 64];
static int report_pipe[2] = {-1, -1}, go_pipe[2] = {-1, -1};
static volatile sig_atomic_t kill_descriptor = -1;
static int alive = -1, watchdog_descriptor = -1;
static pid_t watchdog;

/* 試験と集約が読む観測。分岐には使わない。 */
static void observe(const char *format, ...) {
  const char *path = getenv("PROCESS_PROOF_OBSERVE");
  if (!path) return;
  int descriptor = open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
  if (descriptor < 0) return;
  va_list arguments;
  va_start(arguments, format);
  vdprintf(descriptor, format, arguments);
  va_end(arguments);
  close(descriptor);
}

/* 選択はキャッシュしない。probe の出力は launcher の stderr へ混ぜない。 */
static int adaptive_select(const sigset_t *original_mask) {
  ssize_t length = readlink("/proc/self/exe", self, sizeof(self) - 1);
  if (length < 0) invalid();
  self[length] = 0;
  pid_t probe = fork();
  if (probe < 0) invalid();
  if (!probe) {
    const char *command[NAMESPACE_PREFIX + 2];
    for (size_t i = 0; i < NAMESPACE_PREFIX; i++) command[i] = namespace_prefix[i];
    command[NAMESPACE_PREFIX] = "/usr/bin/true";
    command[NAMESPACE_PREFIX + 1] = NULL;
    int null = open("/dev/null", O_RDWR);
    if (null < 0 || dup2(null, 0) < 0 || dup2(null, 1) < 0 || dup2(null, 2) < 0) _exit(127);
    execv(command[0], (char *const *)command);
    _exit(127);
  }
  int descriptor = pidfd_open(probe, 0);
  struct pollfd entry = {.fd = descriptor, .events = POLLIN};
  const struct timespec timeout = {.tv_sec = 10};
  int ready = descriptor < 0 ? -1 : ppoll(&entry, 1, &timeout, original_mask);
  if (descriptor >= 0) close(descriptor);
  if (ready <= 0 || interrupted) kill(probe, SIGKILL);
  int status;
  while (waitpid(probe, &status, 0) < 0)
    if (errno != EINTR) return 1;
  if (ready == 0) fputs("launcher: containment probe timed out\n", stderr);
  if (ready <= 0 || interrupted) return 1;
  containment = WIFEXITED(status) && !WEXITSTATUS(status) ? NAMESPACE : CGROUP;
  observe("containment=%s\n", containment == NAMESPACE ? "namespace" : "cgroup");
  if (containment == CGROUP) {
    make_pipe(report_pipe);
    make_pipe(go_pipe);
  }
  return 0;
}

static int write_field(int descriptor, const char *value) {
  size_t remaining = strlen(value) + 1;
  while (remaining) {
    ssize_t written = write(descriptor, value + strlen(value) + 1 - remaining, remaining);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return -1;
    remaining -= (size_t)written;
  }
  return 0;
}

/* 準備の argv と環境を memfd で gate へ渡す。systemd-run の前置き引数や INVOCATION_ID で、
 * 準備の argv・env と ARG_MAX の受理範囲を旧方式から変えない。 */
static int cgroup_execv(const char *path, char *const argv[]) {
  char report[16], go[16], arguments[16], count[32];
  int descriptor = memfd_create("process-proof-arguments", 0);
  if (descriptor < 0) return -1;
  size_t argument_count = 0;
  while (argv[argument_count]) argument_count++;
  snprintf(count, sizeof(count), "%zu", argument_count);
  if (write_field(descriptor, count) < 0 || write_field(descriptor, path) < 0) return -1;
  for (size_t i = 1; i < argument_count; i++)
    if (write_field(descriptor, argv[i]) < 0) return -1;
  for (size_t i = 0; environ[i]; i++)
    if (write_field(descriptor, environ[i]) < 0) return -1;
  snprintf(report, sizeof(report), "%d", report_pipe[1]);
  snprintf(go, sizeof(go), "%d", go_pipe[0]);
  snprintf(arguments, sizeof(arguments), "%d", descriptor);
  if (fcntl(report_pipe[1], F_SETFD, 0) < 0 || fcntl(go_pipe[0], F_SETFD, 0) < 0) return -1;
  char *command[] = {PROCESS_PROOF_SYSTEMD_RUN, "--user", "--scope", "--quiet", "--collect", "-p",
                     "Delegate=yes", "--", self, GATE_ARGUMENT, report, go, arguments, NULL};
  // user bus の接続情報と実証用の preload だけを中継の exec に渡す。
  const char *const keys[] = {"XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
                              "LD_PRELOAD", "PROCESS_PROOF_GATE"};
  char *scope_environment[sizeof(keys) / sizeof(keys[0]) + 1] = {0};
  size_t count_env = 0;
  for (size_t key = 0; key < sizeof(keys) / sizeof(keys[0]); key++) {
    for (size_t i = 0; environ[i]; i++) {
      if (!same_key(environ[i], keys[key], strlen(keys[key]))) continue;
      scope_environment[count_env++] = environ[i];
      break;
    }
  }
  return execve(command[0], command, scope_environment);
}

/* 準備子の中で呼ばれる。probe が成功した後に本番の unshare が失敗しても cgroup へは移らない。 */
static int namespace_execv(const char *path, char *const argv[]) {
  if (containment == CGROUP) return cgroup_execv(path, argv);
  size_t offset = NAMESPACE_PREFIX;
  size_t count = 0;
  while (argv[count]) count++;
  char **command = calloc(count + offset + 1, sizeof(char *));
  if (!command) return -1;
  for (size_t i = 0; i < offset; i++) command[i] = (char *)namespace_prefix[i];
  command[offset] = (char *)path;
  for (size_t i = 1; i < count; i++) command[i + offset] = argv[i];
  int result = execv(command[0], command);
  int saved_errno = errno;
  free(command);
  errno = saved_errno;
  return result;
}

/* scope の中で準備の前に止まり、cgroup を報告して launcher の G を待つ。 */
static int gate_main(char **argv) {
  int report = atoi(argv[2]), go = atoi(argv[3]), arguments = atoi(argv[4]);
  if (fcntl(report, F_SETFD, FD_CLOEXEC) < 0 || fcntl(go, F_SETFD, FD_CLOEXEC) < 0) _exit(91);
  struct stat state;
  if (fstat(arguments, &state) < 0 || state.st_size <= 0) _exit(91);
  char *values = malloc((size_t)state.st_size);
  size_t count = 0;
  if (!values) _exit(91);
  for (off_t offset = 0; offset < state.st_size;) {
    ssize_t length = pread(arguments, values + offset, (size_t)(state.st_size - offset), offset);
    if (length <= 0) _exit(91);
    offset += length;
  }
  close(arguments);
  if (values[state.st_size - 1]) _exit(91);
  for (off_t i = 0; i < state.st_size; i++) count += !values[i];
  char **fields = calloc(count + 2, sizeof(char *));
  if (!fields) _exit(91);
  for (size_t i = 0, offset = 0; i < count; i++) {
    fields[i] = values + offset;
    offset += strlen(fields[i]) + 1;
  }
  char *end;
  unsigned long argument_count = strtoul(fields[0], &end, 10);
  if (*end || !argument_count || argument_count >= count) _exit(91);
  char **command = fields + 1, **environment = fields + 1 + argument_count;
  /* argv と環境の境界を NULL にする。環境の末尾は calloc の NULL。 */
  memmove(environment + 1, environment, (count - 1 - argument_count) * sizeof(char *));
  environment[0] = NULL;
  environment++;
  int descriptor = open("/proc/self/cgroup", O_RDONLY | O_CLOEXEC);
  char content[4096];
  ssize_t length = descriptor < 0 ? -1 : read(descriptor, content, sizeof(content) - 1);
  if (length <= 0) _exit(91);
  close(descriptor);
  content[length] = 0;
  char *line = strstr(content, "0::");
  if (!line || (line != content && line[-1] != '\n')) _exit(91);
  line += 3;
  size_t size = strcspn(line, "\n");
  line[size] = '\n';
  if (write(report, line, size + 1) != (ssize_t)size + 1) _exit(91);
  close(report);
  char byte;
  ssize_t received;
  do { received = read(go, &byte, 1); } while (received < 0 && errno == EINTR);
  if (received != 1 || byte != 'G') _exit(91);
  close(go);
  environ = environment;
  execv(command[0], command);
  _exit(91);
}

/* 準備用 scope の外で独自の session として動き、launcher の死亡（EOF）で cgroup.kill を書く。 */
static void watch_launcher(int control, int ready, int target) {
  sigset_t mask;
  sigfillset(&mask);
  if (sigprocmask(SIG_SETMASK, &mask, NULL) < 0 || setsid() < 0) _exit(91);
  DIR *directory = opendir("/dev/fd");
  if (!directory) _exit(91);
  struct dirent *entry;
  while ((entry = readdir(directory))) {
    char *end;
    long descriptor = strtol(entry->d_name, &end, 10);
    if (!*entry->d_name || *end || descriptor < 0 || descriptor > INT_MAX) continue;
    if (descriptor != control && descriptor != ready && descriptor != target &&
        descriptor != dirfd(directory))
      close((int)descriptor);
  }
  closedir(directory);
  if (write(ready, "R", 1) != 1) _exit(91);
  close(ready);
  struct pollfd waiting = {.fd = control, .events = POLLIN};
  while (poll(&waiting, 1, -1) < 0 && errno == EINTR) {}
  char byte;
  if (read(control, &byte, 1) == 1 && byte == 'D') _exit(0);
  if (write(target, "1", 1) != 1) _exit(92);
  _exit(0);
}

static int fail_start(void) {
  if (go_pipe[1] >= 0) close(go_pipe[1]);
  go_pipe[1] = -1;
  return 1;
}

static int refuse_containment(void) {
  fail_start();
  observe("containment=refused\n");
  fputs("launcher: containment unavailable\n", stderr);
  return REFUSED_STATUS;
}

static ssize_t write_control(int descriptor, const char *byte) {
  struct sigaction ignore = {.sa_handler = SIG_IGN}, saved;
  sigemptyset(&ignore.sa_mask);
  if (sigaction(SIGPIPE, &ignore, &saved) < 0) return -1;
  ssize_t written = write(descriptor, byte, 1);
  int saved_errno = errno;
  if (sigaction(SIGPIPE, &saved, NULL) < 0) return -1;
  errno = saved_errno;
  return written;
}

/* signal を戻した後に呼ばれる。準備は watchdog が cgroup.kill を持つまで始まらない。 */
static int adaptive_start(void) {
  if (containment != CGROUP) return 0;
  close(report_pipe[1]);
  close(go_pipe[0]);
  char line[4096];
  size_t size = 0;
  while (!interrupted && size < sizeof(line) - 1 && !memchr(line, '\n', size)) {
    ssize_t length = read(report_pipe[0], line + size, sizeof(line) - 1 - size);
    if (length < 0 && errno == EINTR) continue;
    if (length <= 0) break;
    size += (size_t)length;
  }
  close(report_pipe[0]);
  if (interrupted) return fail_start();
  char *newline = memchr(line, '\n', size);
  if (!newline) return refuse_containment();
  *newline = 0;
  snprintf(scope_path, sizeof(scope_path), "/sys/fs/cgroup%s", line);
  char path[sizeof(scope_path) + sizeof("/cgroup.kill")];
  snprintf(path, sizeof(path), "%s/cgroup.kill", scope_path);
  int target = open(path, O_WRONLY | O_CLOEXEC);
  if (target < 0) return refuse_containment();
  kill_descriptor = target;
  if (interrupted) return fail_start();
  int control[2], ready[2];
  make_pipe(control);
  make_pipe(ready);
  sigset_t all, previous;
  sigfillset(&all);
  if (sigprocmask(SIG_SETMASK, &all, &previous) < 0) return fail_start();
  watchdog = fork();
  if (!watchdog) watch_launcher(control[0], ready[1], target);
  if (sigprocmask(SIG_SETMASK, &previous, NULL) < 0 || watchdog < 0) return fail_start();
  close(control[0]);
  close(ready[1]);
  alive = control[1];
  char byte;
  ssize_t received;
  do { received = read(ready[0], &byte, 1); } while (received < 0 && errno == EINTR && !interrupted);
  close(ready[0]);
  if (received != 1 || interrupted) return fail_start();
  watchdog_descriptor = pidfd_open(watchdog, 0);
  if (watchdog_descriptor < 0 || interrupted) return fail_start();
  observe("cgroup=%s watchdog=%ld\n", line, (long)watchdog);
  if (write_control(go_pipe[1], "G") != 1) return fail_start();
  close(go_pipe[1]);
  go_pipe[1] = -1;
  return 0;
}

/* watchdog が死んだ場合は準備失敗として launcher 側の後始末に進む。 */
static int poll_with_watchdog(int descriptor) {
  struct pollfd entries[2] = {{.fd = descriptor, .events = POLLIN},
                              {.fd = watchdog_descriptor, .events = POLLIN}};
  if (poll(entries, 2, -1) < 0) return -1;
  if (entries[1].revents) {
    errno = ECHILD;
    return -1;
  }
  return 0;
}

static ssize_t adaptive_read(int descriptor, void *buffer, size_t size) {
  if (watchdog_descriptor >= 0 && poll_with_watchdog(descriptor) < 0) return -1;
  return read(descriptor, buffer, size);
}

/* frame の EOF 後も準備プロセスが終了するまで watchdog を監視する。 */
static int adaptive_await_preparation(void) {
  if (watchdog_descriptor < 0) return 0;
  int descriptor = pidfd_open(preparation, 0);
  if (descriptor < 0) return 1;
  int result;
  do {
    result = poll_with_watchdog(descriptor);
  } while (result < 0 && errno == EINTR && !interrupted);
  close(descriptor);
  return result < 0;
}

/* signal handler からも呼ぶため、開いておいた fd への write だけを行う。 */
static int adaptive_kill(void) {
  if (kill_descriptor < 0) return 0;
  ssize_t written;
  do {
    written = write(kill_descriptor, "1", 1);
  } while (written < 0 && errno == EINTR);
  return written != 1;
}

/* 終了要求が失敗したら control を閉じ、watchdog に再試行させる。 */
static int adaptive_finish(void) {
  int failed = adaptive_kill();
  if (alive >= 0) {
    if (!failed) write_control(alive, "D");
    close(alive);
    alive = -1;
    int status;
    pid_t reaped;
    do {
      reaped = waitpid(watchdog, &status, 0);
    } while (reaped < 0 && errno == EINTR);
    if (reaped == watchdog && WIFEXITED(status) && WEXITSTATUS(status) == 0) failed = 0;
  }
  // systemd が空になった scope を回収済みなら、追加の終了要求は不要。
  struct stat scope;
  if (failed && stat(scope_path, &scope) < 0 && errno == ENOENT) failed = 0;
  if (failed) fputs("launcher: cgroup cleanup failed\n", stderr);
  if (watchdog_descriptor >= 0) close(watchdog_descriptor);
  watchdog_descriptor = -1;
  if (kill_descriptor >= 0) close(kill_descriptor);
  kill_descriptor = -1;
  return failed;
}

int main(int argc, char **argv) {
  if (argc == 5 && !strcmp(argv[1], GATE_ARGUMENT)) return gate_main(argv);
  return launcher_main(argc, argv);
}
