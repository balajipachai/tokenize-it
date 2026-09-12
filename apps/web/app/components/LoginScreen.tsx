"use client";

import { usePrivy } from "@privy-io/react-auth";
import { Mark } from "./Mark";

export function LoginScreen() {
  const { login } = usePrivy();

  return (
    <div className="center">
      <div className="card" style={{ maxWidth: 380, textAlign: "center" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
          <Mark size={64} id="login" />
        </div>
        <h1>My Equity</h1>
        <p className="muted" style={{ marginBottom: 22 }}>
          Sign in with your work email to see your stock options, watch them vest, and claim them.
          No wallet to install, no seed phrase to lose.
        </p>
        <button onClick={() => login()}>Sign in</button>
      </div>
    </div>
  );
}
