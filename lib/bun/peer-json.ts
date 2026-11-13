// 保存済み Python JSON の整数と非有限値を、丸めたり null に置換したりしない。
export function parsePeerJSON(raw: Uint8Array): any {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  const strings = new Set<string>();
  const tokens = /"(?:[^"\\]|\\[\s\S])*"|NaN|-?Infinity/g;
  for (const match of text.matchAll(tokens)) {
    if (match[0].startsWith('"')) strings.add(JSON.parse(match[0]));
  }
  let marker = "\0peer-nonfinite";
  while ([...strings].some((value) => value.startsWith(marker))) marker += "!";
  const constants = new Map<string, number>();
  const compatible = text.replace(tokens, (token) => {
    if (token.startsWith('"')) return token;
    const key = marker + constants.size;
    constants.set(key, token === "NaN" ? NaN : token === "Infinity" ? Infinity : -Infinity);
    return JSON.stringify(key);
  });
  const parse = JSON.parse as (
    text: string,
    reviver: (key: string, value: any, context: { source?: string }) => any,
  ) => any;
  return parse(compatible, (_key, value, context) => {
    if (typeof value === "string" && constants.has(value)) return constants.get(value);
    if (typeof value === "number" && context?.source && /^-?\d+$/.test(context.source)) {
      const integer = BigInt(context.source);
      if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER))
        return integer;
    }
    return value;
  });
}

export function peerJSON(value: unknown): string {
  const strings = new Set<string>();
  const visit = (item: any): void => {
    if (typeof item === "string") {
      if (!item.isWellFormed()) throw new Error("JSON を UTF-8 で保存できません");
      strings.add(item);
    } else if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        visit(key);
        visit(child);
      }
    }
  };
  visit(value);
  let marker = "\0peer-nonfinite";
  while ([...strings].some((item) => item.startsWith(marker))) marker += "!";
  const constants = new Map<string, string>();
  const text = JSON.stringify(
    value,
    (_key, item) => {
      if (typeof item === "bigint")
        return (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON(String(item));
      if (typeof item === "number" && Number.isInteger(item) && !Number.isSafeInteger(item))
        // 整数表記では再読込みが BigInt になり、元の IEEE-754 値と食い違う。
        return (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON(
          item.toExponential(),
        );
      if (typeof item === "number" && !Number.isFinite(item)) {
        const key = marker + constants.size;
        constants.set(key, Number.isNaN(item) ? "NaN" : item < 0 ? "-Infinity" : "Infinity");
        return key;
      }
      return item;
    },
    2,
  );
  return (
    text.replace(/"(?:[^"\\]|\\[\s\S])*"/g, (token) => constants.get(JSON.parse(token)) ?? token) +
    "\n"
  );
}

export function equalPeerJSON(left: any, right: any): boolean {
  if (left === right || (Number.isNaN(left) && Number.isNaN(right))) return true;
  if (
    (typeof left === "bigint" && typeof right === "number") ||
    (typeof right === "bigint" && typeof left === "number")
  )
    return left == right;
  if (typeof left === "boolean" && ["number", "bigint"].includes(typeof right))
    return Number(left) == right;
  if (typeof right === "boolean" && ["number", "bigint"].includes(typeof left))
    return left == Number(right);
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equalPeerJSON(left[key], right[key]))
  );
}
