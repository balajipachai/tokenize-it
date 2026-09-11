"use client";

import { usePrivy } from "@privy-io/react-auth";
import { LoginScreen } from "./components/LoginScreen";
import { Dashboard } from "./components/Dashboard";
import { SetupNeeded } from "./providers";

export default function Home() {
  // Checked here rather than in the provider, so a missing Privy app stops the employee
  // page and nothing else -- the issuer console in the same app signs with MetaMask.
  if (!process.env.NEXT_PUBLIC_PRIVY_APP_ID) return <SetupNeeded />;
  return <Portal />;
}

function Portal() {
  const { ready, authenticated } = usePrivy();

  if (!ready) {
    return (
      <div className="center">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  return authenticated ? <Dashboard /> : <LoginScreen />;
}
