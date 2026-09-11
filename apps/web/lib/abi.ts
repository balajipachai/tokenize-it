/** Only the pieces this app reads or relays. Full ABIs live in the contracts package. */

/**
 * ONE definition per contract, shared by the employee and issuer sides of this app.
 *
 * They used to be two files in two apps, and they drifted: the issuer copy of `getGrant`
 * stopped at `leaver`, omitting the three dispute fields. Because every preceding field is
 * fixed-width, viem decoded the short tuple without complaint and the console simply could
 * not see that a dispute window existed — clicking clawback inside one produced a contract
 * refusal and no explanation. A single definition is the fix that stays fixed.
 */
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
  // The employee's side of the appeal. Callable by them or by a dispute relayer, because
  // someone just terminated is exactly the person least likely to have gas.
  {
    type: "function",
    name: "raiseDispute",
    stateMutability: "nonpayable",
    inputs: [{ name: "grantId", type: "uint256" }],
    outputs: [],
  },
] as const;

/**
 * PayrollDisburser. Shared by the issuer side, which funds runs, and the employee side,
 * which collects — one definition, for the same reason the controller has one.
 */
export const payrollAbi = [
  { type: "function", name: "fundRun", stateMutability: "nonpayable",
    inputs: [{ type: "address[]" }, { type: "uint256[]" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "accrued", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "lifetimeEarned", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalAccrued", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }] },
  // Delivered BY the relayer, TO the employee. The contract sends only ever to `employee`,
  // so the relayer chooses when someone is paid and never whether, how much, or to whom.
  { type: "function", name: "withdrawFor", stateMutability: "nonpayable",
    inputs: [{ name: "employee", type: "address" }], outputs: [{ type: "uint256" }] },
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
  // Places the signed hold AND opens the loan in one transaction, so a failure cannot leave
  // the borrower's shares held against a loan that never opened.
  { type: "function", name: "pledgeAndBorrow", stateMutability: "nonpayable",
    inputs: [
      { name: "partition", type: "bytes32" },
      { name: "borrower", type: "address" },
      { name: "protectedHold", type: "tuple", components: [
        { name: "hold", type: "tuple", components: [
          { name: "amount", type: "uint256" },
          { name: "expirationTimestamp", type: "uint256" },
          { name: "escrow", type: "address" },
          { name: "to", type: "address" },
          { name: "data", type: "bytes" },
        ] },
        { name: "deadline", type: "uint256" },
        { name: "nonce", type: "uint256" },
      ] },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ type: "uint256" }] },
  // Kept for opening a loan against a hold that already exists — the self-service path, and
  // recovery for anything stranded before pledgeAndBorrow existed.
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

/** The ATS diamond, employee reads and issuer writes together. */
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
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getMaxSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
