import type { Metadata } from "next";
import { Providers } from "./providers";
import { SideSwitch } from "./components/SideSwitch";
import { TestInvite } from "./components/TestInvite";
import "./globals.css";

// Link previews need absolute URLs for their images, so metadata needs to know the site's
// own address. On Vercel that comes from the production domain it exposes at build time;
// NEXT_PUBLIC_SITE_URL overrides it for any other host.
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3000");

const description =
  "Tokenized ESOPs on Hedera: borrow against vested equity without selling it or leaving your wallet.";

// The preview image itself is app/opengraph-image.png, picked up by Next.js automatically.
// X falls back to it too, so there is no separate twitter image -- only the large card type.
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "tokenize-it",
  description,
  openGraph: { title: "tokenize-it", description, url: "/", siteName: "tokenize-it", type: "website" },
  twitter: { card: "summary_large_image", title: "tokenize-it", description },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <SideSwitch />
          <TestInvite />
          {children}
        </Providers>
      </body>
    </html>
  );
}
