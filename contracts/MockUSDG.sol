// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test stand-in for Paxos USDG (same 6 decimals) with a public faucet.
///         Only deployed on testnets/local chains where real USDG is hard to get.
contract MockUSDG is ERC20 {
    constructor() ERC20("Test USDG (faucet)", "tUSDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet() external {
        _mint(msg.sender, 1_000e6);
    }
}
