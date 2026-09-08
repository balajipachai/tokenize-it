import "server-only";
import { PrivyClient, isEmbeddedWalletLinkedAccount } from "@privy-io/node";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

let client: PrivyClient | null = null;

function getPrivyClient(): PrivyClient {
  if (!client) {
    client = new PrivyClient({
      appId: requireEnv("NEXT_PUBLIC_PRIVY_APP_ID"),
      appSecret: requireEnv("PRIVY_APP_SECRET"),
    });
  }
  return client;
}

/**
 * Verifies a Privy access token and returns the DID it was issued for. Throws if the
 * token is missing, malformed, expired, or was not issued by this app — callers must
 * treat a thrown error as "reject the request", never fall back to trusting anything
 * the client sent.
 */
export async function verifyAccessTokenOrThrow(accessToken: string) {
  return getPrivyClient().utils().auth().verifyAccessToken(accessToken);
}

/**
 * Resolves the verified user's embedded wallet address from Privy's user directory —
 * never from anything the client put in the request. This is the whole security model:
 * the browser proves *who it is* with a token, and the server decides *which address
 * that means*. A client-supplied address would let anyone claim anyone's equity.
 */
export async function getEmbeddedWalletAddress(userId: string): Promise<`0x${string}` | null> {
  const user = await getPrivyClient().users()._get(userId);
  const embedded = user.linked_accounts.find(
    (account) => isEmbeddedWalletLinkedAccount(account) && account.chain_type === "ethereum",
  );
  return (embedded?.address as `0x${string}` | undefined) ?? null;
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

/** Verifies the caller and resolves their wallet, or returns the error response to send. */
export async function requireWallet(
  req: Request,
): Promise<{ wallet: `0x${string}`; userId: string } | { error: string; status: number }> {
  const token = bearerToken(req);
  if (!token) return { error: "Missing access token.", status: 401 };

  let userId: string;
  try {
    userId = (await verifyAccessTokenOrThrow(token)).user_id;
  } catch {
    return { error: "Invalid or expired session. Please sign in again.", status: 401 };
  }

  const wallet = await getEmbeddedWalletAddress(userId);
  if (!wallet) return { error: "No wallet found for this account. Sign out and back in.", status: 400 };

  return { wallet, userId };
}
