/**
 * The message HR signs to open a payroll session.
 *
 * Shared by the browser, which asks the wallet to sign it, and the server, which rebuilds
 * it to verify the signature — one definition, so the two cannot drift the way the two
 * copies of the controller ABI once did.
 *
 * The server REBUILDS the message from its own view of the domain rather than accepting
 * text from the client. That is what makes the domain line binding: a signature collected
 * by some other site names that site, and cannot open a session here.
 */
export function payrollSignInMessage(domain: string, address: string, issuedAt: string): string {
  return [
    "tokenize-it payroll sign-in",
    "",
    "Signing proves you control this wallet, so the server can check it is a grant admin.",
    "It sends no transaction and costs nothing.",
    "",
    `Domain: ${domain}`,
    `Address: ${address}`,
    `Issued at: ${issuedAt}`,
  ].join("\n");
}
