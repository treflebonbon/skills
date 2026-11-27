import { createInterface } from "node:readline";
import { join } from "node:path";
import { withGatewayScope, type GatewayOptions, type Service } from "../../lib/bun/raw-gateway.ts";
import { bridgeStartup } from "../../lib/bun/raw-isolation.ts";

if (process.argv[2] === "bridge-script") {
  process.stdout.write(bridgeStartup("dependencies", 8124));
} else {
  const input = createInterface({ input: process.stdin });
  const lines = input[Symbol.asyncIterator]();
  try {
    const line = (await lines.next()).value;
    if (line === undefined) throw new Error("missing fixture gateway configuration");
    const { service, domains, githubPolicy, githubSeed } = JSON.parse(line) as {
      service: Service;
      domains?: GatewayOptions["domains"];
      githubPolicy?: unknown;
      githubSeed?: { pack: string; pushHelper: string };
    };
    await withGatewayScope(async (start) => {
      const directory = await start(service, {
        domains: domains ?? undefined,
        githubPolicy: githubPolicy ?? undefined,
        githubSeed: githubSeed && {
          pack: Buffer.from(githubSeed.pack, "base64"),
          pushHelper: githubSeed.pushHelper,
        },
      });
      console.log(join(directory, "service.sock"));
      await lines.next();
    });
  } finally {
    input.close();
  }
}
