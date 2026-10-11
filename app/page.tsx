import { RuntimeModeBanner } from "@/components/runtime-mode-banner";
import { SearchExperience } from "@/components/search-experience";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const liveSearchConfigured = Boolean(
    process.env.GOOGLE_MAPS_SERVER_API_KEY?.trim(),
  );
  const laBonneAlternanceConfigured = Boolean(process.env.LBA_API_KEY?.trim());
  const siteScanEnabled =
    process.env.ENABLE_SITE_SCAN?.trim().toLowerCase() !== "false";

  return (
    <>
      <RuntimeModeBanner
        laBonneAlternanceConfigured={laBonneAlternanceConfigured}
        liveSearchConfigured={liveSearchConfigured}
        siteScanEnabled={siteScanEnabled}
      />
      <SearchExperience
        browserMapKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY}
      />
    </>
  );
}

