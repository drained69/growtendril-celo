const pad = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");

/** ERC-20 transfer(address,uint256) calldata, without pulling a web3 library into the page. */
export const transferCalldata = (to: string, amount: number | bigint) => `0xa9059cbb${pad(to.toLowerCase())}${pad(BigInt(amount).toString(16))}`;

/** ERC-20 balanceOf(address) calldata, for an eth_call through the visitor's own wallet. */
export const balanceOfCalldata = (owner: string) => `0x70a08231${pad(owner.toLowerCase())}`;
