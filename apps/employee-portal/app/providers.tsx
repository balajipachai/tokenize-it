"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { hederaTestnet } from "@/lib/chain";

/**
 * Rendered instead of the app when Privy is unconfigured. Deliberately not a thrown
 * error: the app ID is a runtime secret, and throwing here fails `next build` at
 * prerender, which turns a missing .env.local into a broken CI pipeline.
 */
function SetupNeeded() {
  return (
    <div className="center">
      <div className="card" style={{ maxWidth: 460 }}>
        <h1>Almost there</h1>
        <p className="muted">
          This portal needs a Privy app before anyone can sign in. Create one at{" "}
          <code>dashboard.privy.io</code>, then copy <code>.env.example</code> to <code>.env.local</code> and set:
        </p>
        <p>
          <code>NEXT_PUBLIC_PRIVY_APP_ID</code>
          <br />
          <code>PRIVY_APP_SECRET</code>
          <br />
          <code>RELAYER_PRIVATE_KEY</code>
        </p>
      </div>
    </div>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) return <SetupNeeded />;

  return (
    <PrivyProvider
      appId={appId}
      config={{
        // An employee signs in with something they already have. No external wallet
        // in this list, so it is never the primary path.
        loginMethods: ["email", "google"],
        embeddedWallets: {
          ethereum: {
            // The wallet appears the moment someone without one finishes logging in.
            // They never see a "create wallet" step, and never learn what a seed phrase is.
            createOnLogin: "users-without-wallets",
          },
        },
        defaultChain: hederaTestnet,
        supportedChains: [hederaTestnet],
        appearance: { theme: "light", accentColor: "#1d4ed8" },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
