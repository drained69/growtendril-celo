import { describe, expect, it, vi } from "vitest";
import { CELO } from "@/server/integrations/celo/config";
const data=vi.hoisted(()=>({logs: [] as {address:string;topics:string[];data:string}[],value:1000000000000000000n}));
const payer="0x1111111111111111111111111111111111111111", recipient="0x2222222222222222222222222222222222222222";
const tx=vi.hoisted(()=>({status:"success" as "success"|"reverted"|null,from:"0x1111111111111111111111111111111111111111"}));
vi.mock("viem", async original=>({...await original<typeof import("viem")>(),createPublicClient:()=>({getTransactionReceipt:async()=>(tx.status?{status:tx.status,logs:data.logs,blockNumber:1n}:null),getTransaction:async()=>({from:tx.from,to:recipient,value:data.value})})}));
vi.mock("@/server/integrations/celo/client",()=>({assertCeloMainnet:async()=>{}}));
describe("USDC receipt verification on Celo",()=>{
 it("never credits a native CELO transfer as USDC",async()=>{
  const {paymentInTx}=await import("@/server/domain/billing/celo");
  expect((await paymentInTx(`0x${"a".repeat(64)}`,recipient))?.amountMicro).toBe(0);
 });
 it("credits only Celo USDC contract logs at six decimals",async()=>{
  const {paymentInTx}=await import("@/server/domain/billing/celo");
  const event={address:recipient,topics:["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",`0x${payer.slice(2).padStart(64,"0")}`,`0x${recipient.slice(2).padStart(64,"0")}`],data:`0x${(2000000).toString(16).padStart(64,"0")}`};
  data.logs=[event];expect((await paymentInTx(`0x${"a".repeat(64)}`,recipient))?.amountMicro).toBe(0);
  data.logs=[{...event,address:CELO.usdc}];expect((await paymentInTx(`0x${"a".repeat(64)}`,recipient))?.amountMicro).toBe(2000000);
 });
 it("does not count USDC the recipient sends to itself, and names the wallet the USDC left",async()=>{
  const {paymentInTx}=await import("@/server/domain/billing/celo");
  const transfer=(from:string,to:string,micro:number)=>({address:CELO.usdc,topics:["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",`0x${from.slice(2).padStart(64,"0")}`,`0x${to.slice(2).padStart(64,"0")}`],data:`0x${micro.toString(16).padStart(64,"0")}`});
  tx.from=recipient;data.logs=[transfer(recipient,recipient,504313)];
  expect(await paymentInTx(`0x${"a".repeat(64)}`,recipient)).toMatchObject({amountMicro:0,from:recipient});
  const smartWallet="0x3333333333333333333333333333333333333333",relayer="0x4444444444444444444444444444444444444444";
  tx.from=relayer;data.logs=[transfer(smartWallet,recipient,504313)];
  expect(await paymentInTx(`0x${"a".repeat(64)}`,recipient)).toMatchObject({amountMicro:504313,from:smartWallet});
  tx.from=payer;
 });
 it("tells a failed transaction apart from one that isn't mined yet",async()=>{
  const {paymentInTx,txOutcome}=await import("@/server/domain/billing/celo");
  tx.status="reverted";
  expect(await paymentInTx(`0x${"a".repeat(64)}`,recipient)).toBeNull();
  expect(await txOutcome(`0x${"a".repeat(64)}`)).toBe("reverted");
  tx.status=null;expect(await txOutcome(`0x${"a".repeat(64)}`)).toBe("pending");
  tx.status="success";expect(await txOutcome(`0x${"a".repeat(64)}`)).toBe("success");
 });
});
