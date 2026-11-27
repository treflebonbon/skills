import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { once } from "node:events";
import { BlockList, connect, isIP, type Socket } from "node:net";

export function allowedDestination(host: string, domains: readonly string[]): boolean {
  return (
    /^[a-z0-9.-]+(?![\s\S])/.test(host) &&
    domains.some(
      (domain) =>
        host === domain ||
        (domain.startsWith("**.") && (host === domain.slice(3) || host.endsWith(domain.slice(2)))),
    )
  );
}

// Python 3.14 の is_global に合わせる。BlockList は IPv4-mapped IPv6 にも IPv4 ルールを適用する。
const nonpublic = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["240.0.0.0", 4],
  ["::", 127],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
] as const) {
  nonpublic.addSubnet(address, prefix, isIP(address) === 6 ? "ipv6" : "ipv4");
}
const exceptions = new BlockList();
for (const address of ["192.0.0.9", "192.0.0.10"]) exceptions.addAddress(address);
for (const address of ["2001:1::1", "2001:1::2"]) exceptions.addAddress(address, "ipv6");
for (const [address, prefix] of [
  ["2001:3::", 32],
  ["2001:4:112::", 48],
  ["2001:20::", 28],
  ["2001:30::", 28],
] as const)
  exceptions.addSubnet(address, prefix, "ipv6");

export async function publicAddresses(host: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const pending = lookup(host, { all: true, order: "verbatim" });
  // getaddrinfo は中断できないため、スコープ終了後に到着した結果は破棄する。
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
  signal.throwIfAborted();
  return addresses.every(({ address, family }) => {
    if (address.includes("%") || isIP(address) !== family) return false;
    const type = family === 6 ? "ipv6" : "ipv4";
    return !nonpublic.check(address, type) || exceptions.check(address, type);
  })
    ? addresses
    : null;
}

function inspectHello(data: Buffer, host: string) {
  let offset = 0;
  function take(size: number) {
    if (offset + size > data.length) throw new Error("malformed TLS ClientHello");
    const value = data.subarray(offset, offset + size);
    offset += size;
    return value;
  }
  const vector = (width: number) => take(take(width).readUIntBE(0, width));

  if (take(2).readUInt16BE() !== 0x0303) throw new Error("TLS 1.2 or later required");
  take(32);
  if (vector(1).length > 32) throw new Error("invalid TLS session id");
  const ciphers = vector(2);
  if (!ciphers.length || ciphers.length % 2 || !vector(1).equals(Buffer.from([0])))
    throw new Error("invalid TLS negotiation");
  const extensions = vector(2);
  if (offset !== data.length) throw new Error("trailing ClientHello data");

  data = extensions;
  offset = 0;
  const seen = new Set<number>();
  while (offset < data.length) {
    const kind = take(2).readUInt16BE();
    const value = vector(2);
    // Encrypted ClientHello は実際の宛先を隠せるため拒否する。
    if (seen.has(kind) || kind === 0xfe0d) throw new Error("duplicate or encrypted TLS extension");
    seen.add(kind);
    if (kind === 0) {
      const name = Buffer.from(host, "ascii");
      if (
        value.length !== 5 + name.length ||
        value.readUInt16BE() !== name.length + 3 ||
        value[2] !== 0 ||
        value.readUInt16BE(3) !== name.length ||
        !value.subarray(5).equals(name)
      )
        throw new Error("TLS server name differs from CONNECT destination");
    }
  }
  if (!seen.has(0)) throw new Error("TLS server name required");
}

async function checkedClientHello(client: Socket, head: Buffer, host: string, closed: AbortSignal) {
  const signal = AbortSignal.any([closed, AbortSignal.timeout(10_000)]);
  client.pause();
  if (head.length) client.unshift(head);
  async function read(size: number): Promise<Buffer> {
    while (!client.readableEnded && !client.destroyed) {
      signal.throwIfAborted();
      const chunk: Buffer | null = client.read(size);
      if (chunk) {
        if (chunk.length !== size) break;
        return chunk;
      }
      await once(client, "readable", { signal });
    }
    throw new Error("truncated TLS ClientHello");
  }

  const wire: Buffer[] = [];
  const hello = Buffer.allocUnsafe(65536);
  let wireSize = 0;
  let size = 0;
  let total = 4;
  do {
    const header = await read(5);
    const version = header.readUInt16BE(1);
    const length = header.readUInt16BE(3);
    if (header[0] !== 22 || (version !== 0x0301 && version !== 0x0303) || !length || length > 16384)
      throw new Error("expected TLS handshake record");
    wireSize += 5 + length;
    if (wireSize > hello.length) throw new Error("TLS ClientHello too large");
    const payload = await read(length);
    wire.push(header, payload);
    payload.copy(hello, size);
    size += length;
    if (hello[0] !== 1) throw new Error("expected TLS ClientHello");
    if (size >= 4) total = 4 + hello.readUIntBE(1, 3);
  } while (size < total);
  if (size !== total) throw new Error("unexpected data after ClientHello");
  inspectHello(hello.subarray(4, total), host);
  return Buffer.concat(wire, wireSize);
}

function tunnelStatus(client: Socket, status: string) {
  client.end(`HTTP/1.0 ${status}\r\nContent-Length: 0\r\n\r\n`);
}

export async function tunnel(client: Socket, head: Buffer, host: string, scope: AbortSignal) {
  const closed = new AbortController();
  client.once("close", () => closed.abort());
  const signal = AbortSignal.any([scope, closed.signal]);
  client.pause();

  let upstream: Socket | undefined;
  let established = false;
  try {
    const addresses = await publicAddresses(host, signal);
    if (signal.aborted) return;
    if (!addresses?.length) return tunnelStatus(client, "403 Forbidden");
    for (const { address, family } of addresses) {
      const candidate = connect({ host: address, family, port: 443, allowHalfOpen: true });
      candidate.on("error", () => candidate.destroy());
      try {
        await once(candidate, "connect", {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        });
        upstream = candidate;
        break;
      } catch {
        candidate.destroy();
        if (signal.aborted) return;
      }
    }
    if (!upstream) return tunnelStatus(client, "502 Bad Gateway");

    const peer = upstream;
    const close = () => {
      client.destroy();
      peer.destroy();
    };
    client.once("close", close);
    peer.once("close", close);
    client.write("HTTP/1.0 200 Connection established\r\n\r\n");
    established = true;
    peer.setTimeout(120_000, close);
    client.setTimeout(120_000, close);
    peer.write(await checkedClientHello(client, head, host, signal));
    // relay 開始後は Unix ソケットの書き込みキューを流し切ってから閉じる。
    peer.off("close", close);
    peer.once("close", () => client.end());
    client.pipe(peer).pipe(client);
  } catch {
    if (established || signal.aborted) client.destroy();
    else if (!client.destroyed) tunnelStatus(client, "502 Bad Gateway");
    upstream?.destroy();
  }
}
