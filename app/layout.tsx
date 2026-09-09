import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") ?? incoming.get("host");
  const protocol = incoming.get("x-forwarded-proto") ?? (host?.includes("localhost") ? "http" : "https");
  const origin = host
    ? `${protocol}://${host}`
    : "https://mixtape-98.promptguyera.chatgpt.site";
  const socialImage = `${origin}/og.png`;

  return {
    metadataBase: new URL(origin),
    title: "MIXTAPE_98 — Share the songs, skip the sign-up",
    description:
      "Turn Suno song links into a shuffled, shareable old-school player with real playback controls and no account gate.",
    applicationName: "MIXTAPE_98",
    openGraph: {
      type: "website",
      title: "MIXTAPE_98",
      description: "Real controls. Random queue. No account gate.",
      siteName: "MIXTAPE_98",
      images: [
        {
          url: socialImage,
          width: 1792,
          height: 936,
          alt: "MIXTAPE_98 retro browser music player",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "MIXTAPE_98",
      description: "Real controls. Random queue. No account gate.",
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
