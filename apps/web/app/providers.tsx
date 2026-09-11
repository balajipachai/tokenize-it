"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { hederaTestnet } from "@/lib/chain";

/**
 * Rendered by the EMPLOYEE page when Privy is unconfigured. Deliberately not a thrown
 * error: the app ID is a runtime secret, and throwing here fails `next build` at
 * prerender, which turns a missing .env.local into a broken CI pipeline.
 */
export function SetupNeeded() {
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

/**
 * Wraps the app in Privy when it is configured, and gets out of the way when it is not.
 *
 * This used to return the setup notice instead of the app. That was right when the portal
 * was its own deployment, and wrong the moment the issuer console joined it: the issuer
 * side signs with HR's own MetaMask and needs no Privy app at all, so a missing employee
 * credential would have blanked a page that works perfectly well without it. The employee
 * page now shows the notice itself.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) return <>{children}</>;

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
