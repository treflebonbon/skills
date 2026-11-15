/* Linux の正式実証用。製品の起動入口には組み込まない。 */
#define _POSIX_C_SOURCE 200809L
#include <unistd.h>
static int namespace_execv(const char *, char *const []);
#define execv namespace_execv
#include "bun-exec-launcher.c"
#undef execv

static int namespace_execv(const char *path, char *const argv[]) {
  size_t count = 0;
  while (argv[count]) count++;
  const char *prefix[] = {PROCESS_PROOF_UNSHARE, "--user", "--map-current-user",
                        "--pid", "--fork", "--kill-child=SIGKILL",
#ifndef PROCESS_PROOF_NO_PROC
                        "--mount-proc",
#endif
                        "--"};
  size_t offset = sizeof(prefix) / sizeof(prefix[0]);
  char **command = calloc(count + offset + 1, sizeof(char *));
  if (!command) return -1;
  for (size_t i = 0; i < offset; i++) command[i] = (char *)prefix[i];
  command[offset] = (char *)path;
  for (size_t i = 1; i < count; i++) command[i + offset] = argv[i];
  int result = execv(command[0], command);
  int saved_errno = errno;
  free(command);
  errno = saved_errno;
  return result;
}
