"use client";

import { createPublicClient, createWalletClient, custom, http, type Address, type EIP1193Provider } from "viem";
import { hederaTestnet } from "./chain";

export const publicClient = createPublicClient({ chain: hederaTestnet, transport: http() });

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

/**
 * HR staff sign for themselves, deliberately. `terminate` records msg.sender as the
 * deciding address, so a shared server key would make that attribution meaningless —
 * every forfeiture would trace to "the backend". The employee portal is the opposite
 * case and correctly relays; see IMPLEMENTATION_PLAN.md §6.
 */
export function walletClient(account: Address) {
  if (!window.ethereum) throw new Error("No wallet found. Install MetaMask to sign issuer actions.");
  return createWalletClient({ account, chain: hederaTestnet, transport: custom(window.ethereum) });
}

/**
 * MetaMask does not notify a page that it has been disconnected in any way React can
 * react to safely — the injected provider keeps working but the account list empties.
 * Reloading is the honest response: it clears any half-rendered admin state rather
 * than leaving buttons that will revert.
 */
export function watchWallet(onChange: () => void): () => void {
  const eth = window.ethereum as unknown as {
    on?: (e: string, h: (...a: unknown[]) => void) => void;
    removeListener?: (e: string, h: (...a: unknown[]) => void) => void;
  };
  if (!eth?.on) return () => {};
  const handler = () => onChange();
  eth.on("accountsChanged", handler);
  eth.on("chainChanged", handler);
  return () => {
    eth.removeListener?.("accountsChanged", handler);
    eth.removeListener?.("chainChanged", handler);
  };
}

export async function connect(): Promise<Address> {
  if (!window.ethereum) throw new Error("No wallet found. Install MetaMask to sign issuer actions.");

  const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
  const chainId = (await window.ethereum.request({ method: "eth_chainId" })) as string;

  if (parseInt(chainId, 16) !== hederaTestnet.id) {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${hederaTestnet.id.toString(16)}` }],
      });
    } catch {
      // Hedera testnet is not in MetaMask by default, so offer to add it rather than
      // leaving the user to copy RPC settings by hand.
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: `0x${hederaTestnet.id.toString(16)}`,
            chainName: hederaTestnet.name,
            nativeCurrency: hederaTestnet.nativeCurrency,
            rpcUrls: [hederaTestnet.rpcUrls.default.http[0]],
            blockExplorerUrls: [hederaTestnet.blockExplorers!.default.url],
          },
        ],
      });
    }
  }
  return accounts[0];
}
