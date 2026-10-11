import { describe, expect, it, vi } from "vitest";

import {
  inspectEmployerWebsite,
  type PinnedRequestContext,
} from "@/lib/site-scanner";

const PUBLIC_ADDRESS = "93.184.216.34";
const FIXED_DATE = new Date("2026-10-11T12:00:00.000Z");

function htmlResponse(body: string, init: ResponseInit = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8", ...init.headers },
  });
}

describe("inspectEmployerWebsite", () => {
  it("n’effectue aucune requête sans site", async () => {
    const fetchImpl = vi.fn();

    const inspection = await inspectEmployerWebsite(undefined, { fetchImpl });

    expect(inspection.status).toBe("not-requested");
    expect(inspection.pagesChecked).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bloque les adresses privées avant toute requête", async () => {
    const fetchImpl = vi.fn();

    const inspection = await inspectEmployerWebsite("http://127.0.0.1/admin", {
      fetchImpl,
      now: () => FIXED_DATE,
    });

    expect(inspection).toMatchObject({
      status: "blocked",
      checkedAt: FIXED_DATE.toISOString(),
      pagesChecked: 0,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuse toute réponse DNS mêlant adresses publique et privée", async () => {
    const fetchImpl = vi.fn();

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS, "10.0.0.8"],
      now: () => FIXED_DATE,
    });

    expect(inspection.status).toBe("blocked");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "::1",
    "::127.0.0.1",
    "::10.0.0.1",
    "::169.254.169.254",
    "::7f00:1",
    "::a00:1",
    "::a9fe:a9fe",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "2001:0000:4136:e378:8000:63bf:3fff:fdd2",
  ])("refuse l’adresse IPv6 réservée %s", async (address) => {
    const fetchImpl = vi.fn();

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [address],
      now: () => FIXED_DATE,
    });

    expect(inspection.status).toBe("blocked");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("épingle correctement une adresse IPv6 publique", async () => {
    const publicIpv6 = "2606:4700:4700::1111";
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      expect(url.hostname).toBe(`[${publicIpv6}]`);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      return htmlResponse("<html><body>Bienvenue</body></html>");
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [publicIpv6],
      now: () => FIXED_DATE,
    });

    expect(inspection.status).toBe("checked");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("épingle la connexion à l’adresse publique validée malgré un rebinding DNS", async () => {
    let currentDnsAnswer = PUBLIC_ADDRESS;
    const fetchImpl = vi.fn(
      async (
        input: string | URL,
        init?: RequestInit,
        connection?: Readonly<PinnedRequestContext>,
      ) => {
        const networkUrl = new URL(input);
        if (!connection) throw new Error("Contexte de connexion absent");

        // A numeric request target means the HTTP stack/proxy has no hostname
        // left to resolve after validation, even if DNS has changed meanwhile.
        expect(networkUrl.hostname).toBe(PUBLIC_ADDRESS);
        expect(currentDnsAnswer).toBe("127.0.0.1");
        expect(connection).toMatchObject({
          address: PUBLIC_ADDRESS,
          hostHeader: "shop.example",
          servername: "shop.example",
        });
        expect(connection.originalUrl.hostname).toBe("shop.example");
        expect(new Headers(init?.headers).get("host")).toBe("shop.example");

        if (networkUrl.pathname === "/robots.txt") {
          return new Response("", { status: 404 });
        }
        return htmlResponse("<html><body>Bienvenue</body></html>");
      },
    );
    const resolveHostname = vi.fn(async () => {
      const answer = currentDnsAnswer;
      // Simulate an attacker changing DNS immediately after the vetted answer.
      currentDnsAnswer = "127.0.0.1";
      return [answer];
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname,
      now: () => FIXED_DATE,
    });

    // robots.txt reached the vetted public IP. The next distinct request
    // re-resolves the name, observes the private answer and is blocked.
    expect(inspection.status).toBe("blocked");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(resolveHostname).toHaveBeenCalledTimes(2);
  });

  it("épingle séparément chaque destination publique d’une redirection", async () => {
    const addresses = new Map([
      ["shop.example", "93.184.216.34"],
      ["careers.example", "142.250.74.142"],
    ]);
    const fetchImpl = vi.fn(
      async (
        input: string | URL,
        _init?: RequestInit,
        connection?: Readonly<PinnedRequestContext>,
      ) => {
        const networkUrl = new URL(input);
        if (!connection) throw new Error("Contexte de connexion absent");
        expect(networkUrl.hostname).toBe(connection.address);

        if (connection.originalUrl.pathname === "/robots.txt") {
          return new Response("", { status: 404 });
        }
        if (connection.originalUrl.hostname === "shop.example") {
          return new Response("", {
            status: 302,
            headers: { location: "https://careers.example/offres" },
          });
        }
        return htmlResponse("<html><body>Nos offres</body></html>");
      },
    );
    const resolveHostname = vi.fn(async (hostname: string) => {
      const address = addresses.get(hostname);
      if (!address) throw new Error("Domaine inattendu");
      return [address];
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname,
      now: () => FIXED_DATE,
    });

    expect(inspection.status).toBe("checked");
    expect(fetchImpl.mock.calls.map(([input]) => new URL(input).hostname)).toEqual([
      "93.184.216.34",
      "93.184.216.34",
      "142.250.74.142",
      "142.250.74.142",
    ]);
    expect(resolveHostname).toHaveBeenCalledWith("careers.example");
  });

  it("revalide chaque redirection et refuse une destination DNS privée", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      return new Response("", {
        status: 302,
        headers: { location: "https://intranet.example/private" },
      });
    });
    const resolveHostname = vi.fn(async (hostname: string) =>
      hostname === "intranet.example" ? ["10.20.30.40"] : [PUBLIC_ADDRESS],
    );

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname,
      now: () => FIXED_DATE,
    });

    expect(inspection.status).toBe("blocked");
    expect(inspection.pagesChecked).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(resolveHostname).toHaveBeenCalledWith("intranet.example");
  });

  it("respecte robots.txt sur chaque origine atteinte par redirection", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = vi.fn(async (
      _input: string | URL,
      _init?: RequestInit,
      connection?: Readonly<PinnedRequestContext>,
    ) => {
      if (!connection) throw new Error("Contexte de connexion absent");
      const url = connection.originalUrl;
      requestedUrls.push(url.href);
      if (url.hostname === "shop.example" && url.pathname === "/robots.txt") {
        return new Response("", { status: 404 });
      }
      if (url.hostname === "shop.example") {
        return new Response("", {
          status: 302,
          headers: { location: "https://careers.example/private-offer" },
        });
      }
      if (url.hostname === "careers.example" && url.pathname === "/robots.txt") {
        return new Response("User-agent: *\nDisallow: /private-offer", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      throw new Error("La page interdite ne doit pas être demandée");
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      now: () => FIXED_DATE,
    });

    expect(inspection.status).toBe("blocked");
    expect(inspection.note).toContain("robots.txt");
    expect(requestedUrls).toEqual([
      "https://shop.example/robots.txt",
      "https://shop.example/",
      "https://careers.example/robots.txt",
    ]);
    expect(requestedUrls).not.toContain(
      "https://careers.example/private-offer",
    );
  });

  it("respecte robots.txt avant de lire la page", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") {
        return new Response("User-agent: *\nDisallow: /", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      throw new Error("La page ne doit pas être demandée");
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      now: () => FIXED_DATE,
    });

    expect(inspection.status).toBe("blocked");
    expect(inspection.note).toContain("robots.txt");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "donne la priorité à Allow lorsque la spécificité est identique",
      path: "/prive",
      rules: "Disallow: /prive\nAllow: /prive",
      expectedStatus: "checked",
    },
    {
      label: "retient la règle littérale la plus spécifique",
      path: "/catalogue/public",
      rules: "Disallow: /catalogue/*\nAllow: /catalogue/public",
      expectedStatus: "checked",
    },
    {
      label: "interprète les jokers entre les segments",
      path: "/foo/profond/bar",
      rules: "Disallow: /foo*bar$",
      expectedStatus: "blocked",
    },
    {
      label: "respecte l’ancre de fin",
      path: "/offres",
      rules: "Disallow: /offres$",
      expectedStatus: "blocked",
    },
    {
      label: "inclut la requête dans le chemin comparé",
      path: "/offres?source=cv",
      rules: "Disallow: /offres$",
      expectedStatus: "checked",
    },
  ])("$label", async ({ path, rules, expectedStatus }) => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") {
        return new Response(`User-agent: *\n${rules}`, {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return htmlResponse("<html><body>Bienvenue</body></html>");
    });

    const inspection = await inspectEmployerWebsite(
      `https://shop.example${path}`,
      {
        fetchImpl,
        resolveHostname: async () => [PUBLIC_ADDRESS],
        now: () => FIXED_DATE,
      },
    );

    expect(inspection.status).toBe(expectedStatus);
  });

  it("traite rapidement un motif robots avec de nombreux jokers", async () => {
    const adversarialPattern = `/${"a*".repeat(200)}z$`;
    const adversarialPath = `/${"a".repeat(4_000)}`;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") {
        return new Response(
          `User-agent: *\nDisallow: ${adversarialPattern}`,
          { status: 200, headers: { "content-type": "text/plain" } },
        );
      }
      return htmlResponse("<html><body>Bienvenue</body></html>");
    });

    const startedAt = performance.now();
    const inspection = await inspectEmployerWebsite(
      `https://shop.example${adversarialPath}`,
      {
        fetchImpl,
        resolveHostname: async () => [PUBLIC_ADDRESS],
        now: () => FIXED_DATE,
      },
    );

    expect(inspection.status).toBe("checked");
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("bloque prudemment une politique robots qui dépasse les limites", async () => {
    const tooManyRules = Array.from(
      { length: 300 },
      (_, index) => `Disallow: /zone-${index}`,
    ).join("\n");
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") {
        return new Response(`User-agent: *\n${tooManyRules}`, {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      throw new Error("La page ne doit pas être demandée");
    });

    const inspection = await inspectEmployerWebsite("https://shop.example/", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      now: () => FIXED_DATE,
    });

    expect(inspection.status).toBe("blocked");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "un motif trop long",
      path: "/",
      rules: `Disallow: /${"x".repeat(600)}`,
    },
    {
      label: "un chemin trop long",
      path: `/${"x".repeat(4_100)}`,
      rules: "Allow: /",
    },
  ])("bloque prudemment $label", async ({ path, rules }) => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") {
        return new Response(`User-agent: *\n${rules}`, {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      throw new Error("La page ne doit pas être demandée");
    });

    const inspection = await inspectEmployerWebsite(
      `https://shop.example${path}`,
      {
        fetchImpl,
        resolveHostname: async () => [PUBLIC_ADDRESS],
        now: () => FIXED_DATE,
      },
    );

    expect(inspection.status).toBe("blocked");
    expect(fetchImpl).toHaveBeenCalledTimes(path.length > 4_096 ? 0 : 1);
  });

  it("extrait une offre JSON-LD et une page carrière avec un nombre de pages borné", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      if (url.pathname === "/carrieres") {
        return htmlResponse(`
          <html><head><title>Nos carrières</title></head>
          <body>Découvrez nos offres de recrutement et nos équipes.</body></html>
        `);
      }
      return htmlResponse(`
        <html>
          <head>
            <title>Boutique Exemple</title>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "JobPosting",
                "title": "Alternance conseiller de vente",
                "description": "Relation client, vente-conseil et merchandising",
                "url": "/jobs/alternance-conseiller-vente-42",
                "datePosted": "2026-10-01",
                "validThrough": "2026-12-31T23:59:59+01:00",
                "jobLocation": { "address": { "streetAddress": "12 rue du Commerce", "postalCode": "44000", "addressLocality": "Nantes" } }
              }
            </script>
          </head>
          <body>
            <a href="/carrieres">Nous rejoindre</a>
            <p>La relation client est au cœur du magasin.</p>
          </body>
        </html>
      `);
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      maxPages: 2,
      now: () => FIXED_DATE,
      expectedLocationText: "12 rue du Commerce, 44000 Nantes, France",
    });

    expect(inspection.status).toBe("checked");
    expect(inspection.pagesChecked).toBe(2);
    expect(inspection.recruitmentPageUrl).toBe("https://shop.example/carrieres");
    expect(inspection.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "public-offer",
          title: "Alternance conseiller de vente",
          confidence: 0.98,
          sourceKind: "employer-site",
          directEmployer: true,
          specificity: "specific",
        }),
        expect.objectContaining({ level: "recruitment-page" }),
      ]),
    );
    expect(inspection.matchedKeywords).toEqual(
      expect.arrayContaining(["relation client", "vente conseil"]),
    );
  });

  it.each([
    ["une adresse privée", "http://127.0.0.1/admin"],
    ["un domaine tiers arbitraire", "https://attacker.example/collecte"],
    ["des identifiants intégrés", "https://user:secret@attacker.example/offre"],
  ])(
    "remplace et déclasse l’URL JobPosting contenant %s",
    async (_label, structuredUrl) => {
      const fetchImpl = vi.fn(async (input: string | URL) => {
        const url = new URL(input);
        if (url.pathname === "/robots.txt") {
          return new Response("", { status: 404 });
        }
        return htmlResponse(`
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "JobPosting",
              "title": "Alternance conseiller de vente BTS MCO",
              "description": "Relation client et merchandising",
              "url": ${JSON.stringify(structuredUrl)},
              "datePosted": "2026-10-01",
              "validThrough": "2026-12-31",
              "jobLocation": { "address": { "streetAddress": "12 rue du Commerce", "postalCode": "44000", "addressLocality": "Nantes" } }
            }
          </script>
        `);
      });

      const inspection = await inspectEmployerWebsite("https://shop.example", {
        fetchImpl,
        resolveHostname: async () => [PUBLIC_ADDRESS],
        now: () => FIXED_DATE,
        expectedLocationText: "12 rue du Commerce, 44000 Nantes, France",
      });

      expect(inspection.evidence[0]).toMatchObject({
        level: "prospecting",
        url: "https://shop.example/",
      });
      expect(inspection.evidence[0]?.excerpt).toContain("lien externe");
      expect(inspection.evidence.some(({ url }) => url === structuredUrl)).toBe(false);
    },
  );

  it.each([
    "https://jobs.shop.example/offres/42",
    "https://boutique.teamtailor.com/jobs/42",
  ])("conserve une URL JobPosting employeur ou ATS autorisée %s", async (structuredUrl) => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      return htmlResponse(`
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "JobPosting",
            "title": "Alternance conseiller de vente BTS MCO",
            "description": "Relation client et merchandising",
            "url": ${JSON.stringify(structuredUrl)},
            "hiringOrganization": { "name": "Boutique Exemple SAS" },
            "datePosted": "2026-10-01",
            "validThrough": "2026-12-31",
            "jobLocation": { "address": { "streetAddress": "12 rue du Commerce", "postalCode": "44000", "addressLocality": "Nantes" } }
          }
        </script>
      `);
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      now: () => FIXED_DATE,
      expectedEmployerName: "Boutique Exemple",
      expectedLocationText: "12 rue du Commerce, 44000 Nantes, France",
    });

    expect(inspection.evidence[0]).toMatchObject({
      level: "public-offer",
      url: structuredUrl,
    });
  });

  it("déclasse une destination ATS sans identité employeur concordante", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      return htmlResponse(`
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "JobPosting",
            "title": "Alternance conseiller de vente BTS MCO",
            "description": "Relation client et merchandising",
            "url": "https://jobs.lever.co/autre-entreprise/offre-42",
            "datePosted": "2026-10-01",
            "validThrough": "2026-12-31",
            "jobLocation": { "address": { "streetAddress": "12 rue du Commerce", "postalCode": "44000", "addressLocality": "Nantes" } }
          }
        </script>
      `);
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      now: () => FIXED_DATE,
      expectedEmployerName: "Boutique Exemple",
      expectedLocationText: "12 rue du Commerce, 44000 Nantes, France",
    });

    expect(inspection.evidence[0]).toMatchObject({
      level: "prospecting",
      directEmployer: false,
      url: "https://jobs.lever.co/autre-entreprise/offre-42",
    });
    expect(inspection.evidence[0]?.excerpt).toContain("identité de l’employeur");
  });

  it("remplace et déclasse une URL JobPosting dont le DNS est privé", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      return htmlResponse(`
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "JobPosting",
            "title": "Alternance conseiller de vente BTS MCO",
            "description": "Relation client et merchandising",
            "url": "https://private.shop.example/jobs/42",
            "datePosted": "2026-10-01",
            "validThrough": "2026-12-31",
            "jobLocation": { "address": { "streetAddress": "12 rue du Commerce", "postalCode": "44000", "addressLocality": "Nantes" } }
          }
        </script>
      `);
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async (hostname) =>
        hostname === "private.shop.example" ? ["10.0.0.1"] : [PUBLIC_ADDRESS],
      now: () => FIXED_DATE,
      expectedLocationText: "12 rue du Commerce, 44000 Nantes, France",
    });

    expect(inspection.evidence[0]).toMatchObject({
      level: "prospecting",
      directEmployer: false,
      url: "https://shop.example/",
    });
    expect(inspection.evidence[0]?.excerpt).toContain("destination");
  });

  it("n’expose pas un lien carrière littéral vers un réseau privé", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      return htmlResponse(
        '<a href="http://169.254.169.254/latest/meta-data">Nos emplois</a>',
      );
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      now: () => FIXED_DATE,
    });

    expect(inspection.status).toBe("checked");
    expect(inspection.evidence).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("n’expose pas un lien carrière dont le DNS pointe vers un réseau privé", async () => {
    const fetchImpl = vi.fn(async (
      _input: string | URL,
      _init?: RequestInit,
      connection?: Readonly<PinnedRequestContext>,
    ) => {
      if (connection?.originalUrl.pathname === "/robots.txt") {
        return new Response("", { status: 404 });
      }
      return htmlResponse(
        '<a href="https://private.example.com/jobs">Nos offres</a>',
      );
    });
    const resolveHostname = vi.fn(async (hostname: string) =>
      hostname === "private.example.com" ? ["127.0.0.1"] : [PUBLIC_ADDRESS],
    );

    const inspection = await inspectEmployerWebsite("https://shop.example.com", {
      fetchImpl,
      resolveHostname,
      maxPages: 2,
      now: () => FIXED_DATE,
    });

    expect(inspection.status).toBe("checked");
    expect(inspection.evidence).toEqual([]);
    expect(inspection.note).toContain("certaines pages");
    expect(resolveHostname).toHaveBeenCalledWith("private.example.com");
    expect(
      inspection.evidence.some(({ url }) => url.includes("private.example.com")),
    ).toBe(false);
  });

  it("borne le nombre de nœuds JSON-LD examinés sur une page hostile", async () => {
    const ignoredOffer = {
      "@type": "JobPosting",
      title: "Alternance qui dépasse le budget JSON-LD",
      description: "Relation client et merchandising",
      datePosted: "2026-10-01",
      validThrough: "2026-12-31",
      jobLocation: {
        address: {
          streetAddress: "12 rue du Commerce",
          postalCode: "44000",
          addressLocality: "Nantes",
        },
      },
    };
    const jsonLd = JSON.stringify([
      ...Array.from({ length: 200 }, () => ({ "@type": "Thing" })),
      ignoredOffer,
    ]);
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      return htmlResponse(
        `<script type="application/ld+json">${jsonLd}</script>`,
      );
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      now: () => FIXED_DATE,
      expectedLocationText: "12 rue du Commerce, 44000 Nantes, France",
    });

    expect(inspection.status).toBe("checked");
    expect(inspection.evidence).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: ignoredOffer.title }),
      ]),
    );
  });

  it("borne la profondeur des graphes JSON-LD sans récursion", async () => {
    let nested = JSON.stringify({
      "@type": "JobPosting",
      title: "Alternance trop profondément imbriquée",
    });
    for (let depth = 0; depth < 30; depth += 1) {
      nested = `{"@graph":${nested}}`;
    }
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      return htmlResponse(
        `<script type="application/ld+json">${nested}</script>`,
      );
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
    });

    expect(inspection.status).toBe("checked");
    expect(inspection.evidence).toEqual([]);
  });

  it("arrête tôt la collecte de liens et borne les preuves d’une page hostile", async () => {
    const requestedPaths: string[] = [];
    const oversizedLabel = `Jobs ${"x".repeat(1_000)}`;
    const hostileLinks = Array.from(
      { length: 100 },
      () => `<a href="/jobs">${oversizedLabel}</a>`,
    ).join("");
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      requestedPaths.push(url.pathname);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      if (url.pathname === "/jobs") {
        return htmlResponse(
          `${hostileLinks}<a href="/jobs/late-offer">Alternance conseiller de vente</a>`,
        );
      }
      throw new Error("Le lien situé après le plafond ne doit pas être demandé");
    });

    const inspection = await inspectEmployerWebsite("https://shop.example/jobs", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      maxPages: 2,
    });

    expect(inspection.status).toBe("checked");
    expect(requestedPaths).not.toContain("/jobs/late-offer");
    expect(inspection.evidence.length).toBeGreaterThan(0);
    expect(inspection.evidence.length).toBeLessThanOrEqual(12);
    expect(
      inspection.evidence.every(
        ({ title, url }) => title.length <= 300 && url.length <= 4_096,
      ),
    ).toBe(true);
  });

  it("certifie une alternance hors MCO uniquement lorsqu’elle correspond au profil CV", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      return htmlResponse(`
        <html><head><script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "JobPosting",
            "title": "Alternance assistant développeur",
            "description": "Développement web en TypeScript au sein de notre équipe produit.",
            "datePosted": "2026-10-01",
            "validThrough": "2026-12-31",
            "hiringOrganization": { "name": "Atelier Numérique SAS" },
            "jobLocation": {
              "address": {
                "streetAddress": "8 rue des Olivettes",
                "postalCode": "44000",
                "addressLocality": "Nantes"
              }
            }
          }
        </script></head><body></body></html>
      `);
    });
    const commonOptions = {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      now: () => FIXED_DATE,
      expectedEmployerName: "Atelier Numérique",
      expectedLocationText: "8 rue des Olivettes, 44000 Nantes, France",
    };

    const withoutProfile = await inspectEmployerWebsite(
      "https://atelier-numerique.example",
      commonOptions,
    );
    const withProfile = await inspectEmployerWebsite(
      "https://atelier-numerique.example",
      {
        ...commonOptions,
        targetRoles: ["assistant développeur"],
        professionalKeywords: ["développement web", "TypeScript"],
      },
    );

    expect(withoutProfile.evidence).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ level: "public-offer" })]),
    );
    expect(withProfile.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "public-offer",
          title: "Alternance assistant développeur",
          sourceKind: "employer-site",
          directEmployer: true,
          publishedAt: "2026-10-01",
          validThrough: "2026-12-31",
          locationText: "8 rue des Olivettes 44000 Nantes",
        }),
      ]),
    );
    expect(withProfile.matchedKeywords).toEqual(
      expect.arrayContaining(["assistant développeur", "développement web"]),
    );
  });

  it("borne à douze les métiers cibles fournis au scanner", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      return htmlResponse(`
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "JobPosting",
            "title": "Alternance assistant développeur",
            "description": "Vous rejoignez notre équipe produit.",
            "datePosted": "2026-10-01",
            "validThrough": "2026-12-31",
            "jobLocation": { "address": { "streetAddress": "8 rue des Olivettes", "postalCode": "44000", "addressLocality": "Nantes" } }
          }
        </script>
      `);
    });

    const inspection = await inspectEmployerWebsite(
      "https://atelier-numerique.example",
      {
        fetchImpl,
        resolveHostname: async () => [PUBLIC_ADDRESS],
        now: () => FIXED_DATE,
        targetRoles: [
          ...Array.from({ length: 12 }, (_, index) => `métier cible ${index}`),
          "assistant développeur",
        ],
        expectedLocationText: "8 rue des Olivettes, 44000 Nantes, France",
      },
    );

    expect(inspection.evidence[0]).toMatchObject({
      level: "prospecting",
      title: "Alternance assistant développeur",
    });
  });

  it("ne confond pas une alternance RH avec un métier MCO à cause de commerce et vente", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      return htmlResponse(`
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "JobPosting",
            "title": "Alternance assistant RH",
            "description": "Vous accompagnez l’équipe RH au sein d’un commerce de vente.",
            "datePosted": "2026-10-01",
            "validThrough": "2026-12-31",
            "jobLocation": { "address": { "streetAddress": "12 rue du Commerce", "postalCode": "44000", "addressLocality": "Nantes" } }
          }
        </script>
      `);
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      now: () => FIXED_DATE,
      professionalKeywords: ["commerce", "vente"],
      expectedLocationText: "12 rue du Commerce, 44000 Nantes, France",
    });

    expect(inspection.evidence[0]).toMatchObject({
      level: "prospecting",
      title: "Alternance assistant RH",
      specificity: "generic",
    });
    expect(inspection.evidence).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ level: "public-offer" })]),
    );
  });

  it("accepte deux signaux professionnels précis dans la description", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      return htmlResponse(`
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "JobPosting",
            "title": "Alternance équipier polyvalent",
            "description": "Vous assurez la relation client et le merchandising du rayon.",
            "datePosted": "2026-10-01",
            "validThrough": "2026-12-31",
            "jobLocation": { "address": { "streetAddress": "12 rue du Commerce", "postalCode": "44000", "addressLocality": "Nantes" } }
          }
        </script>
      `);
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      now: () => FIXED_DATE,
      expectedLocationText: "12 rue du Commerce, 44000 Nantes, France",
    });

    expect(inspection.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "public-offer",
          title: "Alternance équipier polyvalent",
        }),
      ]),
    );
    expect(inspection.recruitmentPageUrl).toBeUndefined();
  });

  it("ne rattache pas une offre à une autre succursale du même code postal", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      return htmlResponse(`
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "JobPosting",
            "title": "Alternance conseiller de vente",
            "description": "Relation client et merchandising",
            "datePosted": "2026-10-01",
            "validThrough": "2026-12-31",
            "jobLocation": { "address": { "streetAddress": "8 rue des Olivettes", "postalCode": "44000", "addressLocality": "Nantes" } }
          }
        </script>
      `);
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      now: () => FIXED_DATE,
      expectedLocationText: "12 rue du Commerce, 44000 Nantes, France",
    });

    expect(inspection.evidence[0]).toMatchObject({
      level: "prospecting",
      title: "Alternance conseiller de vente",
    });
    expect(inspection.evidence[0]?.excerpt).toContain("ne correspond pas");
  });

  it("garde une annonce comme piste informative quand son lieu est partiel", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      return htmlResponse(`
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "JobPosting",
            "title": "Alternance conseiller de vente",
            "description": "Relation client et merchandising",
            "datePosted": "2026-10-01",
            "validThrough": "2026-12-31",
            "jobLocation": { "address": { "postalCode": "44000", "addressLocality": "Nantes" } }
          }
        </script>
      `);
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      now: () => FIXED_DATE,
      expectedLocationText: "12 rue du Commerce, 44000 Nantes, France",
    });

    expect(inspection.evidence[0]).toMatchObject({ level: "prospecting" });
    expect(inspection.evidence[0]?.excerpt).toContain("n’est pas confirmé");
  });

  it("ne remonte pas une offre d’alternance expirée comme active", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      return htmlResponse(`
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "JobPosting",
            "title": "Alternance conseiller de vente BTS MCO",
            "description": "Vente conseil et relation client",
            "validThrough": "2026-09-01T23:59:59+02:00",
            "jobLocation": { "address": { "postalCode": "44000", "addressLocality": "Nantes" } }
          }
        </script>
      `);
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      now: () => FIXED_DATE,
      expectedLocationText: "12 rue du Commerce, 44000 Nantes, France",
    });

    expect(inspection.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "prospecting",
          validThrough: "2026-09-01T23:59:59+02:00",
          locationText: "44000 Nantes",
        }),
      ]),
    );
    expect(inspection.evidence).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ level: "public-offer" })]),
    );
  });

  it("ne présente pas une annonce sans alternance comme une offre BTS MCO", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      return htmlResponse(`
        <html><head><script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "JobPosting",
            "title": "Conseiller de vente confirmé en CDI",
            "employmentType": "FULL_TIME",
            "description": "Cinq ans d’expérience requis."
          }
        </script></head><body></body></html>
      `);
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
    });

    expect(inspection.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "prospecting",
          title: "Conseiller de vente confirmé en CDI",
        }),
      ]),
    );
    expect(inspection.evidence).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ level: "public-offer" })]),
    );
    expect(inspection.matchedKeywords).not.toContain("bts mco");
    expect(inspection.matchedKeywords).not.toContain("alternance");
  });

  it("refuse une annonce ancienne sans date de fin", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      return htmlResponse(`
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "JobPosting",
            "title": "Alternance conseiller de vente BTS MCO",
            "description": "Relation client et vente conseil",
            "datePosted": "2026-05-01",
            "jobLocation": { "address": { "streetAddress": "12 rue du Commerce", "postalCode": "44000", "addressLocality": "Nantes" } }
          }
        </script>
      `);
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      now: () => FIXED_DATE,
      expectedLocationText: "12 rue du Commerce, 44000 Nantes, France",
    });

    expect(inspection.evidence[0]).toMatchObject({
      level: "prospecting",
      publishedAt: "2026-05-01",
    });
    expect(inspection.evidence).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ level: "public-offer" })]),
    );
  });

  it("considère une date de fin au jour courant comme encore active à Paris", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      return htmlResponse(`
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "JobPosting",
            "title": "Alternance conseiller de vente BTS MCO",
            "description": "Relation client et vente conseil",
            "validThrough": "2026-10-11",
            "jobLocation": { "address": { "streetAddress": "12 rue du Commerce", "postalCode": "44000", "addressLocality": "Nantes" } }
          }
        </script>
      `);
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      now: () => FIXED_DATE,
      expectedLocationText: "12 rue du Commerce, 44000 Nantes, France",
    });

    expect(inspection.evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ level: "public-offer" })]),
    );
  });

  it("rejette l’offre d’un autre employeur même sur une page carrière", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      return htmlResponse(`
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "JobPosting",
            "title": "Alternance conseiller de vente BTS MCO",
            "description": "Relation client et vente conseil",
            "datePosted": "2026-10-01",
            "validThrough": "2026-12-31",
            "hiringOrganization": { "name": "Autre Enseigne SAS" },
            "jobLocation": { "address": { "streetAddress": "12 rue du Commerce", "postalCode": "44000", "addressLocality": "Nantes" } }
          }
        </script>
      `);
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      now: () => FIXED_DATE,
      expectedEmployerName: "Boutique Exemple",
      expectedLocationText: "12 rue du Commerce, 44000 Nantes, France",
    });

    expect(inspection.evidence[0]).toMatchObject({
      level: "prospecting",
      directEmployer: false,
    });
    expect(inspection.evidence[0]?.excerpt).toContain("ne correspond pas");
  });

  it("accepte un ATS seulement lorsqu’il est lié par le site employeur et confirme l’employeur", async () => {
    const fetchImpl = vi.fn(async (
      input: string | URL,
      _init?: RequestInit,
      connection?: Readonly<PinnedRequestContext>,
    ) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      if (connection?.originalUrl.hostname === "boutique-exemple.fr") {
        return htmlResponse(`
          <a href="https://boutique.teamtailor.com/jobs/42-alternance-conseiller-vente">
            Alternance conseiller de vente BTS MCO
          </a>
        `);
      }
      return htmlResponse(`
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "JobPosting",
            "title": "Alternance conseiller de vente BTS MCO",
            "description": "Relation client et merchandising",
            "datePosted": "2026-10-01",
            "validThrough": "2026-12-31",
            "hiringOrganization": { "name": "Boutique Exemple SAS" },
            "jobLocation": { "address": { "streetAddress": "12 rue du Commerce", "postalCode": "44000", "addressLocality": "Nantes" } }
          }
        </script>
      `);
    });

    const inspection = await inspectEmployerWebsite("https://boutique-exemple.fr", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      maxPages: 2,
      now: () => FIXED_DATE,
      expectedEmployerName: "Boutique Exemple",
      expectedLocationText: "12 rue du Commerce, 44000 Nantes, France",
    });

    expect(inspection.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "public-offer",
          sourceKind: "employer-ats",
          directEmployer: true,
        }),
      ]),
    );
    expect(inspection.recruitmentPageUrl).toBeUndefined();
  });

  it("ne certifie pas comme directe une annonce ATS fournie seule", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      return htmlResponse(`
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "JobPosting",
            "title": "Alternance conseiller de vente BTS MCO",
            "description": "Relation client et merchandising",
            "datePosted": "2026-10-01",
            "validThrough": "2026-12-31",
            "hiringOrganization": { "name": "Boutique Exemple" },
            "jobLocation": { "address": { "postalCode": "44000", "addressLocality": "Nantes" } }
          }
        </script>
      `);
    });

    const inspection = await inspectEmployerWebsite(
      "https://boutique.teamtailor.com/jobs/42",
      {
        fetchImpl,
        resolveHostname: async () => [PUBLIC_ADDRESS],
        now: () => FIXED_DATE,
        expectedEmployerName: "Boutique Exemple",
        expectedLocationText: "12 rue du Commerce, 44000 Nantes, France",
      },
    );

    expect(inspection.evidence[0]).toMatchObject({
      level: "prospecting",
      sourceKind: "unknown",
      directEmployer: false,
    });
    expect(inspection.recruitmentPageUrl).toBeUndefined();
  });

  it("arrête proprement une réponse trop volumineuse", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      return htmlResponse("contenu", { headers: { "content-length": "5000" } });
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      maxResponseBytes: 4_096,
    });

    expect(inspection.status).toBe("unreachable");
    expect(inspection.note).toContain("volumineuse");
  });

  it("borne la durée d’une requête qui ne répond pas", async () => {
    const fetchImpl = vi.fn((input: string | URL): Promise<Response> => {
      const url = new URL(input);
      if (url.pathname === "/robots.txt") {
        return Promise.resolve(new Response("", { status: 404 }));
      }
      return new Promise(() => undefined);
    });

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      timeoutMs: 100,
      totalTimeoutMs: 500,
    });

    expect(inspection.status).toBe("unreachable");
    expect(inspection.note).toContain("délai");
  });

  it("classe un délai sur robots.txt comme site inaccessible, pas comme refus", async () => {
    const fetchImpl = vi.fn((): Promise<Response> => new Promise(() => undefined));

    const inspection = await inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      timeoutMs: 100,
      totalTimeoutMs: 500,
    });

    expect(inspection.status).toBe("unreachable");
    expect(inspection.note).toContain("délai");
    expect(inspection.note).not.toContain("n’autorise pas");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("propage un signal externe déjà annulé comme AbortError", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Recherche annulée", "AbortError"));
    const fetchImpl = vi.fn();

    await expect(
      inspectEmployerWebsite("https://shop.example", {
        fetchImpl,
        resolveHostname: async () => [PUBLIC_ADDRESS],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("propage comme AbortError une annulation externe pendant la requête", async () => {
    const controller = new AbortController();
    let markRequestStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const fetchImpl = vi.fn((_input: string | URL, init?: RequestInit) => {
      markRequestStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    });

    const inspection = inspectEmployerWebsite("https://shop.example", {
      fetchImpl,
      resolveHostname: async () => [PUBLIC_ADDRESS],
      signal: controller.signal,
    });
    await requestStarted;
    controller.abort(new DOMException("Recherche annulée", "AbortError"));

    await expect(inspection).rejects.toMatchObject({ name: "AbortError" });
  });
});

