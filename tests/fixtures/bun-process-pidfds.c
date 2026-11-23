#define _GNU_SOURCE
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

/* 所有関係を外側で確認した PID だけを固定し、観測後の後始末にも同じ handle を使う。 */
int main(int argc, char **argv) {
  if (argc < 2) return 91;
  struct pollfd *fds = calloc((size_t)argc - 1, sizeof(*fds));
  if (!fds) return 90;
  int status = 0;
  for (int i = 0; i < argc - 1; i++) fds[i].fd = -1;
  for (int i = 1; i < argc; i++) {
    char *end;
    long pid = strtol(argv[i], &end, 10);
    if (*end || pid <= 1) { status = 91; goto cleanup; }
    fds[i - 1].fd = (int)syscall(SYS_pidfd_open, pid, 0);
    if (fds[i - 1].fd < 0) { perror("pidfd_open"); status = 90; goto cleanup; }
    fds[i - 1].events = POLLIN;
  }
  puts("ready");
  fflush(stdout);
  int command;
  while ((command = getchar()) == '?' || command == '!') {
    if (command == '!') {
      char line[32], *end;
      if (!fgets(line, sizeof(line), stdin)) { status = 91; goto cleanup; }
      long index = strtol(line, &end, 10);
      if (end == line || *end != '\n' || index < 0 || index >= argc - 1) {
        status = 91;
        goto cleanup;
      }
      if (syscall(SYS_pidfd_send_signal, fds[index].fd, SIGKILL, NULL, 0) < 0) {
        perror("pidfd_send_signal");
        status = 90;
        goto cleanup;
      }
      puts("sent");
      fflush(stdout);
      continue;
    }
    if (poll(fds, (nfds_t)argc - 1, 0) < 0) { status = 90; goto cleanup; }
    putchar('[');
    int comma = 0;
    for (int i = 1; i < argc; i++) {
      if (fds[i - 1].revents & POLLIN) {
        printf("%s%s", comma ? "," : "", argv[i]);
        comma = 1;
      }
    }
    puts("]");
    fflush(stdout);
  }
cleanup:
  for (int i = 0; i < argc - 1; i++) {
    if (fds[i].fd >= 0 && syscall(SYS_pidfd_send_signal, fds[i].fd, SIGKILL, NULL, 0) < 0 && errno != ESRCH)
      status = 90;
  }
  struct timespec started, now;
  if (clock_gettime(CLOCK_MONOTONIC, &started) < 0) status = 90;
  else while (1) {
    if (poll(fds, (nfds_t)argc - 1, 0) < 0) { status = 90; break; }
    int remaining = 0;
    for (int i = 0; i < argc - 1; i++) if (fds[i].fd >= 0 && !(fds[i].revents & POLLIN)) remaining++;
    if (!remaining) break;
    if (clock_gettime(CLOCK_MONOTONIC, &now) < 0 || now.tv_sec - started.tv_sec >= 5) {
      status = 90;
      break;
    }
    struct timespec delay = {0, 10000000};
    nanosleep(&delay, NULL);
  }
  for (int i = 0; i < argc - 1; i++) if (fds[i].fd >= 0) close(fds[i].fd);
  free(fds);
  return status;
}
