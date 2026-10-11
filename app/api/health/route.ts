import { NextResponse } from "next/server";

import { hasGoogleMapsApiKey } from "@/lib/google-maps";
import { laBonneAlternanceApiKey } from "@/lib/la-bonne-alternance";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    {
      status: "ok",
      searchMode: hasGoogleMapsApiKey() ? "live" : "demo",
      browserMapConfigured: Boolean(
        process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY?.trim(),
      ),
      laBonneAlternanceConfigured: laBonneAlternanceApiKey() !== undefined,
      siteScanEnabled:
        process.env.ENABLE_SITE_SCAN?.trim().toLowerCase() !== "false",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
