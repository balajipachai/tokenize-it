import type { Metadata } from "next";
import { Providers } from "./providers";
import { SideSwitch } from "./components/SideSwitch";
import { TestInvite } from "./components/TestInvite";
import "./globals.css";

export const metadata: Metadata = {
  title: "tokenize-it",
  description: "Tokenized employee stock options, with lifecycle, lending and payroll.",
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
