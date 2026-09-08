"use client";

import { usePrivy } from "@privy-io/react-auth";
import { LoginScreen } from "./components/LoginScreen";
import { Dashboard } from "./components/Dashboard";

export default function Home() {
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
