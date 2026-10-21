import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Self-hosted (OFL, see app/fonts/), Latin subset incl. German umlauts: Public Sans for the interface, Newsreader for headings. No third-party requests.
const publicSans = localFont({
  variable: "--font-public-sans",
  display: "swap",
  src: [
    { path: "./fonts/publicsans-latin.woff2", weight: "100 900", style: "normal" },
  ],
});

const newsreader = localFont({
  variable: "--font-newsreader",
  display: "swap",
  src: [
    { path: "./fonts/newsreader-latin.woff2", weight: "200 800", style: "normal" },
    { path: "./fonts/newsreader-italic-latin.woff2", weight: "200 800", style: "italic" },
  ],
});

export const metadata: Metadata = {
  title: "Content Studio",
  description:
    "Self-hosted content pipeline: structured brief to platform-ready scripts, captions, voice-over, video and key visuals for your own brands.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#EFF1F2",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${publicSans.variable} ${newsreader.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-ink text-paper">{children}</body>
    </html>
  );
}
