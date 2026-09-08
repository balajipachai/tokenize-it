# Problem - Tokenization of Anything

## Description
- Institutional adoption is the dominant narrative in the market right now, and tokenised collateral is the sharpest edge of it. Post tokenised treasuries against a repo agreement and the collateral leg becomes programmatic and provable instead of a parallel paper process.
- Build an enterprise finance application on Hedera using the Asset Tokenization Studio. Use the SDK as it stands, adapt it, extend the web application, or improve it. ATS supports ERC-3643 alongside ERC-1400, with compliance controls, corporate actions, and coupon handling already in the box. Real asset classes and real lifecycle management will be favoured over a token with a name on it.

## Idea

- When individuals join certain companies, they are given equities most widely knows an ESOPs (Employee Stock Options) which are vested depending on the vesting schedule set by the governing organizations.
- The idea is to tokenize ESOPs, have the vesting contract, use Privy for creating employee wallets (this gives the feel of web2 without any hassle of employees to create wallets, remember seed phrases).
- As soon as the tokenized ESOPs land into the employees wallet, they should be able to borrow against it. 
- To use Chainlink Oracles for asset pricing or NAVs
- To use scheduled Transactions for vesting, or maturity settlements.

## Deliverable

- Real asset classes (ESOPs) and real lifecycle management (issuance, vesting, freezing, kyc, withdrawing esops when employee leaves before completing the vesting tenure) will be favoured over a token with a name on it.

## References to be used for implementation

- [Asset Tokenization Studio](https://github.com/hashgraph/asset-tokenization-studio) I think most of the things are already present, we just have to figure out the steps like tokenizing ESOPs with all compliance checks in place, KYC gating of the employee, the ability to freeze ESOPs when they leave before the completion of the vesting period, the ability to reset this already tokenized ESOPs if the employee leaves mid-term to completion of their vesting period.
- [Asset Tokenization Studio - SDK](https://www.npmjs.com/package/@hashgraph/asset-tokenization-sdk)
- [scaffold-habr](https://github.com/hedera-dev/scaffold-hbar) For creating Hedera based projects
- [Hedera Tools](https://hedera.com/developer-tooling/)
- [Hedera Docs](https://docs.hedera.com/)
- [ATS Documentation](https://docs.hedera.com/solutions/tokenization/ats)





