import { describe, expect, it, vi } from "vitest";
import { CELO } from "@/server/integrations/celo/config";
const data=vi.hoisted(()=>({logs: [] as {address:string;topics:string[];data:string}[],value:1000000000000000000n}));
const payer="0x1111111111111111111111111111111111111111", recipient="0x2222222222222222222222222222222222222222";
vi.mock("viem", async original=>({...await original<typeof import("viem")>(),createPublicClient:()=>({getTransactionReceipt:async()=>({status:"success",logs:data.logs,blockNumber:1n}),getTransaction:async()=>({from:payer,to:recipient,value:data.value})})}));
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
});
