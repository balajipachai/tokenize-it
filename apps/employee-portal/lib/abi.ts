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

export const controllerEvents = [
  {
    type: "event",
    name: "TrancheVested",
    inputs: [
      { name: "grantId", type: "uint256", indexed: true },
      { name: "employee", type: "address", indexed: true },
      { name: "trancheIndex", type: "uint256", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

export const poolAbi = [
  { type: "function", name: "borrowFor", stateMutability: "nonpayable",
    inputs: [{ name: "partition", type: "bytes32" }, { name: "borrower", type: "address" }, { name: "holdId", type: "uint256" }],
    outputs: [{ type: "uint256" }] },
  { type: "function", name: "repayAllFor", stateMutability: "nonpayable",
    inputs: [{ name: "loanId", type: "uint256" }], outputs: [] },
  { type: "function", name: "loansOf", stateMutability: "view",
    inputs: [{ name: "borrower", type: "address" }], outputs: [{ type: "uint256[]" }] },
  { type: "function", name: "getLoan", stateMutability: "view", inputs: [{ name: "loanId", type: "uint256" }],
    outputs: [{ type: "tuple", components: [
      { name: "borrower", type: "address" }, { name: "partition", type: "bytes32" }, { name: "holdId", type: "uint256" },
      { name: "principal", type: "uint256" }, { name: "repaid", type: "uint256" }, { name: "openedAt", type: "uint64" },
      { name: "maturity", type: "uint64" }, { name: "aprBps", type: "uint16" }, { name: "status", type: "uint8" }] }] },
  { type: "function", name: "debtOf", stateMutability: "view", inputs: [{ name: "loanId", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ltvOf", stateMutability: "view", inputs: [{ name: "loanId", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "collateralValue", stateMutability: "view", inputs: [{ name: "tokens", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxLtvBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "aprBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "minTerm", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "available", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "permit", stateMutability: "nonpayable",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
             { name: "deadline", type: "uint256" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }],
    outputs: [] },
] as const;

export const protectedHoldAbi = [
  { type: "function", name: "protectedCreateHoldByPartition", stateMutability: "nonpayable",
    inputs: [
      { name: "partition", type: "bytes32" },
      { name: "from", type: "address" },
      { name: "protectedHold", type: "tuple", components: [
        { name: "hold", type: "tuple", components: [
          { name: "amount", type: "uint256" }, { name: "expirationTimestamp", type: "uint256" },
          { name: "escrow", type: "address" }, { name: "to", type: "address" }, { name: "data", type: "bytes" }] },
        { name: "deadline", type: "uint256" }, { name: "nonce", type: "uint256" }] },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ type: "bool" }, { type: "uint256" }] },
  { type: "function", name: "createHoldByPartition", stateMutability: "nonpayable",
    inputs: [
      { name: "partition", type: "bytes32" },
      { name: "hold", type: "tuple", components: [
        { name: "amount", type: "uint256" }, { name: "expirationTimestamp", type: "uint256" },
        { name: "escrow", type: "address" }, { name: "to", type: "address" }, { name: "data", type: "bytes" }] },
    ],
    outputs: [{ type: "bool" }, { type: "uint256" }] },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getHoldCountForByPartition", stateMutability: "view",
    inputs: [{ name: "p", type: "bytes32" }, { name: "h", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getConfigInfo", stateMutability: "view", inputs: [],
    outputs: [{ name: "resolver_", type: "address" }, { name: "configId_", type: "bytes32" }, { name: "version_", type: "uint256" }] },
  { type: "function", name: "arePartitionsProtected", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
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
    name: "getLockedAmountForByPartition",
    stateMutability: "view",
    inputs: [
      { name: "partition", type: "bytes32" },
      { name: "tokenHolder", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;
