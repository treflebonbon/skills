#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

/* 実証用。製品の入口・配布物としては採用していない。 */
static pid_t preparation;
static volatile sig_atomic_t interrupted;

static void interrupt(int number) {
  int saved_errno = errno;
  interrupted = number;
  kill(preparation, number);
  errno = saved_errno;
}

static void invalid(void) {
  fputs("launcher: preparation failed\n", stderr);
  exit(1);
}

static char *next_nul_field(char **cursor, char *end) {
  char *value = *cursor;
  char *zero = memchr(value, 0, (size_t)(end - value));
  if (!zero) invalid();
  *cursor = zero + 1;
  return value;
}

static long parse_nonnegative_integer(const char *value) {
  char *end;
  errno = 0;
  long result = strtol(value, &end, 10);
  if (errno || !*value || *end || result < 0 || result > 1048576) invalid();
  return result;
}

static const char *error_name(int error) {
  switch (error) {
    case ENOENT: return "ENOENT";
    case ENOTDIR: return "ENOTDIR";
    case EACCES: return "EACCES";
    case ENOEXEC: return "ENOEXEC";
    case E2BIG: return "E2BIG";
    default: return "OTHER";
  }
}

int main(int argc, char **argv) {
  if (argc != 3 || strncmp(argv[1], "/dev/fd/", 8)) invalid();
  int descriptor = (int)parse_nonnegative_integer(argv[1] + 8);
  preparation = (pid_t)parse_nonnegative_integer(argv[2]);
  if (descriptor < 3 || preparation <= 1) invalid();
  const int signals[] = {SIGINT, SIGTERM, SIGHUP};
  struct sigaction saved[3], action;
  memset(&action, 0, sizeof(action));
  sigemptyset(&action.sa_mask);
  action.sa_handler = interrupt;
  for (int i = 0; i < 3; i++) {
    if (sigaction(signals[i], NULL, &saved[i]) < 0) invalid();
    if (saved[i].sa_handler != SIG_IGN && sigaction(signals[i], &action, NULL) < 0)
      invalid();
  }
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
  if (failed || interrupted) kill(preparation, SIGTERM);
  int status;
  while (waitpid(preparation, &status, 0) < 0) {
    if (errno != EINTR) invalid();
  }
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
  long argument_count = parse_nonnegative_integer(next_nul_field(&cursor, end));
  if (!*executable || !argument_count) invalid();
  char **arguments = calloc((size_t)argument_count + 1, sizeof(char *));
  if (!arguments) invalid();
  for (long i = 0; i < argument_count; i++) arguments[i] = next_nul_field(&cursor, end);
  long environment_count = parse_nonnegative_integer(next_nul_field(&cursor, end));
  char **environment = calloc((size_t)environment_count + 1, sizeof(char *));
  if (!environment) invalid();
  const char *path = "/bin:/usr/bin"; /* CPython posixpath.defpath */
  for (long i = 0; i < environment_count; i++) {
    environment[i] = next_nul_field(&cursor, end);
    char *equals = strchr(environment[i], '=');
    if (!equals || equals == environment[i]) invalid();
    if (!strncmp(environment[i], "PATH=", 5)) path = environment[i] + 5;
  }
  if (cursor != end) invalid();
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
  fprintf(stderr, "%s: exec-error:%s errno=%d\n",
          !strcmp(mode, "reviewer") ? "codex-reviewer" : "devshell-env", error_name(error), error);
  return 1;
}
