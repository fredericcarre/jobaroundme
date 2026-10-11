import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";

import { extractPdfTextInWorker } from "@/lib/pdf-extractor";

describe("extractPdfTextInWorker", () => {
  it("extrait le texte dans un processus isolé", async () => {
    const result = await extractPdfTextInWorker(
      createPdf(
        "Conseiller de vente BTS MCO accueil client encaissement mise en rayon",
      ),
      {
        signal: new AbortController().signal,
        timeoutMs: 5_000,
        maxPages: 10,
        maxTextLength: 30_000,
      },
    );

    expect(result).toEqual({
      pages: 1,
      text: "Conseiller de vente BTS MCO accueil client encaissement mise en rayon",
    });
  });

  it("termine le processus avant de signaler le délai dépassé", async () => {
    const extraction = extractPdfTextInWorker(createPdf("CV de test"), {
      signal: new AbortController().signal,
      timeoutMs: 1,
      maxPages: 10,
      maxTextLength: 30_000,
    });

    await expect(extraction).rejects.toThrow(
      "Le PDF a dépassé le temps maximal d’analyse.",
    );
  });

  it("termine le processus quand la requête est annulée", async () => {
    const controller = new AbortController();
    const extraction = extractPdfTextInWorker(createPdf("CV de test"), {
      signal: controller.signal,
      timeoutMs: 5_000,
      maxPages: 10,
      maxTextLength: 30_000,
    });

    controller.abort(new DOMException("Requête annulée", "AbortError"));

    await expect(extraction).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuse un PDF malformé sans affecter l’analyse suivante", async () => {
    const hostile = Uint8Array.from(
      Buffer.from(
        "%PDF-1.7\n1 0 obj\n<< /Length 999999999 /Filter /FlateDecode >>\nstream\ninvalid\nendstream\n",
      ),
    );
    const options = {
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      maxPages: 10,
      maxTextLength: 30_000,
    };

    await expect(extractPdfTextInWorker(hostile, options)).rejects.toThrow(
      "Le PDF n’a pas pu être analysé.",
    );
    await expect(
      extractPdfTextInWorker(createPdf("CV encore disponible"), options),
    ).resolves.toEqual({ pages: 1, text: "CV encore disponible" });
  });

  it("borne la sortie d’un flux fortement compressé", async () => {
    const result = await extractPdfTextInWorker(
      createCompressedPdf(2_000_000),
      {
        signal: new AbortController().signal,
        timeoutMs: 5_000,
        maxPages: 10,
        maxTextLength: 512,
      },
    );

    expect(result.pages).toBe(1);
    expect(result.text.length).toBeLessThanOrEqual(512);
  });

  it("refuse l’entrée avant lancement au-delà de 5 Mio", () => {
    expect(() =>
      extractPdfTextInWorker(new Uint8Array(5 * 1024 * 1024 + 1), {
        signal: new AbortController().signal,
        timeoutMs: 5_000,
        maxPages: 10,
        maxTextLength: 30_000,
      }),
    ).toThrow("Le PDF dépasse la taille maximale autorisée.");
  });
});

function createCompressedPdf(textLength: number): Uint8Array<ArrayBuffer> {
  const content = `BT\n/F1 12 Tf\n72 720 Td\n(${"A".repeat(textLength)}) Tj\nET`;
  const compressed = deflateSync(Buffer.from(content));
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${compressed.byteLength} /Filter /FlateDecode >>\nstream\n${compressed.toString("latin1")}\nendstream`,
  ];

  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return Uint8Array.from(Buffer.from(pdf, "latin1"));
}

function createPdf(text: string): Uint8Array<ArrayBuffer> {
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
  const content = `BT\n/F1 12 Tf\n72 720 Td\n(${escaped}) Tj\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "binary"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return Uint8Array.from(Buffer.from(pdf, "binary"));
}
