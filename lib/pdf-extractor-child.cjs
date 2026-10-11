"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- Node launches this isolated entry point as CommonJS. */

/*
 * This file is deliberately plain CommonJS. The API launches it in a fresh
 * Node process for every PDF so a parser crash or native allocation cannot
 * corrupt the long-lived Next.js process.
 */

const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const MAX_PAGES = 10;
const MAX_TEXT_LENGTH = 30_000;

function sandboxError(message) {
  const error = new Error(message);
  error.code = "PDF_SANDBOX_VIOLATION";
  return error;
}

function installNetworkGuards() {
  const blockSync = () => {
    throw sandboxError("Network access is disabled in the PDF sandbox");
  };
  const blockAsync = async () => {
    throw sandboxError("Network access is disabled in the PDF sandbox");
  };
  const disableMethod = (target, method) => {
    if (!target || typeof target[method] !== "function") return;
    Object.defineProperty(target, method, {
      configurable: false,
      enumerable: true,
      value: blockSync,
      writable: false,
    });
  };

  // Node's permission model currently protects files, processes, workers and
  // native addons, but does not expose a portable network permission. These
  // guards remove every public network entry point before unpdf is loaded.
  for (const [moduleName, methods] of [
    ["node:net", ["connect", "createConnection", "createServer"]],
    ["node:tls", ["connect"]],
    ["node:http", ["get", "request", "createServer"]],
    ["node:https", ["get", "request", "createServer"]],
    ["node:http2", ["connect", "createServer", "createSecureServer"]],
    ["node:dgram", ["createSocket"]],
  ]) {
    const networkModule = require(moduleName);
    for (const method of methods) {
      disableMethod(networkModule, method);
    }
  }

  const net = require("node:net");
  disableMethod(net.Socket?.prototype, "connect");
  disableMethod(net.Server?.prototype, "listen");

  const dgram = require("node:dgram");
  for (const method of ["bind", "connect", "send"]) {
    disableMethod(dgram.Socket?.prototype, method);
  }

  const dns = require("node:dns");
  const dnsMethods = [
    "lookup",
    "lookupService",
    "resolve",
    "resolve4",
    "resolve6",
    "resolveAny",
    "resolveCaa",
    "resolveCname",
    "resolveMx",
    "resolveNaptr",
    "resolveNs",
    "resolvePtr",
    "resolveSoa",
    "resolveSrv",
    "resolveTxt",
    "reverse",
  ];
  for (const method of dnsMethods) {
    disableMethod(dns, method);
    disableMethod(dns.promises, method);
    disableMethod(dns.Resolver?.prototype, method);
  }
  const dnsPromises = require("node:dns/promises");
  for (const method of dnsMethods) {
    disableMethod(dnsPromises, method);
    disableMethod(dnsPromises.Resolver?.prototype, method);
  }

  Object.defineProperty(globalThis, "fetch", {
    configurable: false,
    value: blockAsync,
    writable: false,
  });
  if ("WebSocket" in globalThis) {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: false,
      value: undefined,
      writable: false,
    });
  }
}

function parseInteger(value, minimum, maximum) {
  if (!/^[0-9]+$/.test(value ?? "")) throw sandboxError("Invalid limit");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw sandboxError("Invalid limit");
  }
  return parsed;
}

async function readInput() {
  return await new Promise((resolve, reject) => {
    process.once("disconnect", () => reject(sandboxError("PDF_INPUT_ABORTED")));
    process.once("message", (message) => {
      const bytes = message?.bytes;
      if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
        reject(sandboxError("PDF_INPUT_INVALID"));
        return;
      }
      if (bytes.byteLength === 0) {
        reject(sandboxError("PDF_INPUT_EMPTY"));
        return;
      }
      if (bytes.byteLength > MAX_INPUT_BYTES) {
        reject(sandboxError("PDF_INPUT_TOO_LARGE"));
        return;
      }
      // IPC advanced serialization already creates child-owned backing memory.
      resolve(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    });
  });
}

async function destroyDocument(document) {
  try {
    if (document && typeof document.destroy === "function") {
      await document.destroy();
    }
  } catch {
    // The process exits immediately after its response, so cleanup errors are
    // less important than preserving the original parser result.
  }
}

function serializeFailure(error) {
  if (error && typeof error === "object") {
    return {
      code:
        typeof error.code === "string" ? error.code : "PDF_PARSE_FAILED",
      message:
        typeof error.message === "string"
          ? error.message.slice(0, 500)
          : "PDF_PARSE_FAILED",
    };
  }
  return { code: "PDF_PARSE_FAILED", message: "PDF_PARSE_FAILED" };
}

function respond(message) {
  if (typeof process.send === "function" && process.connected) {
    process.send(message, (error) => process.exit(error ? 1 : 0));
    return;
  }
  // Kept for direct operational diagnostics; the application always gives
  // this process a private IPC descriptor.
  process.stdout.write(JSON.stringify(message), () => process.exit(0));
}

async function run() {
  let document;
  try {
    installNetworkGuards();

    const unpdfEntry = process.argv[2];
    const maxPages = parseInteger(process.argv[3], 1, MAX_PAGES);
    const maxTextLength = parseInteger(
      process.argv[4],
      1,
      MAX_TEXT_LENGTH,
    );
    if (!unpdfEntry) throw sandboxError("Missing parser entry point");

    const bytes = await readInput();
    const { extractText, getDocumentProxy } = require(unpdfEntry);
    document = await getDocumentProxy(bytes, {
      disableAutoFetch: true,
      disableFontFace: true,
      disableStream: true,
      enableXfa: false,
      isEvalSupported: false,
      maxImageSize: 4_000_000,
      stopAtErrors: true,
      useSystemFonts: false,
      useWasm: false,
    });

    if (document.numPages > maxPages) {
      const error = new Error("PDF_TOO_MANY_PAGES");
      error.code = "PDF_TOO_MANY_PAGES";
      throw error;
    }

    const result = await extractText(document, { mergePages: true });
    const rawText = typeof result.text === "string" ? result.text : "";
    const text = rawText
      .replace(/\u0000/g, "")
      .replace(/[\t ]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, maxTextLength);
    const pages = document.numPages;

    await destroyDocument(document);
    document = undefined;
    respond({ ok: true, text, pages });
  } catch (error) {
    await destroyDocument(document);
    respond({ ok: false, error: serializeFailure(error) });
  }
}

// Hold one inert handle until respond() exits so parsing cannot be cut short by
// a normal event-loop shutdown after the one-shot IPC request is consumed.
const keepAlive = setInterval(() => undefined, 60_000);
void run().catch((error) => {
  clearInterval(keepAlive);
  respond({ ok: false, error: serializeFailure(error) });
});
