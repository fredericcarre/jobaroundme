export class RequestBodyTooLargeError extends Error {
  constructor(readonly maximumBytes: number) {
    super(`Le corps de la requête dépasse ${maximumBytes} octets.`);
    this.name = "RequestBodyTooLargeError";
  }
}

export class RequestBodyTimeoutError extends Error {
  constructor() {
    super("Le corps de la requête n’a pas été reçu dans le délai prévu.");
    this.name = "RequestBodyTimeoutError";
  }
}

interface ReadRequestBodyOptions {
  totalTimeoutMs?: number;
}

/**
 * Reads an HTTP request without trusting Content-Length. This also bounds
 * chunked uploads before a JSON or multipart parser can retain them in memory.
 */
export async function readBoundedRequestBody(
  request: Request,
  maximumBytes: number,
  options: ReadRequestBodyOptions = {},
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("La taille maximale doit être un entier positif.");
  }

  const declaredLength = Number.parseInt(
    request.headers.get("content-length") ?? "",
    10,
  );
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    if (request.body && !request.body.locked) {
      await request.body.cancel().catch(() => undefined);
    }
    throw new RequestBodyTooLargeError(maximumBytes);
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const timeoutMs = Math.max(
    100,
    Math.min(60_000, options.totalTimeoutMs ?? 10_000),
  );
  const deadlineAt = Date.now() + timeoutMs;

  try {
    while (true) {
      request.signal.throwIfAborted();
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) throw new RequestBodyTimeoutError();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortListener: (() => void) | undefined;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new RequestBodyTimeoutError()),
            remainingMs,
          );
        }),
        new Promise<never>((_resolve, reject) => {
          abortListener = () =>
            reject(
              request.signal.reason ??
                new DOMException("Aborted", "AbortError"),
            );
          request.signal.addEventListener("abort", abortListener, {
            once: true,
          });
          if (request.signal.aborted) abortListener();
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
        if (abortListener) {
          request.signal.removeEventListener("abort", abortListener);
        }
      });
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new RequestBodyTooLargeError(maximumBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
