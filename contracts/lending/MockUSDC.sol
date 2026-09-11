// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/**
 * @notice Testnet-only stablecoin. Six decimals, freely mintable.
 * @dev Deliberately trivial: the interesting risk in this project lives in the collateral
 *      leg, not the cash leg. Anything shipped for real would point at a genuine USDC.
 */
contract MockUSDC {
    string public constant name = "Mock USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();
    error PermitExpired();
    error BadSignature();

    // ------------------------------------------------------------ EIP-2612

    /**
     * @dev Permit exists here for one reason: repaying a loan means moving the borrower's
     *      own stablecoin, and an employee whose account has never held gas cannot send an
     *      approve(). Without a signature-based approval the gasless story stops working at
     *      exactly the moment they try to give the money back.
     */
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    mapping(address => uint256) public nonces;

    /**
     * @notice EIP-712 domain separator, recomputed on every call rather than cached.
     * @dev Computed live so the separator stays correct if the chain id ever changes under
     *      the contract. Caching it in the constructor is the usual optimisation and the
     *      usual fork bug.
     */
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                    keccak256(bytes(name)),
                    keccak256(bytes("1")),
                    block.chainid,
                    address(this)
                )
            );
    }

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 sig_s
    ) external {
        if (block.timestamp > deadline) revert PermitExpired();
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline))
            )
        );
        address recovered = ecrecover(digest, v, r, sig_s);
        if (recovered == address(0) || recovered != owner) revert BadSignature();
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    /**
     * @notice Mints to any address. Anyone may call this.
     * @dev Unguarded ON PURPOSE, and the single clearest reason this contract must never
     *      leave testnet: it exists so a demo or a test can conjure the cash leg without a
     *      faucet. A real deployment points at genuine USDC and this contract is not used.
     */
    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @notice Standard ERC-20 approval. See `permit` for the gasless equivalent.
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /// @notice Standard ERC-20 transfer. Reverts on insufficient balance; never returns false.
    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    /**
     * @notice Standard ERC-20 transfer on someone else's behalf.
     * @dev An allowance of `type(uint256).max` is treated as infinite and is not decremented,
     *      matching USDC and most production tokens. The lending pool relies on this for its
     *      own approval, so changing it would silently start consuming that allowance.
     */
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] -= amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
