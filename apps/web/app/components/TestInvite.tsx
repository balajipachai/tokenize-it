/**
 * An open invitation to try the whole product. Testing either flow needs an address the
 * issuer has onboarded — KYC and the allowlist are enforced by the token itself — so the
 * way in is to send one.
 *
 * App chrome, like the switch above it: rendered by the layout, on both halves.
 */
export function TestInvite() {
  return (
    <p className="invite">
      Want to test the app end to end (Employee / Issuer flow)? Send your wallet address on Telegram
      to{" "}
      <a href="https://t.me/balajipachai" target="_blank" rel="noreferrer">
        @balajipachai
      </a>
      .
    </p>
  );
}
