import { describe, expect, it } from "vitest";

import {
  readBoundedRequestBody,
  RequestBodyTimeoutError,
  RequestBodyTooLargeError,
} from "@/lib/request-body";
import { readSingleMultipartFile } from "@/lib/multipart";

describe("readBoundedRequestBody", () => {
  it("refuse une longueur déclarée excessive avant de lire le flux", async () => {
    let cancelled = false;
    const request = new Request("https://jobaroundme.test/api", {
      method: "POST",
      headers: { "Content-Length": "101" },
      body: new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readBoundedRequestBody(request, 100)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
    expect(cancelled).toBe(true);
  });

  it("interrompt aussi un corps chunked qui dépasse la limite", async () => {
    const request = new Request("https://jobaroundme.test/api", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(60));
          controller.enqueue(new Uint8Array(50));
          controller.close();
        },
      }),
      // Required by Node.js when a ReadableStream is used as a request body.
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readBoundedRequestBody(request, 100)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });

  it("reconstitue exactement un corps sous la limite", async () => {
    const request = new Request("https://jobaroundme.test/api", {
      method: "POST",
      body: "profil CV",
    });

    const body = await readBoundedRequestBody(request, 100);
    expect(new TextDecoder().decode(body)).toBe("profil CV");
  });

  it("annule un flux qui ne termine pas avant la limite de temps", async () => {
    const request = new Request("https://jobaroundme.test/api", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({}),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(
      readBoundedRequestBody(request, 100, { totalTimeoutMs: 100 }),
    ).rejects.toBeInstanceOf(RequestBodyTimeoutError);
  });

  it("annule immédiatement le lecteur si la requête est abandonnée", async () => {
    const controller = new AbortController();
    let streamCancelled = false;
    const request = new Request("https://jobaroundme.test/api", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        cancel() {
          streamCancelled = true;
        },
      }),
      signal: controller.signal,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const reading = readBoundedRequestBody(request, 100, {
      totalTimeoutMs: 5_000,
    });
    controller.abort(new DOMException("Requête abandonnée", "AbortError"));

    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(streamCancelled).toBe(true);
  });
});

describe("readSingleMultipartFile", () => {
  it("reconstitue exactement un fichier livré en dizaines de milliers de fragments", async () => {
    const boundary = "jobaroundme-fragmented";
    const encoder = new TextEncoder();
    const fileText =
      "Conseiller de vente BTS MCO accueil client encaissement mise en rayon.\n".repeat(
        512,
      );
    const bodyBytes = encoder.encode(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="cv"; filename="fragmente.txt"\r\n` +
        `Content-Type: text/plain\r\n\r\n` +
        `${fileText}\r\n` +
        `--${boundary}--\r\n`,
    );
    let offset = 0;
    let emittedFragments = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bodyBytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bodyBytes.subarray(offset, offset + 1));
        offset += 1;
        emittedFragments += 1;
      },
    });
    const request = new Request("https://jobaroundme.test/api/cv", {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const file = await readSingleMultipartFile(request, {
      fieldName: "cv",
      maximumFileBytes: 64 * 1024,
      maximumHeaderBytes: 512,
      maximumHeaderPairs: 4,
      maximumRequestBytes: 128 * 1024,
      totalTimeoutMs: 5_000,
    });

    expect(emittedFragments).toBe(bodyBytes.byteLength);
    expect(emittedFragments).toBeGreaterThan(30_000);
    expect(file.fileName).toBe("fragmente.txt");
    expect(new TextDecoder().decode(file.bytes)).toBe(fileText);
  });

  it("respecte sa deadline même si l’annulation du flux ne se termine jamais", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => {
        cancelled = true;
        return new Promise<void>(() => undefined);
      },
    });
    const init = {
      method: "POST",
      headers: {
        "Content-Type": "multipart/form-data; boundary=jobaroundme-timeout",
      },
      body,
      duplex: "half",
    } satisfies RequestInit & { duplex: "half" };
    const request = new Request("https://jobaroundme.test/api/cv", init);
    const startedAt = Date.now();

    await expect(
      readSingleMultipartFile(request, {
        fieldName: "cv",
        maximumFileBytes: 512,
        maximumHeaderBytes: 256,
        maximumHeaderPairs: 4,
        maximumRequestBytes: 1_024,
        totalTimeoutMs: 100,
      }),
    ).rejects.toBeInstanceOf(RequestBodyTimeoutError);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(cancelled).toBe(true);
  });
});
