// Python の TOML writer と同じ順序で、整数に見えるキーも出力する。
export function orderedTable() {
  const order = new Set();
  return new Proxy(Object.create(null), {
    defineProperty(target, key, descriptor) {
      if (!Reflect.defineProperty(target, key, descriptor)) return false;
      order.add(key);
      return true;
    },
    deleteProperty(target, key) {
      if (!Reflect.deleteProperty(target, key)) return false;
      order.delete(key);
      return true;
    },
    ownKeys() {
      return [...order];
    },
  });
}
