import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "JobAroundMe — Trouver une alternance autour de soi",
  description:
    "Explorez les entreprises proches, comparez les temps de trajet et repérez les signaux publics de recrutement pour un BTS MCO.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#173c34",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}

