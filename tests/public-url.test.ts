import { describe, expect, it } from "vitest";

import {
  isGloballyRoutableIpAddress,
  parsePublicHttpUrl,
  safePublicHttpUrl,
} from "@/lib/public-url";

describe("public URL validation", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.168.0.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::127.0.0.1",
    "::10.0.0.1",
    "::169.254.169.254",
    "::7f00:1",
    "::a00:1",
    "::a9fe:a9fe",
    "::ffff:8.8.8.8",
    "64:ff9b::7f00:1",
    "2001:db8::1",
    "2002:7f00:1::",
    "4000::1",
    "8000::1",
    "f000::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
  ])("refuse l’adresse non globalement routable %s", (address) => {
    expect(isGloballyRoutableIpAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "accepte l’adresse Internet publique %s",
    (address) => {
      expect(isGloballyRoutableIpAddress(address)).toBe(true);
    },
  );

  it.each([
    "http://localhost/admin",
    "http://localhost./admin",
    "http://service.local/admin",
    "http://router.home.arpa/admin",
    "http://intranet/admin",
    "http://127.0.0.1/admin",
    "http://2130706433/admin",
    "http://[::7f00:1]/admin",
    "https://user:secret@example.com/",
    "https://example.com:8443/",
    "ftp://example.com/file",
    "javascript:alert(1)",
    "https://example.com/\nadmin",
  ])("refuse l’URL littérale non sûre %s", (url) => {
    expect(parsePublicHttpUrl(url)).toBeUndefined();
    expect(safePublicHttpUrl(url)).toBeUndefined();
  });

  it("normalise une URL publique et conserve une route SPA HTTPS", () => {
    expect(safePublicHttpUrl("https://www.example.com:443/jobs?q=mco#apply")).toBe(
      "https://www.example.com/jobs?q=mco#apply",
    );
    expect(safePublicHttpUrl("https://[2606:4700:4700::1111]/jobs")).toBe(
      "https://[2606:4700:4700::1111]/jobs",
    );
    expect(safePublicHttpUrl("http://www.example.com/jobs#apply")).toBe(
      "http://www.example.com/jobs",
    );
  });
});
