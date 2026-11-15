#define _POSIX_C_SOURCE 200809L
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <sys/utsname.h>
#include <unistd.h>

/* 実証用。製品の入口・配布物としては採用していない。 */
static pid_t preparation;
static volatile sig_atomic_t guardian;
static volatile sig_atomic_t interrupted;
extern char **environ;

static void interrupt(int number) {
  int saved_errno = errno;
  interrupted = number;
  if (guardian > 1) kill(-guardian, SIGKILL);
  errno = saved_errno;
}

static void finish_preparation(void) {
  if (guardian <= 1) return;
  pid_t owned_guardian = guardian;
  guardian = 0;
  kill(-owned_guardian, SIGKILL);
  while (waitpid(owned_guardian, NULL, 0) < 0 && errno == EINTR) {}
  if (preparation > 1) {
    while (waitpid(preparation, NULL, 0) < 0 && errno == EINTR) {}
    preparation = 0;
  }
}

static void invalid(void) {
  finish_preparation();
  fputs("launcher: preparation failed\n", stderr);
  exit(1);
}

/* 元の stdio が閉じていても dup2/close の対象と衝突させない。 */
static void make_pipe(int descriptors[2]) {
  int created[2];
  if (pipe(created) < 0) invalid();
  for (int i = 0; i < 2; i++) {
    descriptors[i] = fcntl(created[i], F_DUPFD_CLOEXEC, 3);
    if (descriptors[i] < 0) invalid();
    close(created[i]);
  }
}

/* 自分が group leader として生存している間だけ、準備 group を終了する。 */
static void watch_parent(int control, int ready) {
  sigset_t mask;
  sigfillset(&mask);
  if (sigprocmask(SIG_SETMASK, &mask, NULL) < 0 || setpgid(0, 0) < 0) _exit(91);
  DIR *directory = opendir("/dev/fd");
  if (!directory) _exit(91);
  struct dirent *entry;
  while ((entry = readdir(directory))) {
    char *end;
    long descriptor = strtol(entry->d_name, &end, 10);
    if (!*entry->d_name || *end || descriptor < 0 || descriptor > INT_MAX) continue;
    if (descriptor != control && descriptor != ready && descriptor != dirfd(directory))
      close((int)descriptor);
  }
  closedir(directory);
  if (write(ready, "R", 1) != 1) _exit(91);
  close(ready);
  char byte;
  while (read(control, &byte, 1) < 0 && errno == EINTR) {}
  kill(0, SIGKILL);
  _exit(91);
}

static char *next_nul_field(char **cursor, char *end) {
  char *value = *cursor;
  char *zero = memchr(value, 0, (size_t)(end - value));
  if (!zero) invalid();
  *cursor = zero + 1;
  return value;
}

static long parse_nonnegative_integer(const char *value, long maximum) {
  char *end;
  errno = 0;
  long result = strtol(value, &end, 10);
  if (errno || !*value || *end || result < 0 || result > maximum) invalid();
  return result;
}

static const char *error_name(int error) {
  switch (error) {
    case ENOENT: return "ENOENT";
    case ENOTDIR: return "ENOTDIR";
    case EACCES: return "EACCES";
    case ENOEXEC: return "ENOEXEC";
    case E2BIG: return "E2BIG";
    case ELOOP: return "ELOOP";
    case ENAMETOOLONG: return "ENAMETOOLONG";
    case ETXTBSY: return "ETXTBSY";
    default: return NULL;
  }
}

static int same_key(const char *entry, const char *key, size_t length) {
  return !strncmp(entry, key, length) && entry[length] == '=';
}

int main(int argc, char **argv) {
  if (argc < 5) invalid();
  const int signals[] = {SIGINT, SIGTERM, SIGHUP};
  struct sigaction saved[3], action, saved_chld, default_chld;
  sigset_t original_mask, setup_mask;
  sigemptyset(&setup_mask);
  memset(&action, 0, sizeof(action));
  sigemptyset(&action.sa_mask);
  action.sa_handler = interrupt;
  for (int i = 0; i < 3; i++) {
    sigaddset(&setup_mask, signals[i]);
    if (sigaction(signals[i], NULL, &saved[i]) < 0) invalid();
    if (saved[i].sa_handler != SIG_IGN && sigaction(signals[i], &action, NULL) < 0)
      invalid();
  }
  memset(&default_chld, 0, sizeof(default_chld));
  sigemptyset(&default_chld.sa_mask);
  default_chld.sa_handler = SIG_DFL;
  if (sigaction(SIGCHLD, &default_chld, &saved_chld) < 0) invalid();
  if (sigprocmask(SIG_BLOCK, &setup_mask, &original_mask) < 0) invalid();
  int control[2], ready[2], frame[2];
  make_pipe(control);
  make_pipe(ready);
  make_pipe(frame);
  guardian = fork();
  if (guardian < 0) invalid();
  if (!guardian) watch_parent(control[0], ready[1]);
  close(control[0]);
  close(ready[1]);
  char byte;
  ssize_t received;
  do { received = read(ready[0], &byte, 1); } while (received < 0 && errno == EINTR);
  close(ready[0]);
  if (received != 1 || byte != 'R') invalid();
  char **command = calloc((size_t)argc + 1, sizeof(char *));
  if (!command) invalid();
  command[0] = argv[1];
  command[1] = "run";
  for (int i = 2; i < argc; i++) command[i] = argv[i];
  pid_t launcher = getpid();
  preparation = fork();
  if (preparation < 0) invalid();
  if (!preparation) {
    if (setpgid(0, guardian) < 0 || getppid() != launcher ||
        dup2(frame[1], STDOUT_FILENO) < 0) _exit(91);
    close(frame[0]);
    close(frame[1]);
    close(control[1]);
    for (int i = 0; i < 3; i++)
      if (sigaction(signals[i], &saved[i], NULL) < 0) _exit(91);
    if (sigprocmask(SIG_SETMASK, &original_mask, NULL) < 0) _exit(91);
    execv(command[0], command);
    _exit(91);
  }
  close(frame[1]);
  // 子がまだ実行されていなくても、中断を受ける前に準備 group へ移す。
  if (setpgid(preparation, guardian) < 0 && errno != EACCES) {
    kill(preparation, SIGKILL);
    invalid();
  }
  int descriptor = frame[0];
  if (sigprocmask(SIG_SETMASK, &original_mask, NULL) < 0) invalid();
  size_t capacity = 4096, size = 0;
  char *buffer = malloc(capacity);
  if (!buffer) invalid();
  int failed = 0;
  while (!interrupted) {
    if (size == capacity) {
      /* fixture の入力を有限にする。製品の ARG_MAX 契約は別途判断する。 */
      if (capacity == 16 * 1024 * 1024) { failed = 1; break; }
      capacity *= 2;
      char *grown = realloc(buffer, capacity);
      if (!grown) { failed = 1; break; }
      buffer = grown;
    }
    ssize_t length = read(descriptor, buffer + size, capacity - size);
    if (length == 0) break;
    if (length < 0) {
      if (errno == EINTR) continue;
      failed = 1;
      break;
    }
    size += (size_t)length;
  }
  close(descriptor);
  if (failed || interrupted) kill(-guardian, SIGKILL);
  int status;
  while (waitpid(preparation, &status, 0) < 0) {
    if (errno != EINTR) invalid();
  }
  preparation = 0;
  finish_preparation();
  close(control[1]);
  if (sigaction(SIGCHLD, &saved_chld, NULL) < 0) invalid();
  for (int i = 0; i < 3; i++) {
    if (sigaction(signals[i], &saved[i], NULL) < 0) invalid();
  }
  if (interrupted) {
    raise(interrupted);
    _exit(128 + interrupted);
  }
  if (failed || !WIFEXITED(status) || WEXITSTATUS(status)) invalid();

  char *cursor = buffer, *end = buffer + size;
  if (strcmp(next_nul_field(&cursor, end), "exec-proof-v1")) invalid();
  char *mode = next_nul_field(&cursor, end);
  if (strcmp(mode, "reviewer") && strcmp(mode, "search")) invalid();
  char *executable = next_nul_field(&cursor, end);
  long argument_count = parse_nonnegative_integer(next_nul_field(&cursor, end), 1048576);
  if (!*executable || !argument_count) invalid();
  char **arguments = calloc((size_t)argument_count + 1, sizeof(char *));
  if (!arguments) invalid();
  for (long i = 0; i < argument_count; i++) arguments[i] = next_nul_field(&cursor, end);
  long removed_count = parse_nonnegative_integer(next_nul_field(&cursor, end), 1048576);
  char **removed = calloc((size_t)removed_count + 1, sizeof(char *));
  if (!removed) invalid();
  for (long i = 0; i < removed_count; i++) {
    removed[i] = next_nul_field(&cursor, end);
    if (!*removed[i] || strchr(removed[i], '=')) invalid();
  }
  long changed_count = parse_nonnegative_integer(next_nul_field(&cursor, end), 1048576);
  char **changed = calloc((size_t)changed_count + 1, sizeof(char *));
  if (!changed) invalid();
  for (long i = 0; i < changed_count; i++) {
    changed[i] = next_nul_field(&cursor, end);
    char *equals = strchr(changed[i], '=');
    if (!equals || equals == changed[i]) invalid();
  }
  if (cursor != end) invalid();
  size_t original_count = 0, environment_count = 0;
  while (environ[original_count]) original_count++;
  char **environment = calloc(original_count + (size_t)changed_count + 1, sizeof(char *));
  if (!environment) invalid();
  /* Bun 起動用の sanitization を target へ持ち込まず、明示された差分だけ適用する。 */
  for (size_t i = 0; i < original_count; i++) {
    int replaced = 0;
    for (long j = 0; j < removed_count; j++)
      if (same_key(environ[i], removed[j], strlen(removed[j]))) replaced = 1;
    for (long j = 0; j < changed_count; j++)
      if (same_key(environ[i], changed[j], (size_t)(strchr(changed[j], '=') - changed[j]))) replaced = 1;
    if (!replaced) environment[environment_count++] = environ[i];
  }
  for (long i = 0; i < changed_count; i++) environment[environment_count++] = changed[i];
  const char *path = "/bin:/usr/bin"; /* CPython posixpath.defpath */
  for (size_t i = 0; i < environment_count; i++)
    if (!strncmp(environment[i], "PATH=", 5)) path = environment[i] + 5;
  /* 旧 Python 自身が無視する signal。親からの mask と他の SIG_IGN は維持する。 */
  if (signal(SIGPIPE, SIG_IGN) == SIG_ERR || signal(SIGXFSZ, SIG_IGN) == SIG_ERR) invalid();
#ifdef SIGXFZ
  if (signal(SIGXFZ, SIG_IGN) == SIG_ERR) invalid();
#endif
  int error;
  if (!strcmp(mode, "reviewer") || strchr(executable, '/')) {
    execve(executable, arguments, environment);
    error = errno;
  } else {
    int saved_error = 0;
    const char *part = path;
    do {
      const char *colon = strchr(part, ':');
      size_t length = colon ? (size_t)(colon - part) : strlen(part);
      char *candidate = malloc(length + strlen(executable) + 2);
      if (!candidate) invalid();
      if (length) snprintf(candidate, length + strlen(executable) + 2, "%.*s/%s", (int)length, part, executable);
      else strcpy(candidate, executable);
      execve(candidate, arguments, environment);
      error = errno;
      free(candidate);
      if (error != ENOENT && error != ENOTDIR && !saved_error) saved_error = error;
      if (!colon) break;
      part = colon + 1;
    } while (1);
    if (saved_error) error = saved_error;
  }
  const char *name = error_name(error);
  struct utsname system;
  if (!name) name = uname(&system) == 0 ? system.sysname : "unknown-os";
  fprintf(stderr, "%s: exec-error:%s errno=%d target=%s; %s\n",
          !strcmp(mode, "reviewer") ? "codex-reviewer" : "devshell-env", name, error,
          executable, strerror(error));
  return 1;
}
