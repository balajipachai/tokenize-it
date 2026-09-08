/** Only the pieces the portal reads or relays. Full ABIs live in the contracts package. */

export const controllerAbi = [
  {
    type: "function",
    name: "grantsOf",
    stateMutability: "view",
    inputs: [{ name: "employee", type: "address" }],
    outputs: [{ type: "uint256[]" }],
  },
  {
    type: "function",
    name: "getGrant",
    stateMutability: "view",
    inputs: [{ name: "grantId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "employee", type: "address" },
          { name: "partition", type: "bytes32" },
          { name: "totalAmount", type: "uint128" },
          { name: "fundedAmount", type: "uint128" },
          { name: "grantDate", type: "uint64" },
          { name: "terminatedAt", type: "uint64" },
          { name: "fundedTranches", type: "uint32" },
          { name: "status", type: "uint8" },
          { name: "leaver", type: "uint8" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getTranches",
    stateMutability: "view",
    inputs: [{ name: "grantId", type: "uint256" }],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "amount", type: "uint128" },
          { name: "vestsAt", type: "uint64" },
          { name: "lockId", type: "uint32" },
          { name: "released", type: "bool" },
          { name: "clawedBack", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "vestedAmount",
    stateMutability: "view",
    inputs: [{ name: "grantId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "unvestedAmount",
    stateMutability: "view",
    inputs: [{ name: "grantId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "nextVestAt",
    stateMutability: "view",
    inputs: [{ name: "grantId", type: "uint256" }],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function",
    name: "pendingTranches",
    stateMutability: "view",
    inputs: [{ name: "grantId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "releaseVested",
    stateMutability: "nonpayable",
    inputs: [
      { name: "grantId", type: "uint256" },
      { name: "maxCount", type: "uint32" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const tokenAbi = [
  {
    type: "function",
    name: "balanceOfByPartition",
    stateMutability: "view",
    inputs: [
      { name: "partition", type: "bytes32" },
      { name: "tokenHolder", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getLockedAmountForByPartition",
    stateMutability: "view",
    inputs: [
      { name: "partition", type: "bytes32" },
      { name: "tokenHolder", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;
