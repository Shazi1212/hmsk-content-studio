import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Content Studio",
  description:
    "Self-hosted content pipeline: structured brief to platform-ready scripts, captions, voice-over, video and key visuals for your own brands.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#F7F6F2",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-ink text-paper">{children}</body>
    </html>
  );
}
