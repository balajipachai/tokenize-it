// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IAtsEsop} from "../interfaces/IAtsEsop.sol";
import {IERC20Minimal} from "../interfaces/IERC20Minimal.sol";

/**
 * @title PayrollDisburser
 * @notice Pays employees in stablecoin, and records every payslip on chain.
 *
 * @dev This closes a hole in the rest of the product rather than adding a feature beside it.
 *      An employee can borrow against vested equity, but interest accrues from the first
 *      second, so they owe more than they borrowed the moment the loan opens. Nothing in the
 *      system produced income, which meant the borrowed funds could never repay the loan and
 *      the demo needed a faucet to finish. Salary is the missing half.
 *
 *      ── Accrue, then withdraw. Not loop-and-send. ──
 *
 *      A run credits balances; it does not push transfers. Looping transfers over a payroll
 *      is the classic multi-party push payment and it fails two ways: one blocked recipient
 *      reverts everybody's salary, and gas grows with headcount until a run cannot fit in a
 *      block. Neither is acceptable for the thing that pays people.
 *
 *      Pure pull would fail differently here — employees hold Privy embedded wallets that have
 *      never paid gas, so "come and claim it" would make salary conditional on owning HBAR.
 *      `withdrawFor` resolves that: the payroll relayer delivers, the employee signs nothing,
 *      and the funds still only ever move to the employee. Same shape as `repayAllFor` in the
 *      lending pool.
 *
 *      ── Where the controls live ──
 *
 *      Approval is NOT modelled here. The treasury is a Privy server wallet whose key quorum
 *      gates signing, so by the time a run reaches this contract the approvals already
 *      happened. Duplicating that on chain would be a second quorum to keep in sync and to
 *      get wrong.
 *
 *      What IS enforced here is the thing a policy cannot be trusted to hold alone: a
 *      recipient must be on the issuer's allowlist. Payroll can only pay people already
 *      inside the compliance perimeter, and that check lives in bytecode rather than in a
 *      dashboard setting somebody can widen.
 */
contract PayrollDisburser is ReentrancyGuard {
    // CEI ordering is the primary defence below; OpenZeppelin's `nonReentrant` is the second
    // layer, because the stablecoin is a third-party contract we do not control.

    // ----------------------------------------------------------------- config

    /// @notice The stablecoin salaries are paid in.
    IERC20Minimal public immutable stable;

    /// @notice The ESOP token, consulted ONLY for its allowlist. No equity moves through here.
    IAtsEsop public immutable esop;

    /// @notice The Privy server wallet that funds runs. Its key quorum is the approval gate.
    address public treasury;

    address public admin;
    address public pendingAdmin;

    /// @notice May deliver an employee's accrued salary on their behalf.
    mapping(address => bool) public isPayoutRelayer;

    /// @notice Salary earned and not yet delivered.
    mapping(address => uint256) public accrued;

    /// @notice Everything ever accrued to an employee, delivered or not. A payslip history.
    mapping(address => uint256) public lifetimeEarned;

    /// @notice Sum of every unwithdrawn balance, so a shortfall is visible before it bites.
    uint256 public totalAccrued;

    uint256 public nextRunId = 1;

    // ----------------------------------------------------------------- events

    event RunFunded(uint256 indexed runId, uint256 recipients, uint256 total, address indexed fundedBy);
    event SalaryAccrued(uint256 indexed runId, address indexed employee, uint256 amount);
    event SalaryWithdrawn(address indexed employee, address indexed deliveredBy, uint256 amount);
    event TreasurySet(address indexed treasury);
    event PayoutRelayerSet(address indexed account, bool enabled);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

    // ----------------------------------------------------------------- errors

    error NotAdmin();
    error NotPendingAdmin();
    error NotTreasury();
    error NotEntitled();
    error ZeroAddress();
    error ZeroAmount();
    error EmptyRun();
    error LengthMismatch(uint256 recipients, uint256 amounts);
    error NotAllowlisted(address employee);
    error NothingAccrued(address employee);
    error TransferFailed();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /**
     * @notice Deploys the disburser against one stablecoin, one ESOP token and one treasury.
     *
     * @dev The ESOP token is here for its allowlist, not its equity. `fundRun` checks
     *      `isInControlList` for every recipient, which ties payroll to the same compliance
     *      roster that governs share transfers: onboarding someone once makes them both a
     *      valid shareholder and a payable employee, and suspending them stops both.
     *
     *      `treasury` is expected to be a Privy quorum-owned wallet rather than a single key,
     *      so that no one officer can run payroll alone. Nothing here enforces that — a
     *      contract cannot tell a quorum wallet from an EOA — which is why the quorum and its
     *      policy live in Privy and this contract only names the address.
     *
     * @param _stable   Stablecoin salaries are paid in. The same one the lending pool lends.
     * @param _esop     ESOP token whose allowlist decides who may be paid.
     * @param _treasury Address permitted to fund runs. Rotatable via `setTreasury`.
     * @param _admin    First admin. Appoints relayers and rotates the treasury.
     */
    constructor(IERC20Minimal _stable, IAtsEsop _esop, address _treasury, address _admin) {
        if (address(_stable) == address(0) || address(_esop) == address(0)) revert ZeroAddress();
        if (_treasury == address(0) || _admin == address(0)) revert ZeroAddress();
        stable = _stable;
        esop = _esop;
        treasury = _treasury;
        admin = _admin;
        emit TreasurySet(_treasury);
    }

    // ------------------------------------------------------------------ admin

    /**
     * @notice Points the contract at a new funding wallet.
     *
     * @dev The rotation path when officers change or a treasury key is suspected. Takes
     *      effect immediately and the old treasury loses the ability to run payroll in the
     *      same transaction, which is the point — a rotation that left the previous wallet
     *      able to pay people would not be a rotation.
     *
     *      Does not touch salary already accrued. Employees still collect what they earned
     *      under the old treasury, from the balance already sitting here.
     */
    function setTreasury(address newTreasury) external onlyAdmin {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
        emit TreasurySet(newTreasury);
    }

    /**
     * @notice Appoints or removes an address allowed to deliver salaries on employees' behalf.
     * @dev A narrow power by construction: a relayer chooses WHEN someone is paid, never
     *      whether, how much, or to whom — `_deliver` always sends to the employee. The worst
     *      a rogue relayer can do is pay people their own money sooner than they asked.
     */
    function setPayoutRelayer(address account, bool enabled) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        isPayoutRelayer[account] = enabled;
        emit PayoutRelayerSet(account, enabled);
    }

    /**
     * @notice Step one of a two-step admin handover. Nothing changes until `acceptAdmin`.
     * @dev Two-step because this role can redirect the treasury. A one-step transfer to a
     *      typo'd address would leave payroll permanently pointed at a wallet nobody holds.
     */
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    /// @notice Step two of the handover: the incoming admin claims the role.
    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        emit AdminTransferred(admin, pendingAdmin);
        admin = pendingAdmin;
        pendingAdmin = address(0);
    }

    // ---------------------------------------------------------------- payroll

    /**
     * @notice Runs payroll: pulls the total from the treasury once and credits each employee.
     *
     * @dev One `transferFrom` for the whole run rather than one per employee. That is the
     *      difference between a run that costs a predictable amount and one whose cost — and
     *      failure modes — scale with headcount. On Hedera the batching matters twice over:
     *      §5.1 measured batched tranche funding at ~230k gas against ~425k done singly.
     *
     *      The allowlist check is per recipient and reverts the run rather than skipping the
     *      offender. Silently dropping someone from payroll is a worse outcome than refusing
     *      the batch: a reverted run is visible and fixable, a missing payslip is neither.
     *
     * @param recipients Employees to pay. Each must be on the issuer's allowlist.
     * @param amounts    Salary per employee, in the stablecoin's own decimals.
     * @return runId     Identifier carried by every event this run emits.
     */
    function fundRun(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external nonReentrant returns (uint256 runId) {
        if (msg.sender != treasury) revert NotTreasury();
        if (recipients.length == 0) revert EmptyRun();
        if (recipients.length != amounts.length) revert LengthMismatch(recipients.length, amounts.length);

        runId = nextRunId++;

        uint256 total;
        for (uint256 i; i < recipients.length; ++i) {
            address employee = recipients[i];
            uint256 amount = amounts[i];
            if (employee == address(0)) revert ZeroAddress();
            if (amount == 0) revert ZeroAmount();
            if (!esop.isInControlList(employee)) revert NotAllowlisted(employee);

            total += amount;
            accrued[employee] += amount;
            lifetimeEarned[employee] += amount;
            emit SalaryAccrued(runId, employee, amount);
        }

        totalAccrued += total;
        emit RunFunded(runId, recipients.length, total, msg.sender);

        // Effects above, interaction here. The pull is last so a hostile token cannot observe
        // a half-written run, and it is a single call so the run either funds or does not.
        if (!stable.transferFrom(msg.sender, address(this), total)) revert TransferFailed();
    }

    /**
     * @notice Collects your own salary.
     * @dev Pays the whole accrued balance; there is no partial withdrawal, because a salary
     *      is not a position to manage. Reverts with `NothingAccrued` rather than paying zero,
     *      so a UI can tell "already collected" from "a run silently failed".
     * @return amount Stablecoin delivered, in the stablecoin's own decimals.
     */
    function withdraw() external nonReentrant returns (uint256 amount) {
        return _deliver(msg.sender);
    }

    /**
     * @notice Delivers an employee's salary on their behalf.
     * @dev The reason this exists: employees hold wallets that have never paid gas, so making
     *      them transact to be paid would put salary behind owning HBAR. The relayer submits;
     *      the funds still only ever go to `employee`, so the worst a rogue relayer can do is
     *      pay someone their own money earlier than they asked.
     */
    function withdrawFor(address employee) external nonReentrant returns (uint256 amount) {
        if (msg.sender != employee && !isPayoutRelayer[msg.sender] && msg.sender != admin) revert NotEntitled();
        return _deliver(employee);
    }

    function _deliver(address employee) private returns (uint256 amount) {
        amount = accrued[employee];
        if (amount == 0) revert NothingAccrued(employee);

        // Zeroed before the transfer, so a re-entrant call finds nothing left to take.
        accrued[employee] = 0;
        totalAccrued -= amount;
        emit SalaryWithdrawn(employee, msg.sender, amount);

        if (!stable.transfer(employee, amount)) revert TransferFailed();
    }

    // ------------------------------------------------------------------ views

    /**
     * @notice Stablecoin held here beyond what is owed to employees.
     * @dev Should be zero in normal operation. Anything else means a stray transfer arrived,
     *      or that accounting and balance have diverged — worth being able to see rather than
     *      having to infer.
     */
    function surplus() external view returns (uint256) {
        uint256 balance = stable.balanceOf(address(this));
        return balance > totalAccrued ? balance - totalAccrued : 0;
    }

    /**
     * @notice Whether every accrued salary could actually be paid right now.
     * @dev True is the normal state and is not a promise about the future — `fundRun` pulls
     *      cash in the same transaction that credits employees, so the only ways this goes
     *      false are a token that takes a fee on transfer, or a balance leaving by some route
     *      this contract does not control. Worth checking before a run rather than after.
     */
    function isSolvent() external view returns (bool) {
        return stable.balanceOf(address(this)) >= totalAccrued;
    }
}
