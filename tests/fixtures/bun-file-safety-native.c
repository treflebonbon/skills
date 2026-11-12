#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int integer(napi_env env, napi_value value, int *result) {
  double number;
  if (napi_get_value_double(env, value, &number) != napi_ok ||
      !isfinite(number) || number < 0 || number > INT_MAX || number != (int)number) {
    napi_throw_type_error(env, NULL, "非負の int が必要です");
    return 0;
  }
  *result = (int)number;
  return 1;
}

static int component(napi_env env, napi_value value, char *result, size_t capacity) {
  size_t length;
  void *bytes;
  bool is_buffer;
  if (napi_is_buffer(env, value, &is_buffer) != napi_ok || !is_buffer ||
      napi_get_buffer_info(env, value, &bytes, &length) != napi_ok ||
      length == 0 || length >= capacity) {
    napi_throw_type_error(env, NULL, "正規の単一 component が必要です");
    return 0;
  }
  memcpy(result, bytes, length);
  result[length] = '\0';
  if (memchr(result, '\0', length) || strchr(result, '/') ||
      strcmp(result, ".") == 0 || strcmp(result, "..") == 0) {
    napi_throw_type_error(env, NULL, "正規の単一 component が必要です");
    return 0;
  }
  return 1;
}

enum operation { OPEN, MKDIR, RENAME, LINK, UNLINK };

static napi_value call_at(napi_env env, napi_callback_info info) {
  napi_value values[5], result;
  size_t count = 5;
  void *data;
  int fd, flags = 0, mode = 0, other_fd = 0;
  char name[4096], other_name[4096];
  if (napi_get_cb_info(env, info, &count, values, NULL, &data) != napi_ok) return NULL;
  enum operation operation = (enum operation)(uintptr_t)data;
  size_t required = operation == UNLINK ? 2 : operation == MKDIR ? 3 : 4;
  if (count != required) {
    napi_throw_type_error(env, NULL, "Node-API 操作の引数の数が不正です");
    return NULL;
  }
  if (!integer(env, values[0], &fd) || !component(env, values[1], name, sizeof(name))) return NULL;
  if (operation == OPEN && (!integer(env, values[2], &flags) || !integer(env, values[3], &mode))) return NULL;
  if (operation == MKDIR && !integer(env, values[2], &mode)) return NULL;
  if ((operation == RENAME || operation == LINK) &&
      (!integer(env, values[2], &other_fd) || !component(env, values[3], other_name, sizeof(other_name)))) return NULL;
  if ((operation == OPEN || operation == MKDIR) && mode > 07777) {
    napi_throw_type_error(env, NULL, "mode は07777以下が必要です");
    return NULL;
  }
  int value;
  switch (operation) {
    case OPEN: value = openat(fd, name, flags | O_CLOEXEC, (mode_t)mode); break;
    case MKDIR: value = mkdirat(fd, name, (mode_t)mode); break;
    case RENAME: value = renameat(fd, name, other_fd, other_name); break;
    case LINK: value = linkat(fd, name, other_fd, other_name, 0); break;
    case UNLINK: value = unlinkat(fd, name, 0); break;
    default: napi_throw_error(env, NULL, "未対応の Node-API 操作です"); return NULL;
  }
  if (value < 0) value = -errno;
  if (napi_create_int32(env, value, &result) != napi_ok) {
    if (operation == OPEN && value >= 0) close(value);
    return NULL;
  }
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  const char *names[] = {"openat", "mkdirat", "renameat", "linkat", "unlinkat"};
  napi_property_descriptor properties[5];
  for (uintptr_t i = 0; i < 5; i++) {
    properties[i] = (napi_property_descriptor){names[i], NULL, call_at, NULL, NULL, NULL, napi_default, (void *)i};
  }
  if (napi_define_properties(env, exports, 5, properties) != napi_ok) return NULL;
  return exports;
}

NAPI_MODULE(file_safety, initialize)
