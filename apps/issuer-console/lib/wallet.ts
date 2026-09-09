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
