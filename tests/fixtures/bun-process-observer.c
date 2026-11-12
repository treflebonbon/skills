#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static void die(const char *operation) {
  perror(operation);
  exit(90);
}

static void string(const char *value) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    if (*p == '"' || *p == '\\') printf("\\%c", *p);
    else if (*p < 32) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}

static void report(const char *event, int argc, char **argv) {
  sigset_t mask;
  struct stat state;
  if (sigprocmask(SIG_BLOCK, NULL, &mask) < 0) die("sigprocmask");
  printf("{\"event\":\"%s\",\"pid\":%ld,\"ppid\":%ld,\"pgid\":%ld,\"sid\":%ld,",
         event, (long)getpid(), (long)getppid(), (long)getpgrp(), (long)getsid(0));
  printf("\"tty\":[%d,%d,%d],\"foreground\":%ld,\"usr1Blocked\":%d,\"blocked\":[",
         isatty(0), isatty(1), isatty(2), (long)tcgetpgrp(0),
         sigismember(&mask, SIGUSR1));
  int comma = 0;
  for (int number = 1; number < NSIG; number++) {
    if (sigismember(&mask, number) == 1) {
      printf("%s%d", comma ? "," : "", number);
      comma = 1;
    }
  }
  printf("],\"fd9\":");
  if (fstat(9, &state) == 0 && S_ISREG(state.st_mode)) {
    printf("{\"dev\":\"%llu\",\"ino\":\"%llu\",\"cloexec\":%d}",
           (unsigned long long)state.st_dev, (unsigned long long)state.st_ino,
           !!(fcntl(9, F_GETFD) & FD_CLOEXEC));
  } else printf("null");
  printf(",\"marker\":");
  string(getenv("PROCESS_PROOF_MARKER") ? getenv("PROCESS_PROOF_MARKER") : "");
  printf(",\"argv\":[");
  for (int index = 0; index < argc; index++) {
    if (index) putchar(',');
    string(argv[index]);
  }
  printf("]}\n");
  fflush(stdout);
}

#ifdef PROCESS_SNAPSHOT_ADDON
#include <node_api.h>

static napi_value snapshot(napi_env env, napi_callback_info info) {
  (void)info;
  report("before-exec", 0, NULL);
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok) {
    napi_throw_error(env, NULL, "snapshot: undefined を作成できません");
    return NULL;
  }
  return result;
}

NAPI_MODULE_INIT() {
  napi_value function;
  if (napi_create_function(env, "snapshot", NAPI_AUTO_LENGTH, snapshot, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "snapshot", function) != napi_ok) {
    napi_throw_error(env, NULL, "snapshot を export できません");
    return NULL;
  }
  return exports;
}
#endif

int main(int argc, char **argv) {
  struct rlimit core = {0, 0};
  if (setrlimit(RLIMIT_CORE, &core) < 0) die("setrlimit");
  if (!strcmp(argv[0], "codex")) {
    report("target", argc, argv);
    return 37;
  }
  if (argc < 2) return 91;
  if (!strcmp(argv[1], "seed")) {
    if (argc < 7) return 91;
    int descriptor = open(argv[2], O_RDWR | O_CREAT, 0600);
    if (descriptor < 0 || dup2(descriptor, 9) < 0) die("seed fd");
    if (descriptor != 9) close(descriptor);
    if (fcntl(9, F_SETFD, !strcmp(argv[3], "cloexec") ? FD_CLOEXEC : 0) < 0)
      die("fcntl");
    sigset_t mask;
    sigemptyset(&mask);
    if (!strcmp(argv[4], "blocked")) sigaddset(&mask, SIGUSR1);
    if (sigprocmask(SIG_SETMASK, &mask, NULL) < 0) die("seed mask");
    report("seed", 0, NULL);
    execvp(argv[5], &argv[5]);
    die("seed execvp");
  }
  if (!strcmp(argv[1], "report")) {
    report("target", argc, argv);
    return argc > 2 ? atoi(argv[2]) : 0;
  }
  if (!strcmp(argv[1], "interactive")) {
    alarm(10);
    report("ready", argc, argv);
    char input[128];
    if (!fgets(input, sizeof(input), stdin)) die("stdin");
    if (!strcmp(input, "interrupt\n")) raise(SIGINT);
    if (!strcmp(input, "terminate\n")) raise(SIGTERM);
    printf("{\"event\":\"input\",\"value\":");
    string(input);
    printf("}\n");
    return 37;
  }
  if (!strcmp(argv[1], "try-lock")) {
    if (argc != 3) return 91;
    int descriptor = open(argv[2], O_RDWR | O_CREAT, 0600);
    if (descriptor < 0) die("lock open");
    if (flock(descriptor, LOCK_EX | LOCK_NB) == 0) {
      puts("acquired");
      return 0;
    }
    if (errno == EWOULDBLOCK || errno == EAGAIN) {
      puts("busy");
      return 73;
    }
    die("flock");
  }
  return 91;
}
