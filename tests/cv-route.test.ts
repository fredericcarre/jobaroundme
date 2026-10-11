import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST } from "@/app/api/cv/route";

const ORIGINAL_TRUSTED_CLIENT_IP_HEADER =
  process.env.TRUSTED_CLIENT_IP_HEADER;

beforeAll(() => {
  process.env.TRUSTED_CLIENT_IP_HEADER = "x-real-ip";
});

afterAll(() => {
  if (ORIGINAL_TRUSTED_CLIENT_IP_HEADER === undefined) {
    delete process.env.TRUSTED_CLIENT_IP_HEADER;
  } else {
    process.env.TRUSTED_CLIENT_IP_HEADER =
      ORIGINAL_TRUSTED_CLIENT_IP_HEADER;
  }
});

describe("POST /api/cv", () => {
  it("accepte l’absence de Sec-Fetch-Site et renvoie le profil structuré sans réexposer le texte extrait", async () => {
    const formData = new FormData();
    formData.append(
      "cv",
      new File(
        [
          "Conseiller de vente en alternance, étudiant en BTS MCO. " +
            "Expérience en accueil client, encaissement et mise en rayon.",
        ],
        "cv.txt",
        { type: "text/plain" },
      ),
    );

    const response = await POST(
      new Request("http://localhost/api/cv", {
        method: "POST",
        body: formData,
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(body).not.toHaveProperty("text");
    expect(body).toMatchObject({
      fileName: "cv.txt",
      characters: expect.any(Number),
      retention: "Le fichier et son texte ne sont pas conservés par le serveur.",
      profile: {
        headline: "Conseiller de vente · BTS MCO",
        diploma: "BTS Management commercial opérationnel (RNCP 38362)",
        targetRoles: ["Conseiller de vente"],
        confidence: "high",
      },
    });
  });

  it("refuse une requête navigateur cross-site et annule son corps non lu", async () => {
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
        "Sec-Fetch-Site": "cross-site",
        "x-real-ip": "198.51.100.201",
      },
      body,
      duplex: "half",
    } satisfies RequestInit & { duplex: "half" };

    const response = await POST(
      new Request("http://localhost/api/cv", init),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(cancelled).toBe(true);
  });

  it("accepte une requête same-origin", async () => {
    const formData = new FormData();
    formData.append(
      "cv",
      new File(
        ["Conseiller de vente BTS MCO accueil client encaissement mise en rayon"],
        "same-origin.txt",
        { type: "text/plain" },
      ),
    );

    const response = await POST(
      new Request("http://localhost/api/cv", {
        method: "POST",
        headers: {
          "Sec-Fetch-Site": "same-origin",
          "x-real-ip": "198.51.100.202",
        },
        body: formData,
      }),
    );

    expect(response.status).toBe(200);
  });

  it("refuse un corps déclaré trop volumineux avant de le matérialiser", async () => {
    const response = await POST(
      new Request("http://localhost/api/cv", {
        method: "POST",
        headers: { "Content-Length": String(6 * 1024 * 1024) },
        body: new Uint8Array([1]),
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("5 Mo"),
    });
  });

  it("refuse plusieurs fichiers sous le même champ", async () => {
    const boundary = "jobaroundme-two-files";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="cv"; filename="un.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\n${"a".repeat(40)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="cv"; filename="deux.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\n${"b".repeat(40)}\r\n` +
      `--${boundary}--\r\n`;

    const response = await POST(
      new Request("http://localhost/api/cv", {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "x-real-ip": "198.51.100.203",
        },
        body,
      }),
    );

    expect(response.status).toBe(400);
  });

  it("refuse les formulaires URL-encoded et annule leur corps sans le lire", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const response = await POST(
      streamRequest(body, {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-real-ip": "198.51.100.210",
      }),
    );

    expect(response.status).toBe(415);
    expect(cancelled).toBe(true);
  });

  it("exige une boundary multipart valide avant de lire le corps", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const response = await POST(
      streamRequest(body, {
        "Content-Type": "multipart/form-data",
        "x-real-ip": "198.51.100.211",
      }),
    );

    expect(response.status).toBe(400);
    expect(cancelled).toBe(true);
  });

  it("rejette un champ texte dès ses en-têtes sans matérialiser sa charge", async () => {
    const boundary = "jobaroundme-text-field";
    const prefix = new TextEncoder().encode(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="cv"\r\n\r\n`,
    );
    let sentPrefix = false;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sentPrefix) {
          sentPrefix = true;
          controller.enqueue(prefix);
          return;
        }
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await POST(
      streamRequest(body, {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "x-real-ip": "198.51.100.215",
      }),
    );

    expect(response.status).toBe(400);
    expect(cancelled).toBe(true);
  });

  it("refuse une salve de milliers de parties supplémentaires", async () => {
    const boundary = "jobaroundme-many-parts";
    const validText =
      "Conseiller de vente BTS MCO accueil client encaissement mise en rayon";
    const extraParts = Array.from(
      { length: 2_000 },
      (_, index) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="champ-${index}"\r\n\r\nx\r\n`,
    ).join("");
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="cv"; filename="cv.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\n` +
      `${validText}\r\n` +
      extraParts +
      `--${boundary}--\r\n`;

    const response = await POST(
      new Request("http://localhost/api/cv", {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "x-real-ip": "198.51.100.212",
        },
        body,
      }),
    );

    expect(response.status).toBe(400);
  });

  it("refuse un en-tête de partie surdimensionné", async () => {
    const boundary = "jobaroundme-large-header";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="cv"; filename="cv.txt"\r\n` +
      `X-Fill: ${"a".repeat(9 * 1024)}\r\n` +
      `Content-Type: text/plain\r\n\r\n` +
      `${"Conseiller de vente BTS MCO ".repeat(3)}\r\n` +
      `--${boundary}--\r\n`;

    const response = await POST(
      new Request("http://localhost/api/cv", {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "x-real-ip": "198.51.100.213",
        },
        body,
      }),
    );

    expect(response.status).toBe(400);
  });

  it("coupe un fichier chunked dès qu’il dépasse 5 Mio", async () => {
    const boundary = "jobaroundme-chunked-file";
    const encoder = new TextEncoder();
    const header = encoder.encode(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="cv"; filename="trop-grand.txt"\r\n` +
        `Content-Type: text/plain\r\n\r\n`,
    );
    let remaining = 5 * 1024 * 1024 + 1;
    let sentHeader = false;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sentHeader) {
          sentHeader = true;
          controller.enqueue(header);
          return;
        }
        if (remaining > 0) {
          const length = Math.min(64 * 1024, remaining);
          remaining -= length;
          controller.enqueue(new Uint8Array(length));
          return;
        }
        controller.enqueue(encoder.encode(`\r\n--${boundary}--\r\n`));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });

    const response = await POST(
      streamRequest(body, {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "x-real-ip": "198.51.100.214",
      }),
    );

    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
  });

  it("borne les corps de CV simultanément avant de les lire", async () => {
    const stalledUploads = Array.from({ length: 4 }, (_, index) =>
      createStalledUpload(`198.51.100.${index + 1}`),
    );
    const pendingResponses = stalledUploads.map(({ request }) => POST(request));

    const saturatedUpload = createStalledUpload("198.51.100.99");
    const saturatedResponse = await POST(saturatedUpload.request);

    expect(saturatedResponse.status).toBe(503);
    expect(saturatedResponse.headers.get("Retry-After")).toBe("3");

    for (const upload of stalledUploads) upload.close();
    await Promise.all(pendingResponses);

    const releasedForm = new FormData();
    releasedForm.append(
      "cv",
      new File(
        ["Conseiller de vente BTS MCO accueil client encaissement mise en rayon"],
        "apres.txt",
        { type: "text/plain" },
      ),
    );
    const releasedResponse = await POST(
      new Request("http://localhost/api/cv", {
        method: "POST",
        headers: { "x-real-ip": "198.51.100.100" },
        body: releasedForm,
      }),
    );
    expect(releasedResponse.status).toBe(200);
  });
});

function createStalledUpload(address: string): {
  request: Request;
  close: () => void;
} {
  let close: () => void = () => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => controller.close();
    },
  });
  const init = {
    method: "POST",
    headers: {
      "Content-Type": "multipart/form-data; boundary=jobaroundme-test",
      "x-real-ip": address,
    },
    body,
    duplex: "half",
  } satisfies RequestInit & { duplex: "half" };

  return {
    request: new Request("http://localhost/api/cv", init),
    close: () => close(),
  };
}

function streamRequest(
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string>,
) {
  const init = {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } satisfies RequestInit & { duplex: "half" };
  return new Request("http://localhost/api/cv", init);
}

