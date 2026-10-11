import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const MAX_PDF_INPUT_BYTES = 5 * 1024 * 1024;
const MAX_PDF_PAGES = 10;
const MAX_PDF_TEXT_LENGTH = 30_000;
const MAX_EXTRACTION_TIMEOUT_MS = 30_000;

const NODE_OLD_SPACE_MIB = 128;
const NODE_YOUNG_SPACE_MIB = 16;
const LINUX_ADDRESS_SPACE_BYTES = 2 * 1024 * 1024 * 1024;
const LINUX_DATA_SPACE_BYTES = 768 * 1024 * 1024;

const requireFromProject = createRequire(`${process.cwd()}/package.json`);
const unpdfEntry = requireFromProject.resolve("unpdf");
const unpdfPackageRoot = dirname(dirname(unpdfEntry));
const pdfChildEntry = requireFromProject.resolve(
  "./lib/pdf-extractor-child.cjs",
);
const prlimitEntry = findPrlimit();

interface PdfWorkerSuccess {
  ok: true;
  text: string;
  pages: number;
}

interface PdfWorkerFailure {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

type PdfWorkerMessage = PdfWorkerSuccess | PdfWorkerFailure;

interface PdfExtractionOptions {
  signal: AbortSignal;
  timeoutMs: number;
  maxPages: number;
  maxTextLength: number;
}

/**
 * Runs PDF.js in a fresh, disposable process. The child gets no environment,
 * cannot read outside the parser bundle, cannot write files, load native
 * addons, start workers or spawn descendants, and is force-killed on abort or
 * timeout. Linux hosts with util-linux also enforce address/data-space limits
 * around V8 so external/native allocations cannot exhaust the Next.js server.
 *
 * The historical function name is kept because the route already treats it as
 * its extraction boundary. It no longer creates an in-process Worker thread.
 * Every outcome waits for the child to close before the route may release its
 * existing concurrency permit.
 */
export function extractPdfTextInWorker(
  bytes: Uint8Array<ArrayBuffer>,
  options: PdfExtractionOptions,
): Promise<{ text: string; pages: number }> {
  validateRequest(bytes, options);
  options.signal.throwIfAborted();

  const nodeArguments = [
    `--max-old-space-size=${NODE_OLD_SPACE_MIB}`,
    `--max-semi-space-size=${NODE_YOUNG_SPACE_MIB}`,
    "--stack-size=2048",
    "--no-addons",
    "--disable-proto=throw",
    "--permission",
    `--allow-fs-read=${pdfChildEntry}`,
    `--allow-fs-read=${unpdfPackageRoot}`,
    pdfChildEntry,
    unpdfEntry,
    String(options.maxPages),
    String(options.maxTextLength),
  ];

  const cpuSeconds = Math.max(2, Math.ceil(options.timeoutMs / 1_000) + 1);
  const executable = prlimitEntry ?? process.execPath;
  const childArguments = prlimitEntry
    ? [
        `--as=${LINUX_ADDRESS_SPACE_BYTES}`,
        `--data=${LINUX_DATA_SPACE_BYTES}`,
        "--core=0",
        `--cpu=${cpuSeconds}`,
        "--fsize=0",
        "--nofile=64",
        "--stack=4194304",
        "--",
        process.execPath,
        ...nodeArguments,
      ]
    : nodeArguments;

  const child = spawn(/* turbopackIgnore: true */ executable, childArguments, {
    cwd: dirname(pdfChildEntry),
    env: Object.create(null) as NodeJS.ProcessEnv,
    serialization: "advanced",
    shell: false,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });

  return new Promise((resolve, reject) => {
    let response: unknown;
    let receivedResponse = false;
    let forcedError: unknown;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      child.removeAllListeners();
    };

    const kill = (error: unknown) => {
      if (forcedError === undefined) forcedError = error;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    };

    const onAbort = () => {
      kill(abortReason(options.signal));
    };

    const timer = setTimeout(() => {
      kill(new Error("Le PDF a dépassé le temps maximal d’analyse."));
    }, options.timeoutMs);
    timer.unref?.();

    child.on("message", (message: unknown) => {
      if (receivedResponse) {
        kill(new Error("Le processus d’analyse du PDF a répondu plusieurs fois."));
        return;
      }
      receivedResponse = true;
      response = message;
    });

    child.once("error", (error) => {
      kill(error);
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (forcedError !== undefined) {
        reject(forcedError);
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `Le processus d’analyse du PDF s’est arrêté prématurément (${signal ?? code ?? "inconnu"}).`,
          ),
        );
        return;
      }

      if (!receivedResponse) {
        reject(
          new Error(
            "Le processus d’analyse du PDF a renvoyé une réponse invalide.",
          ),
        );
        return;
      }

      const parsed = parseWorkerMessage(response, options);
      if (parsed.ok) {
        resolve({ text: parsed.text, pages: parsed.pages });
        return;
      }

      reject(
        parsed.error.code === "PDF_TOO_MANY_PAGES"
          ? new Error(`Le PDF dépasse la limite de ${options.maxPages} pages.`)
          : new Error("Le PDF n’a pas pu être analysé."),
      );
    });

    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();

    if (forcedError === undefined) {
      try {
        child.send(
          {
            bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          },
          (error) => {
            if (error) kill(error);
          },
        );
      } catch (error) {
        kill(error);
      }
    }
  });
}

function validateRequest(
  bytes: Uint8Array<ArrayBuffer>,
  options: PdfExtractionOptions,
): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PDF_INPUT_BYTES) {
    throw new Error("Le PDF dépasse la taille maximale autorisée.");
  }
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > MAX_EXTRACTION_TIMEOUT_MS ||
    !Number.isSafeInteger(options.maxPages) ||
    options.maxPages < 1 ||
    options.maxPages > MAX_PDF_PAGES ||
    !Number.isSafeInteger(options.maxTextLength) ||
    options.maxTextLength < 1 ||
    options.maxTextLength > MAX_PDF_TEXT_LENGTH
  ) {
    throw new Error("Les limites de l’analyse PDF sont invalides.");
  }
}

function parseWorkerMessage(
  value: unknown,
  options: PdfExtractionOptions,
): PdfWorkerMessage {
  if (!value || typeof value !== "object") {
    return {
      ok: false,
      error: { code: "PDF_PARSE_FAILED", message: "Invalid child response" },
    };
  }

  const record = value as Record<string, unknown>;
  if (
    record.ok === true &&
    typeof record.text === "string" &&
    record.text.length <= options.maxTextLength &&
    Number.isSafeInteger(record.pages) &&
    Number(record.pages) >= 1 &&
    Number(record.pages) <= options.maxPages
  ) {
    return {
      ok: true,
      text: record.text,
      pages: Number(record.pages),
    };
  }

  const error =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : {};
  return {
    ok: false,
    error: {
      code:
        typeof error.code === "string" ? error.code : "PDF_PARSE_FAILED",
      message: typeof error.message === "string" ? error.message : "",
    },
  };
}

function abortReason(signal: AbortSignal): Error | DOMException {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("Aborted", "AbortError");
}

function findPrlimit(): string | undefined {
  if (process.platform !== "linux") return undefined;
  for (const candidate of ["/usr/bin/prlimit", "/bin/prlimit"]) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      // Some container policies expose util-linux but forbid executing it from
      // the application process. Probe once so extraction can still use the
      // V8/process isolation fallback instead of returning an empty child.
      const probe = spawnSync(/* turbopackIgnore: true */ candidate, ["--version"], {
        env: Object.create(null) as NodeJS.ProcessEnv,
        stdio: "ignore",
        timeout: 1_000,
      });
      if (!probe.error && probe.status === 0) return candidate;
    } catch {
      // Try the next fixed system path. PATH is intentionally not trusted.
    }
  }
  return undefined;
}
