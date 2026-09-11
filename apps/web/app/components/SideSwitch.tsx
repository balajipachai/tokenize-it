"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Moves between the two halves of the product.
 *
 * They were two Next apps on two ports until it became clear that was cost without
 * benefit: two installs, two builds, two deployments, and two copies of the same ABI that
 * had already drifted apart in a way that silently broke the console. They share a chain,
 * a stylesheet and a contract surface, so they share an app.
 *
 * What stays separate is what should: the employee signs in with Privy and never holds
 * gas, while HR connects their own MetaMask so that `terminate` records a real deciding
 * address on-chain. One app, two audiences, two entirely different ways of signing.
 */
export function SideSwitch() {
  const path = usePathname();
  const onIssuer = path?.startsWith("/issuer") ?? false;

  return (
    <nav className="sideswitch" aria-label="Switch between the employee and issuer views">
      <Link href="/" className={onIssuer ? "" : "on"} aria-current={onIssuer ? undefined : "page"}>
        Employee
      </Link>
      <Link href="/issuer" className={onIssuer ? "on" : ""} aria-current={onIssuer ? "page" : undefined}>
        Issuer
      </Link>
    </nav>
  );
}
