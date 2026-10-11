import { beforeEach, describe, expect, it, vi } from "vitest";

const transportMocks = vi.hoisted(() => ({
  request: vi.fn(),
  agents: [] as Array<{
    options: Record<string, unknown>;
    destroy: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();

  class InstrumentedEnvHttpProxyAgent {
    readonly destroy = vi.fn(async () => undefined);

    constructor(readonly options: Record<string, unknown>) {
      transportMocks.agents.push(this);
    }
  }

  return {
    ...actual,
    EnvHttpProxyAgent: InstrumentedEnvHttpProxyAgent,
    request: transportMocks.request,
  };
});

import { inspectEmployerWebsite } from "@/lib/site-scanner";

const PUBLIC_ADDRESS = "93.184.216.34";

function responseBody(text = "") {
  const bytes = new TextEncoder().encode(text);
  return {
    destroy: vi.fn(),
    async *[Symbol.asyncIterator]() {
      if (bytes.byteLength > 0) yield bytes;
    },
  };
}

describe("transport réseau du scanner de sites", () => {
  beforeEach(() => {
    transportMocks.request.mockReset();
    transportMocks.agents.splice(0);
  });

  it("transmet l’IP au proxy tout en conservant Host et l’identité TLS", async () => {
    transportMocks.request.mockImplementation(async (input: string | URL) => {
      const url = new URL(input);
      return {
        statusCode: url.pathname === "/robots.txt" ? 404 : 200,
        headers: url.pathname === "/robots.txt"
          ? {}
          : { "content-type": "text/html; charset=utf-8" },
        body: responseBody("<html><body>Bienvenue</body></html>"),
      };
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      resolveHostname: async () => [PUBLIC_ADDRESS],
    });

    expect(inspection.status).toBe("checked");
    expect(transportMocks.request).toHaveBeenCalledTimes(2);
    for (const [input, options] of transportMocks.request.mock.calls as unknown as Array<
      [URL, { headers: Record<string, string> }]
    >) {
      expect(input.hostname).toBe(PUBLIC_ADDRESS);
      expect(options.headers.host).toBe("shop.example");
    }
    expect(transportMocks.agents).toHaveLength(2);
    for (const agent of transportMocks.agents) {
      expect(agent.options).toMatchObject({
        connections: 1,
        pipelining: 0,
        proxyTunnel: true,
        connect: { servername: "shop.example" },
        requestTls: { servername: "shop.example" },
      });
      expect(agent.destroy).toHaveBeenCalledTimes(1);
    }
  });
});
