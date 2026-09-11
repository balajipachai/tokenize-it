import "server-only";
import crypto from "node:crypto";
import { getAddress, isAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import { controllerAbi } from "./abi";
import { deployment, publicClient } from "./contracts";
import { payrollSignInMessage } from "./payrollMessage";

/**
 * Who may reach payroll: grant admins, enforced HERE rather than only in the UI.
 *
 * Hiding the tab from non-admins would change nothing about who can call `/api/payroll`,
 * and that route holds the officer keys — it can assemble a full quorum on its own. So the
 * rule is checked on the server: HR signs one message with the wallet they already connect,
 * the server recovers the address, asks the controller whether it is a grant admin, and
 * issues a short-lived session cookie. There are no passwords, and the roster lives where
 * it already lived — on-chain, in `isGrantAdmin`.
 */

export const SESSION_COOKIE = "payroll_session";
const SESSION_TTL_SECONDS = 60 * 60;
/** A signed sign-in message is good for five minutes, which bounds how long it can be replayed. */
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;

type Failure = { error: string; status: number };

/**
 * The HMAC key for session cookies. `PAYROLL_SESSION_SECRET` if set; otherwise derived from
 * the Privy app secret under a fixed label, so the Privy secret itself never signs anything
 * and hosting does not need yet another variable to get started.
 */
function sessionKey(): Buffer {
  const explicit = process.env.PAYROLL_SESSION_SECRET;
  if (explicit) return crypto.createHash("sha256").update(explicit).digest();
  const privy = process.env.PRIVY_APP_SECRET;
  if (!privy) throw new Error("Set PAYROLL_SESSION_SECRET or PRIVY_APP_SECRET to enable payroll sign-in.");
  return crypto.createHmac("sha256", privy).update("tokenize-it/payroll-session/v1").digest();
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function signToken(address: Address, expires: number): string {
  const payload = b64(JSON.stringify({ a: address, e: expires }));
  const mac = crypto.createHmac("sha256", sessionKey()).update(payload).digest();
  return `${payload}.${b64(mac)}`;
}

function verifyToken(token: string): Address | null {
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = crypto.createHmac("sha256", sessionKey()).update(payload).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const { a, e } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof e !== "number" || e < Math.floor(Date.now() / 1000) || !isAddress(a)) return null;
    return getAddress(a);
  } catch {
    return null;
  }
}

/**
 * The domain the sign-in message must name. The `Host` header, NOT `X-Forwarded-Host`:
 * a client can set the latter to anything, which would let a signature phished on another
 * site be replayed here under that site's name. Behind a proxy that rewrites Host, pin it
 * with PAYROLL_SIGNIN_DOMAIN.
 */
function expectedDomain(req: Request): string {
  return process.env.PAYROLL_SIGNIN_DOMAIN || req.headers.get("host") || "";
}

export function isSecure(req: Request): boolean {
  return new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/api/payroll; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${secure ? "; Secure" : ""}`;
}

export function clearedCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/api/payroll; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

async function isGrantAdmin(address: Address): Promise<boolean> {
  return publicClient.readContract({
    address: deployment().esopVestingController!.address,
    abi: controllerAbi,
    functionName: "isGrantAdmin",
    args: [address],
  });
}

/** Verifies a signed sign-in message and, if it came from a grant admin, returns a session token. */
export async function createSession(
  req: Request,
  body: { address?: string; issuedAt?: string; signature?: string },
): Promise<{ token: string; address: Address } | Failure> {
  const { address, issuedAt, signature } = body;
  if (!address || !isAddress(address) || !issuedAt || !signature) {
    return { error: "Malformed sign-in.", status: 400 };
  }

  const issued = Date.parse(issuedAt);
  const age = Date.now() - issued;
  if (Number.isNaN(issued) || age > SIGNATURE_MAX_AGE_MS || age < -CLOCK_SKEW_MS) {
    return { error: "That sign-in has expired. Try again.", status: 401 };
  }

  // Rebuilt from the server's own view of the domain and the address exactly as sent —
  // never taken from the request — so the signature has to cover this site, this wallet
  // and this moment.
  const message = payrollSignInMessage(expectedDomain(req), address, issuedAt);
  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message, signature: signature as Hex });
  } catch {
    return { error: "That signature could not be verified.", status: 401 };
  }
  if (getAddress(signer) !== getAddress(address)) {
    // Also where a signature made for ANOTHER site lands: rebuilt with this site's name it
    // recovers to some unrelated address. So the message names both causes.
    return { error: "That signature does not match this wallet and this site. Sign in again.", status: 401 };
  }

  try {
    if (!(await isGrantAdmin(signer))) {
      return { error: "This wallet is not a grant admin, so it cannot use payroll.", status: 403 };
    }
    return { token: signToken(signer, Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS), address: signer };
  } catch (err) {
    return { error: err instanceof Error ? err.message.split("\n")[0] : "Payroll sign-in is unavailable.", status: 503 };
  }
}

/** Guards a payroll request. Returns the signed-in grant admin, or the response to send. */
export async function requireGrantAdmin(req: Request): Promise<{ address: Address } | Failure> {
  const token = (req.headers.get("cookie") ?? "")
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!token) return { error: "Sign in with a grant-admin wallet to use payroll.", status: 401 };

  try {
    const address = verifyToken(token);
    if (!address) return { error: "Your payroll session has expired. Sign in again.", status: 401 };
    // Re-checked on every request, not only at sign-in: removing someone's grant-admin role
    // on-chain has to end their payroll access immediately, not when their cookie expires.
    if (!(await isGrantAdmin(address))) {
      return { error: "This wallet is no longer a grant admin.", status: 403 };
    }
    return { address };
  } catch (err) {
    return { error: err instanceof Error ? err.message.split("\n")[0] : "Payroll sign-in is unavailable.", status: 503 };
  }
}
