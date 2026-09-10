/** The issuer-side surface: everything HR needs to run a grant's lifecycle. */

export const controllerAbi = [
  {
    type: "function",
    name: "createGrant",
    stateMutability: "nonpayable",
    inputs: [
      { name: "employee", type: "address" },
      { name: "partition", type: "bytes32" },
      { name: "amounts", type: "uint128[]" },
      { name: "vestsAt", type: "uint64[]" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "fundTranches",
    stateMutability: "nonpayable",
    inputs: [
      { name: "grantId", type: "uint256" },
      { name: "maxCount", type: "uint32" },
    ],
    outputs: [{ type: "uint32" }],
  },
  {
    type: "function",
    name: "terminate",
    stateMutability: "nonpayable",
    inputs: [
      { name: "grantId", type: "uint256" },
      { name: "leaver", type: "uint8" },
      { name: "effectiveAt", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "clawback",
    stateMutability: "nonpayable",
    inputs: [
      { name: "grantId", type: "uint256" },
      { name: "maxCount", type: "uint32" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "nextGrantId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "isGrantAdmin",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bool" }],
  },
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
          // These three were missing, so the console could not see that a dispute window
          // existed at all: clicking clawback inside it produced a contract refusal and no
          // explanation, because nothing here knew there was anything to explain.
          { name: "dispute", type: "uint8" },
          { name: "disputeDeadline", type: "uint64" },
          { name: "terminatedBy", type: "address" },
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
] as const;

export const tokenAbi = [
  {
    type: "function",
    name: "grantKyc",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "vcId", type: "string" },
      { name: "validFrom", type: "uint256" },
      { name: "validTo", type: "uint256" },
      { name: "issuer", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "revokeKyc",
    stateMutability: "nonpayable",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "addToControlList",
    stateMutability: "nonpayable",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "setAddressFrozen",
    stateMutability: "nonpayable",
    inputs: [
      { name: "userAddress", type: "address" },
      { name: "freezeStatus", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "addIssuer",
    stateMutability: "nonpayable",
    inputs: [{ name: "issuer", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "isIssuer",
    stateMutability: "view",
    inputs: [{ name: "issuer", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "getKycFor",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "validFrom", type: "uint256" },
          { name: "validTo", type: "uint256" },
          { name: "vcId", type: "string" },
          { name: "issuer", type: "address" },
          { name: "status", type: "uint8" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "isInControlList",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bool" }],
  },
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
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getMaxSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
