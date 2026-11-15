#define _POSIX_C_SOURCE 200809L
#include <sys/wait.h>
#include <unistd.h>

int delayed_setpgid(pid_t, pid_t);
pid_t observed_waitpid(pid_t, int *, int);
#define setpgid delayed_setpgid
#define waitpid observed_waitpid
#include "bun-exec-launcher.c"
#undef setpgid
#undef waitpid

/* OS 境界だけを遅らせ、fork 後に子がまだ group に入っていない順序を固定する。 */
int delayed_setpgid(pid_t process, pid_t group) {
  if (process == 0 && group > 0) {
    fprintf(stderr, "prep-joining:%ld\n", (long)getpid());
    fflush(stderr);
    char released;
    ssize_t received;
    do { received = read(3, &released, 1); } while (received < 0 && errno == EINTR);
    if (received < 0) _exit(92);
    close(3);
  }
  return setpgid(process, group);
}

pid_t observed_waitpid(pid_t process, int *status, int options) {
  if (process > 0 && status != NULL && options == 0) {
    if (fprintf(stderr, "prep-waiting:%ld\n", (long)process) < 0 || fflush(stderr) != 0)
      _exit(93);
  }
  return waitpid(process, status, options);
}
