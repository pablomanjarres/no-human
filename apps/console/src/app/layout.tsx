import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

// Archivo carries a width axis, which is what makes headings read as a stamped
// nameplate rather than a marketing headline. Plex is IBM's engineering
// typeface — sans for reading, mono for anything an engineer would quote.
const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-archivo",
  display: "swap",
});

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "SICK Cross — cross-brand equivalence engine",
  description:
    "Hand it a competitor part number. It returns the SICK equivalent, parameter by parameter, citing both datasheets — or tells you there isn't one and what you would lose.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${plexSans.variable} ${plexMono.variable}`}>
      <body className="min-h-dvh bg-cab-950 text-ink antialiased">{children}</body>
    </html>
  );
}
