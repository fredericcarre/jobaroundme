import Busboy, { type BusboyFileStream } from "@fastify/busboy";

import {
  RequestBodyTimeoutError,
  RequestBodyTooLargeError,
} from "@/lib/request-body";

const FEED_CHUNK_SIZE = 64 * 1024;
const FILE_STORAGE_BLOCK_SIZE = 64 * 1024;
const HEADER_TERMINATOR = new Uint8Array([13, 10, 13, 10]);

export class InvalidMultipartFormError extends Error {
  constructor(message = "Le formulaire multipart envoyé est invalide.") {
    super(message);
    this.name = "InvalidMultipartFormError";
  }
}

export class UnsupportedMultipartMediaTypeError extends Error {
  constructor() {
    super("Le formulaire doit utiliser multipart/form-data.");
    this.name = "UnsupportedMultipartMediaTypeError";
  }
}

export class MultipartFileTooLargeError extends Error {
  constructor(readonly maximumBytes: number) {
    super(`Le fichier dépasse ${maximumBytes} octets.`);
    this.name = "MultipartFileTooLargeError";
  }
}

export interface SingleMultipartFile {
  bytes: Uint8Array<ArrayBuffer>;
  fileName: string;
  mimeType: string;
}

interface ReadSingleMultipartFileOptions {
  fieldName: string;
  maximumFileBytes: number;
  maximumHeaderBytes?: number;
  maximumHeaderPairs?: number;
  maximumRequestBytes: number;
  totalTimeoutMs?: number;
}

/**
 * Reads one multipart file while keeping parser, part, header and byte limits
 * active before the uploaded file is materialised as a contiguous buffer.
 */
export async function readSingleMultipartFile(
  request: Request,
  options: ReadSingleMultipartFileOptions,
): Promise<SingleMultipartFile> {
  validateOptions(options);

  const contentType = request.headers.get("content-type") ?? "";
  const maximumHeaderBytes = options.maximumHeaderBytes ?? 8 * 1024;
  const maximumHeaderPairs = options.maximumHeaderPairs ?? 8;
  const timeoutMs = Math.max(
    100,
    Math.min(60_000, options.totalTimeoutMs ?? 10_000),
  );
  const deadlineAt = Date.now() + timeoutMs;

  rejectOversizedDeclaredBody(request, options.maximumRequestBytes);
  let boundary: string;
  try {
    boundary = parseMultipartBoundary(contentType);
  } catch (error) {
    cancelRequestBody(request);
    throw error;
  }
  if (!request.body) throw new InvalidMultipartFormError();

  const firstHeader = new FirstPartHeaderGuard(
    boundary,
    maximumHeaderBytes,
    maximumHeaderPairs,
  );
  const parser = Busboy({
    fileHwm: FEED_CHUNK_SIZE,
    headers: { "content-type": contentType },
    highWaterMark: FEED_CHUNK_SIZE,
    isPartAFile: (_fieldName, _partType, fileName) =>
      fileName !== undefined,
    limits: {
      fields: 0,
      fieldNameSize: 64,
      fieldSize: 0,
      files: 1,
      fileSize: options.maximumFileBytes,
      headerPairs: maximumHeaderPairs,
      headerSize: maximumHeaderBytes,
      parts: 1,
    },
  });

  const fileStorage = new BoundedFileStorage(options.maximumFileBytes);
  let fileBytes = 0;
  let fileEnded = false;
  let fileName = "";
  let mimeType = "";
  let seenFiles = 0;
  let failure: unknown;
  let parserFinished = false;

  const fail = (error: unknown) => {
    failure ??= error;
  };

  parser.on("file", (fieldName, stream, name, _encoding, partType) => {
    seenFiles += 1;
    if (
      seenFiles !== 1 ||
      fieldName !== options.fieldName ||
      !isSafeFileName(name)
    ) {
      fail(
        new InvalidMultipartFormError(
          "Le formulaire doit contenir uniquement le fichier CV.",
        ),
      );
      stream.resume();
      return;
    }

    fileName = name;
    mimeType = partType;
    consumeFileStream(stream, fileStorage, {
      onBytes(count) {
        fileBytes += count;
      },
      onEnd() {
        fileEnded = true;
      },
      onError: fail,
      onLimit() {
        fail(new MultipartFileTooLargeError(options.maximumFileBytes));
      },
    });
  });
  parser.on("field", () => {
    fail(
      new InvalidMultipartFormError(
        "Les champs supplémentaires ne sont pas autorisés.",
      ),
    );
  });
  parser.on("fieldsLimit", () => {
    fail(
      new InvalidMultipartFormError(
        "Les champs supplémentaires ne sont pas autorisés.",
      ),
    );
  });
  parser.on("filesLimit", () => {
    fail(new InvalidMultipartFormError("Un seul fichier CV est autorisé."));
  });
  parser.on("partsLimit", () => {
    fail(new InvalidMultipartFormError("Une seule partie multipart est autorisée."));
  });

  const parserCompletion = new Promise<void>((resolve) => {
    parser.once("error", (error) => {
      fail(
        error instanceof Error
          ? new InvalidMultipartFormError(error.message)
          : new InvalidMultipartFormError(),
      );
      resolve();
    });
    parser.once("finish", () => {
      parserFinished = true;
      resolve();
    });
  });

  const reader = request.body.getReader();
  let requestBytes = 0;
  let bodyRead = false;

  try {
    while (true) {
      throwIfFailed(failure);
      const { done, value } = await waitWithinDeadline(
        reader.read(),
        request.signal,
        deadlineAt,
      );
      if (done) {
        bodyRead = true;
        break;
      }

      requestBytes += value.byteLength;
      if (requestBytes > options.maximumRequestBytes) {
        throw new RequestBodyTooLargeError(options.maximumRequestBytes);
      }

      for (let offset = 0; offset < value.byteLength; offset += FEED_CHUNK_SIZE) {
        const chunk = value.subarray(
          offset,
          Math.min(value.byteLength, offset + FEED_CHUNK_SIZE),
        );
        firstHeader.push(chunk);
        const canContinue = parser.write(chunk);
        throwIfFailed(failure);
        if (!canContinue) {
          await waitForDrain(parser, request.signal, deadlineAt);
          throwIfFailed(failure);
        }
      }
    }

    firstHeader.finish();
    parser.end();
    await waitWithinDeadline(parserCompletion, request.signal, deadlineAt);
    throwIfFailed(failure);

    if (!parserFinished || seenFiles !== 1 || !fileEnded || fileBytes === 0) {
      throw new InvalidMultipartFormError(
        "Le formulaire doit contenir exactement un fichier CV non vide.",
      );
    }

    return { bytes: fileStorage.materialise(), fileName, mimeType };
  } catch (error) {
    if (!bodyRead) void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A hostile source may leave cancel() and its pending read unresolved.
    }
    if (!parser.destroyed) parser.destroy();
  }
}

function consumeFileStream(
  stream: BusboyFileStream,
  storage: BoundedFileStorage,
  handlers: {
    onBytes: (count: number) => void;
    onEnd: () => void;
    onError: (error: unknown) => void;
    onLimit: () => void;
  },
) {
  stream.on("data", (chunk: Buffer) => {
    if (!storage.append(chunk)) {
      handlers.onLimit();
      return;
    }
    handlers.onBytes(chunk.byteLength);
  });
  stream.once("end", handlers.onEnd);
  stream.once("error", handlers.onError);
  stream.once("limit", handlers.onLimit);
}

/**
 * Stores uploaded bytes in a bounded number of fixed-size blocks. A hostile
 * transport can split a file into one-byte chunks without making us retain one
 * allocation and one array entry for every emitted chunk.
 */
class BoundedFileStorage {
  private readonly blocks: Uint8Array<ArrayBuffer>[] = [];
  private storedBytes = 0;

  constructor(private readonly maximumBytes: number) {}

  append(chunk: Uint8Array): boolean {
    if (chunk.byteLength > this.maximumBytes - this.storedBytes) return false;

    let sourceOffset = 0;
    while (sourceOffset < chunk.byteLength) {
      const blockIndex = Math.floor(
        this.storedBytes / FILE_STORAGE_BLOCK_SIZE,
      );
      const blockOffset = this.storedBytes % FILE_STORAGE_BLOCK_SIZE;
      let block = this.blocks[blockIndex];

      if (!block) {
        const blockLength = Math.min(
          FILE_STORAGE_BLOCK_SIZE,
          this.maximumBytes - blockIndex * FILE_STORAGE_BLOCK_SIZE,
        );
        block = new Uint8Array(blockLength);
        this.blocks.push(block);
      }

      const bytesToCopy = Math.min(
        chunk.byteLength - sourceOffset,
        block.byteLength - blockOffset,
      );
      if (sourceOffset === 0 && bytesToCopy === chunk.byteLength) {
        block.set(chunk, blockOffset);
      } else {
        block.set(
          chunk.subarray(sourceOffset, sourceOffset + bytesToCopy),
          blockOffset,
        );
      }
      sourceOffset += bytesToCopy;
      this.storedBytes += bytesToCopy;
    }

    return true;
  }

  materialise(): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(this.storedBytes);
    let destinationOffset = 0;

    for (const block of this.blocks) {
      const bytesToCopy = Math.min(
        block.byteLength,
        this.storedBytes - destinationOffset,
      );
      bytes.set(block.subarray(0, bytesToCopy), destinationOffset);
      destinationOffset += bytesToCopy;
    }

    return bytes;
  }
}

class FirstPartHeaderGuard {
  private readonly expectedPrefix: Uint8Array;
  private readonly header: Uint8Array;
  private headerLength = 0;
  private prefixOffset = 0;
  private terminatorOffset = 0;
  private complete = false;

  constructor(
    boundary: string,
    private readonly maximumHeaderBytes: number,
    private readonly maximumHeaderPairs: number,
  ) {
    this.expectedPrefix = new TextEncoder().encode(`--${boundary}\r\n`);
    this.header = new Uint8Array(maximumHeaderBytes);
  }

  push(chunk: Uint8Array) {
    if (this.complete) return;

    for (const byte of chunk) {
      if (this.prefixOffset < this.expectedPrefix.byteLength) {
        if (byte !== this.expectedPrefix[this.prefixOffset]) {
          throw new InvalidMultipartFormError(
            "La délimitation multipart est invalide.",
          );
        }
        this.prefixOffset += 1;
        continue;
      }

      if (this.headerLength >= this.maximumHeaderBytes) {
        throw new InvalidMultipartFormError(
          "Les en-têtes de la partie multipart sont trop longs.",
        );
      }
      this.header[this.headerLength] = byte;
      this.headerLength += 1;

      if (byte === HEADER_TERMINATOR[this.terminatorOffset]) {
        this.terminatorOffset += 1;
      } else {
        this.terminatorOffset = byte === HEADER_TERMINATOR[0] ? 1 : 0;
      }

      if (this.terminatorOffset === HEADER_TERMINATOR.byteLength) {
        this.complete = true;
        this.validateHeaderPairs();
        return;
      }
    }
  }

  finish() {
    if (!this.complete) {
      throw new InvalidMultipartFormError("Les en-têtes multipart sont incomplets.");
    }
  }

  private validateHeaderPairs() {
    const headerText = Buffer.from(
      this.header.subarray(0, this.headerLength - HEADER_TERMINATOR.byteLength),
    ).toString("latin1");
    const lines = headerText.split("\r\n");

    if (
      lines.length === 0 ||
      lines.length > this.maximumHeaderPairs ||
      lines.some(
        (line) =>
          line.length === 0 ||
          /^[ \t]/.test(line) ||
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[\t\x20-\xFF]*$/.test(line),
      )
    ) {
      throw new InvalidMultipartFormError(
        "Les en-têtes de la partie multipart sont invalides.",
      );
    }
  }
}

function parseMultipartBoundary(contentType: string): string {
  if (contentType.length > 256) {
    throw new UnsupportedMultipartMediaTypeError();
  }
  if (!/^[ \t]*multipart\/form-data(?:[ \t]*;|[ \t]*$)/i.test(contentType)) {
    throw new UnsupportedMultipartMediaTypeError();
  }

  const match = contentType.match(
    /^[ \t]*multipart\/form-data[ \t]*;[ \t]*boundary[ \t]*=[ \t]*(?:"([^"]*)"|([^; \t]+))[ \t]*$/i,
  );
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || !isValidBoundary(boundary)) {
    throw new InvalidMultipartFormError("La boundary multipart est absente ou invalide.");
  }
  return boundary;
}

function isValidBoundary(boundary: string): boolean {
  if (boundary.length < 1 || boundary.length > 70 || boundary.endsWith(" ")) {
    return false;
  }
  return /^[0-9A-Za-z'()+_,\-./:=?][0-9A-Za-z'()+_,\-./:=? ]*$/.test(
    boundary,
  );
}

function isSafeFileName(fileName: string): boolean {
  return (
    fileName.length > 0 &&
    fileName.length <= 255 &&
    !/[\u0000-\u001f\u007f]/.test(fileName)
  );
}

function rejectOversizedDeclaredBody(
  request: Request,
  maximumBytes: number,
) {
  const rawLength = request.headers.get("content-length");
  if (rawLength === null) return;
  if (!/^\d+$/.test(rawLength)) {
    cancelRequestBody(request);
    throw new InvalidMultipartFormError();
  }

  const declaredLength = Number(rawLength);
  if (!Number.isSafeInteger(declaredLength)) {
    cancelRequestBody(request);
    throw new RequestBodyTooLargeError(maximumBytes);
  }
  if (declaredLength > maximumBytes) {
    cancelRequestBody(request);
    throw new RequestBodyTooLargeError(maximumBytes);
  }
}

function cancelRequestBody(request: Request) {
  if (request.body && !request.body.locked) {
    void request.body.cancel().catch(() => undefined);
  }
}

function throwIfFailed(failure: unknown): asserts failure is undefined {
  if (failure !== undefined) throw failure;
}

function waitForDrain(
  parser: NodeJS.WritableStream,
  signal: AbortSignal,
  deadlineAt: number,
) {
  return waitWithinDeadline(
    new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (error: unknown) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        parser.removeListener("drain", onDrain);
        parser.removeListener("error", onError);
      };
      parser.once("drain", onDrain);
      parser.once("error", onError);
    }),
    signal,
    deadlineAt,
  );
}

async function waitWithinDeadline<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<T> {
  signal.throwIfAborted();
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new RequestBodyTimeoutError();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RequestBodyTimeoutError()), remainingMs);
    }),
    new Promise<never>((_resolve, reject) => {
      abortListener = () =>
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) abortListener();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
    if (abortListener) signal.removeEventListener("abort", abortListener);
  });
}

function validateOptions(options: ReadSingleMultipartFileOptions) {
  for (const value of [
    options.maximumFileBytes,
    options.maximumRequestBytes,
    options.maximumHeaderBytes ?? 8 * 1024,
    options.maximumHeaderPairs ?? 8,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError("Les limites multipart doivent être des entiers positifs.");
    }
  }
  if (!options.fieldName) {
    throw new TypeError("Le nom du champ multipart est obligatoire.");
  }
}
