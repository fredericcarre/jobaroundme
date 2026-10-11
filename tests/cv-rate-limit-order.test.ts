import { describe, expect, it, vi } from "vitest";

const guardState = vi.hoisted(() => ({
  constructed: 0,
  identityCalls: 0,
  limiterCalls: [] as Array<{ instance: number; operation: "inspect" | "check" }>,
}));

vi.mock("@/lib/search-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/search-guard")>();
  return {
    ...actual,
    InMemoryRateLimiter: class {
      private readonly instance = guardState.constructed++;

      inspect() {
        guardState.limiterCalls.push({
          instance: this.instance,
          operation: "inspect",
        });
        const allowed = this.instance !== 1;
        return {
          allowed,
          limit: 1,
          remaining: allowed ? 1 : 0,
          resetAfterSeconds: 60,
          retryAfterSeconds: allowed ? 0 : 60,
        };
      }

      check() {
        guardState.limiterCalls.push({
          instance: this.instance,
          operation: "check",
        });
        return {
          allowed: true,
          limit: 1,
          remaining: 0,
          resetAfterSeconds: 60,
          retryAfterSeconds: 0,
        };
      }
    },
    searchClientIdentifier() {
      guardState.identityCalls += 1;
      return "client";
    },
  };
});

import { POST } from "@/app/api/cv/route";

describe("ordre des protections de POST /api/cv", () => {
  it("consulte le quota global avant de calculer ou muter l’identité client", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const init = {
      method: "POST",
      headers: {
        "Content-Type": "multipart/form-data; boundary=jobaroundme-test",
      },
      body,
      duplex: "half",
    } satisfies RequestInit & { duplex: "half" };

    const response = await POST(
      new Request("http://localhost/api/cv", init),
    );

    expect(response.status).toBe(429);
    expect(guardState.limiterCalls).toEqual([
      { instance: 1, operation: "inspect" },
    ]);
    expect(guardState.identityCalls).toBe(0);
    expect(cancelled).toBe(true);
  });
});
