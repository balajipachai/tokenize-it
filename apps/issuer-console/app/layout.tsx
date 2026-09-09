import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Issuer console",
  description: "Run the ESOP lifecycle: onboard, grant, suspend, terminate, claw back.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
