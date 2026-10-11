import { afterEach, describe, expect, it } from "vitest";

import { GET } from "@/app/api/health/route";

const ORIGINAL_ENV = {
  google: process.env.GOOGLE_MAPS_SERVER_API_KEY,
  browser: process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY,
  lba: process.env.LBA_API_KEY,
  scan: process.env.ENABLE_SITE_SCAN,
};

afterEach(() => {
  restore("GOOGLE_MAPS_SERVER_API_KEY", ORIGINAL_ENV.google);
  restore("NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY", ORIGINAL_ENV.browser);
  restore("LBA_API_KEY", ORIGINAL_ENV.lba);
  restore("ENABLE_SITE_SCAN", ORIGINAL_ENV.scan);
});

describe("GET /api/health", () => {
  it("applique la même normalisation que les fournisseurs", async () => {
    process.env.GOOGLE_MAPS_SERVER_API_KEY = "   ";
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY = "\t";
    process.env.LBA_API_KEY = " ";
    process.env.ENABLE_SITE_SCAN = " FALSE ";

    const response = GET();
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      searchMode: "demo",
      browserMapConfigured: false,
      laBonneAlternanceConfigured: false,
      siteScanEnabled: false,
    });
  });
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
