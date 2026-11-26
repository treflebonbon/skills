import { createSocket } from "node:dgram";
import { request as httpRequest } from "node:http";
import { connect, createServer, isIP } from "node:net";

function bridge(socketPath: string, port: number) {
  const server = createServer({ allowHalfOpen: true }, (client) => {
    const upstream = connect({ path: socketPath, allowHalfOpen: true });
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    for (const socket of [client, upstream]) {
      socket.on("error", close);
      socket.setTimeout(120_000, close);
    }
    client.pipe(upstream).pipe(client);
  });
  server.listen(port, "127.0.0.1", () => console.log("ready"));
}

async function resolve(socketPath: string, host: string, type: number): Promise<string[] | null> {
  const body = JSON.stringify({ host, type });
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        method: "POST",
        path: "/resolve",
        agent: false,
        headers: { "Content-Length": Buffer.byteLength(body) },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          resolve(null);
          return;
        }
        let text = "";
        response.setEncoding("utf8");
        response.on("error", reject);
        response.on("data", (chunk: string) => {
          text += chunk;
          if (text.length > 1024) request.destroy(new Error("invalid resolver response"));
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(text));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.setTimeout(10_000, () => request.destroy(new Error("resolver timed out")));
    request.end(body);
  });
}

function addressBytes(address: string): Buffer {
  switch (isIP(address)) {
    case 4:
      return Buffer.from(address.split(".").map(Number));
    case 6: {
      const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
      const [left, right] = normalized.split("::");
      const parse = (side: string) =>
        side ? side.split(":").map((part) => parseInt(part, 16)) : [];
      const start = parse(left);
      const end = parse(right ?? "");
      const words = [...start, ...Array<number>(8 - start.length - end.length).fill(0), ...end];
      const bytes = Buffer.alloc(16);
      words.forEach((word, index) => bytes.writeUInt16BE(word, index * 2));
      return bytes;
    }
    default:
      throw new Error("invalid resolver address");
  }
}

async function answer(socketPath: string, packet: Buffer): Promise<Buffer | undefined> {
  if (packet.length < 12 || packet.readUInt16BE(2) & 0xf800 || packet.readUInt16BE(4) !== 1) return;
  let offset = 12;
  const labels = [];
  while (offset < packet.length && packet[offset]) {
    const length = packet[offset++];
    if (length > 63 || offset + length > packet.length) return;
    const label = packet.subarray(offset, offset + length);
    if (label.some((byte) => byte > 0x7f)) return;
    labels.push(label.toString("ascii"));
    offset += length;
  }
  offset++;
  if (offset + 4 > packet.length) return;
  const type = packet.readUInt16BE(offset);
  const queryClass = packet.readUInt16BE(offset + 2);
  const host = labels.join(".").toLowerCase();
  const values =
    (type === 1 || type === 28) && queryClass === 1 && host.length <= 253
      ? await resolve(socketPath, host, type)
      : null;
  const records = (values ?? []).map((address) => {
    const bytes = addressBytes(address);
    const record = Buffer.alloc(12);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(type, 2);
    record.writeUInt16BE(1, 4);
    record.writeUInt32BE(30, 6);
    record.writeUInt16BE(bytes.length, 10);
    return Buffer.concat([record, bytes]);
  });
  const header = Buffer.alloc(12);
  header.writeUInt16BE(packet.readUInt16BE(0), 0);
  header.writeUInt16BE(values === null ? 0x8183 : 0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(records.length, 6);
  return Buffer.concat([header, packet.subarray(12, offset + 4), ...records]);
}

const [mode, value] = process.argv.slice(2);
if (mode === "--dns" && value) {
  const socket = createSocket("udp4");
  socket.on("message", async (packet, sender) => {
    try {
      const reply = await answer(value, packet);
      if (reply) socket.send(reply, sender.port, sender.address, () => {});
    } catch {
      // Drop invalid requests and failed resolver exchanges.
    }
  });
  socket.bind(53, "127.0.0.1");
} else if (mode && value && /^\d+$/.test(value) && Number(value) <= 65535) {
  bridge(mode, Number(value));
} else {
  console.error("usage: raw-gateway-bridge [--dns] socket [port]");
  process.exitCode = 2;
}
