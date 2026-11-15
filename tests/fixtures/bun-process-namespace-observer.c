#define main process_observer_main
#include "bun-process-observer.c"
#undef main
#include <grp.h>

static void mapping(const char *name) {
  char path[64];
  snprintf(path, sizeof(path), "/proc/self/%s", name);
  FILE *file = fopen(path, "r");
  if (!file) die("namespace map");
  fprintf(stderr, ",\"%s\":[", name);
  unsigned long inside, outside, length;
  int comma = 0, fields;
  while ((fields = fscanf(file, "%lu %lu %lu", &inside, &outside, &length)) == 3) {
    fprintf(stderr, "%s[%lu,%lu,%lu]", comma ? "," : "", inside, outside, length);
    comma = 1;
  }
  if (fields != EOF || ferror(file)) die("namespace map format");
  fclose(file);
  fputc(']', stderr);
}

static void context(void) {
  fprintf(stderr, "namespace-context:{\"pid\":%ld,\"ppid\":%ld,\"uid\":%ld,\"euid\":%ld,\"gid\":%ld,\"egid\":%ld,\"groups\":[",
          (long)getpid(), (long)getppid(), (long)getuid(), (long)geteuid(), (long)getgid(), (long)getegid());
  int count = getgroups(0, NULL);
  if (count < 0) die("getgroups");
  gid_t *groups = calloc((size_t)count + 1, sizeof(gid_t));
  if (!groups || getgroups(count, groups) < 0) die("getgroups");
  for (int i = 0; i < count; i++) fprintf(stderr, "%s%ld", i ? "," : "", (long)groups[i]);
  free(groups);
  char proc[64];
  ssize_t length = readlink("/proc/self", proc, sizeof(proc) - 1);
  if (length < 0) die("proc self");
  proc[length] = 0;
  fprintf(stderr, "],\"procSelf\":\"%s\"", proc);
  mapping("uid_map");
  mapping("gid_map");
  fputs(",\"fds\":[", stderr);
  int comma = 0;
  for (int fd = 3; fd < 128; fd++) {
    struct stat state;
    if (fstat(fd, &state) == 0) {
      fprintf(stderr, "%s{\"fd\":%d,\"dev\":\"%llu\",\"ino\":\"%llu\",\"cloexec\":%d}",
              comma ? "," : "", fd, (unsigned long long)state.st_dev,
              (unsigned long long)state.st_ino, !!(fcntl(fd, F_GETFD) & FD_CLOEXEC));
      comma = 1;
    }
  }
  fputs("]}\n", stderr);
  fflush(stderr);
}

int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "context")) { context(); return 0; }
  if (argc == 9 && !strcmp(argv[1], "exec-input")) {
    char *end;
    long count = strtol(argv[7], &end, 10);
    if (*end || count < 0 || count > 8192) return 91;
    long tail = strtol(argv[8], &end, 10);
    if (*end || tail < 0 || tail > 1024) return 91;
    char **arguments = calloc((size_t)count + 9, sizeof(char *));
    if (!arguments) die("exec-input calloc");
    for (int i = 0; i < 4; i++) arguments[i] = argv[i + 2];
    arguments[4] = "reviewer";
    arguments[5] = argv[6];
    arguments[6] = "--";
    char payload[1025];
    memset(payload, 'x', 1024);
    payload[1024] = 0;
    for (long i = 0; i < count; i++) arguments[i + 7] = payload;
    char last[1025];
    memset(last, 'y', (size_t)tail);
    last[tail] = 0;
    arguments[count + 7] = last;
    extern char **environ;
    execve(arguments[0], arguments, environ);
    fprintf(stderr, "exec-input: errno=%d %s\n", errno, strerror(errno));
    return 1;
  }
  if (!strcmp(argv[0], "codex") || (argc > 1 && (!strcmp(argv[1], "seed") || !strcmp(argv[1], "report") || !strcmp(argv[1], "interactive")))) context();
  return process_observer_main(argc, argv);
}
