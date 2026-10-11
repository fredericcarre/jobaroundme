import { NextResponse } from "next/server";

import { analyzeCvProfile } from "@/lib/cv-profile";
import {
  InvalidMultipartFormError,
  MultipartFileTooLargeError,
  readSingleMultipartFile,
  type SingleMultipartFile,
  UnsupportedMultipartMediaTypeError,
} from "@/lib/multipart";
import { extractPdfTextInWorker } from "@/lib/pdf-extractor";
import {
  consumeHierarchicalRateLimit,
  InMemoryRateLimiter,
  searchClientIdentifier,
} from "@/lib/search-guard";
import {
  RequestBodyTimeoutError,
  RequestBodyTooLargeError,
} from "@/lib/request-body";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_MULTIPART_OVERHEAD = 256 * 1024;
const MAX_REQUEST_SIZE = MAX_FILE_SIZE + MAX_MULTIPART_OVERHEAD;
const MAX_PAGES = 10;
const MAX_TEXT_LENGTH = 30_000;
const PDF_EXTRACTION_TIMEOUT_MS = 8_000;
const PRIVATE_RESPONSE_HEADERS = { "Cache-Control": "private, no-store" };
const cvRateLimiter = new InMemoryRateLimiter(6, 60_000);
const cvGlobalRateLimiter = new InMemoryRateLimiter(30, 60_000, 1);
const MAX_CONCURRENT_CV_UPLOADS = 4;
const MAX_CONCURRENT_PDF_EXTRACTIONS = 2;
let activeCvUploads = 0;
let activePdfExtractions = 0;

function cleanCvText(value: string) {
  return value
    .replace(/\u0000/g, "")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

function hasPdfSignature(bytes: Uint8Array) {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

async function withPdfExtractionTimeout(
  bytes: Uint8Array<ArrayBuffer>,
  requestSignal: AbortSignal,
) {
  return extractPdfTextInWorker(bytes, {
    signal: requestSignal,
    timeoutMs: PDF_EXTRACTION_TIMEOUT_MS,
    maxPages: MAX_PAGES,
    maxTextLength: MAX_TEXT_LENGTH,
  });
}

export async function POST(request: Request) {
  if (request.signal.aborted) {
    await cancelUnreadBody(request);
    return abortedResponse();
  }

  if (isExplicitlyCrossSite(request.headers)) {
    await cancelUnreadBody(request);
    return NextResponse.json(
      { error: "Les requêtes provenant d’un autre site ne sont pas autorisées." },
      { status: 403, headers: PRIVATE_RESPONSE_HEADERS },
    );
  }

  const admission = consumeHierarchicalRateLimit(
    cvGlobalRateLimiter,
    "all-clients",
    cvRateLimiter,
    () => searchClientIdentifier(request.headers),
  );
  if (admission.scope === "global") {
    await cancelUnreadBody(request);
    return NextResponse.json(
      {
        error:
          "Le service analyse beaucoup de CV en ce moment. Réessayez dans un instant.",
      },
      {
        status: 429,
        headers: {
          ...PRIVATE_RESPONSE_HEADERS,
          "Retry-After": String(admission.global.retryAfterSeconds),
        },
      },
    );
  }
  if (admission.scope === "client") {
    await cancelUnreadBody(request);
    return NextResponse.json(
      { error: "Trop de CV ont été analysés récemment. Réessayez dans un instant." },
      {
        status: 429,
        headers: {
          ...PRIVATE_RESPONSE_HEADERS,
          "Retry-After": String(admission.client.retryAfterSeconds),
        },
      },
    );
  }

  if (activeCvUploads >= MAX_CONCURRENT_CV_UPLOADS) {
    await cancelUnreadBody(request);
    return NextResponse.json(
      {
        error:
          "Le service reçoit déjà plusieurs CV. Réessayez dans quelques secondes.",
      },
      {
        status: 503,
        headers: { ...PRIVATE_RESPONSE_HEADERS, "Retry-After": "3" },
      },
    );
  }

  activeCvUploads += 1;
  try {
    return await handleCvUpload(request);
  } finally {
    activeCvUploads -= 1;
  }
}

async function handleCvUpload(request: Request) {
  let candidate: SingleMultipartFile;

  try {
    candidate = await readSingleMultipartFile(request, {
      fieldName: "cv",
      maximumFileBytes: MAX_FILE_SIZE,
      maximumHeaderBytes: 8 * 1024,
      maximumHeaderPairs: 8,
      maximumRequestBytes: MAX_REQUEST_SIZE,
      totalTimeoutMs: 12_000,
    });
  } catch (error) {
    if (request.signal.aborted || isAbortError(error)) {
      return abortedResponse();
    }
    if (
      error instanceof RequestBodyTooLargeError ||
      error instanceof MultipartFileTooLargeError
    ) {
      return NextResponse.json(
        { error: "La requête dépasse la limite autorisée pour un CV de 5 Mo." },
        { status: 413, headers: PRIVATE_RESPONSE_HEADERS },
      );
    }
    if (error instanceof RequestBodyTimeoutError) {
      return NextResponse.json(
        { error: "Le téléversement du CV a mis trop de temps à arriver." },
        { status: 408, headers: PRIVATE_RESPONSE_HEADERS },
      );
    }
    if (error instanceof UnsupportedMultipartMediaTypeError) {
      return NextResponse.json(
        { error: "Envoyez le CV avec un formulaire multipart/form-data." },
        { status: 415, headers: PRIVATE_RESPONSE_HEADERS },
      );
    }
    if (error instanceof InvalidMultipartFormError) {
      return NextResponse.json(
        { error: "Le formulaire doit contenir exactement un fichier nommé cv." },
        { status: 400, headers: PRIVATE_RESPONSE_HEADERS },
      );
    }
    return NextResponse.json(
      { error: "Le formulaire envoyé est invalide." },
      { status: 400, headers: PRIVATE_RESPONSE_HEADERS },
    );
  }

  if (
    candidate.bytes.byteLength === 0 ||
    candidate.bytes.byteLength > MAX_FILE_SIZE
  ) {
    return NextResponse.json(
      { error: "Le CV doit peser entre 1 octet et 5 Mo." },
      { status: 400, headers: PRIVATE_RESPONSE_HEADERS },
    );
  }

  try {
    const bytes = candidate.bytes;
    let text: string;
    let pages: number | undefined;

    if (hasPdfSignature(bytes)) {
      if (activePdfExtractions >= MAX_CONCURRENT_PDF_EXTRACTIONS) {
        return NextResponse.json(
          {
            error:
              "Le service analyse déjà plusieurs PDF. Réessayez dans quelques secondes.",
          },
          {
            status: 503,
            headers: { ...PRIVATE_RESPONSE_HEADERS, "Retry-After": "3" },
          },
        );
      }
      activePdfExtractions += 1;
      try {
        const parsed = await withPdfExtractionTimeout(bytes, request.signal);
        text = parsed.text;
        pages = parsed.pages;
      } finally {
        activePdfExtractions -= 1;
      }
    } else if (
      candidate.mimeType === "text/plain" ||
      candidate.fileName.toLocaleLowerCase("fr").endsWith(".txt")
    ) {
      text = cleanCvText(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } else {
      return NextResponse.json(
        { error: "Ce fichier n’est ni un PDF valide ni un fichier texte." },
        { status: 415, headers: PRIVATE_RESPONSE_HEADERS },
      );
    }

    if (text.length < 30) {
      return NextResponse.json(
        {
          error:
            "Le CV ne contient pas assez de texte exploitable. Un PDF scanné doit d’abord être converti avec OCR.",
        },
        { status: 422, headers: PRIVATE_RESPONSE_HEADERS },
      );
    }

    return NextResponse.json(
      {
        fileName: candidate.fileName,
        profile: analyzeCvProfile(text),
        pages,
        characters: text.length,
        retention: "Le fichier et son texte ne sont pas conservés par le serveur.",
      },
      { headers: PRIVATE_RESPONSE_HEADERS },
    );
  } catch (error) {
    if (request.signal.aborted || isAbortError(error)) {
      return abortedResponse();
    }
    const message =
      error instanceof Error &&
      (error.message.startsWith("Le PDF dépasse") ||
        error.message.startsWith("Le PDF a dépassé"))
        ? error.message
        : "Le CV n’a pas pu être lu. Essayez un PDF contenant du texte ou un fichier .txt.";

    return NextResponse.json(
      { error: message },
      { status: 422, headers: PRIVATE_RESPONSE_HEADERS },
    );
  }
}

function cancelUnreadBody(request: Request): void {
  if (!request.body || request.body.locked) return;
  void request.body.cancel().catch(() => undefined);
}

function abortedResponse(): Response {
  return new Response(null, {
    status: 499,
    headers: PRIVATE_RESPONSE_HEADERS,
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isExplicitlyCrossSite(headers: Headers): boolean {
  return headers.get("sec-fetch-site")?.trim().toLowerCase() === "cross-site";
}
