import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { fromDataSuffix } from "@celo/attribution-tags";
import { CELO, custodyProblem, platformCustody } from "@/server/integrations/celo/config";
import { attributionSuffix } from "@/server/integrations/celo/client";
import { signerFor } from "@/server/integrations/celo/signer";
import { createSelfVerifier } from "@/server/integrations/celo/self";

const transport = vi.hoisted(() => ({price: "10000", network: "eip155:42220", asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", recovered: "", requests: 0}));
const seller = "0x2222222222222222222222222222222222222222";
const hash = `0x${"a".repeat(64)}`;
vi.mock("@/server/security/public-http", async original => ({
  ...await original<typeof import("@/server/security/public-http")>(),
  getPublicText: async (_url: string, options: {headers: Record<string,string>}) => {
    transport.requests++;
    const signature = options.headers["Payment-Signature"];
    if (!signature) return {status: 402, ok: false, headers: {"payment-required": Buffer.from(JSON.stringify({x402Version: 2, resource: {url: "https://research.example.com/", description: "Company enrichment"}, accepts: [{scheme: "exact", network: transport.network, asset: transport.asset, amount: transport.price, payTo: seller, maxTimeoutSeconds: 300, extra: {name: "USDC", version: "2"}}]})).toString("base64")}, text: ""};
    const payment = JSON.parse(Buffer.from(signature,"base64").toString());
    const authorization = payment.payload.authorization;
    transport.recovered = await recoverTypedDataAddress({
      domain: {name: "USDC", version: "2", chainId: 42220, verifyingContract: CELO.usdc},
      types: {TransferWithAuthorization: [{name:"from",type:"address"},{name:"to",type:"address"},{name:"value",type:"uint256"},{name:"validAfter",type:"uint256"},{name:"validBefore",type:"uint256"},{name:"nonce",type:"bytes32"}]},
      primaryType: "TransferWithAuthorization", message: authorization, signature: payment.payload.signature,
    });
    return {status: 200, ok: true, text: '{"signals":[]}', headers: {"payment-response": Buffer.from(JSON.stringify({success:true,transaction:hash,network:CELO.caip2,payer:authorization.from})).toString("base64")}};
  },
}));
// No live RPC or payments in unit tests. The signer and x402 encoding remain real.
vi.mock("@/server/integrations/celo/client", async original => ({...await original<typeof import("@/server/integrations/celo/client")>(), assertCeloMainnet: async () => {}}));
afterEach(() => {vi.unstubAllEnvs(); transport.price="10000"; transport.network=CELO.caip2; transport.asset=CELO.usdc;});
const key = `0x${"11".repeat(32)}` as const;
function configure() {vi.stubEnv("CELO_AGENT_PRIVATE_KEY",key);vi.stubEnv("CELO_AGENT_PROJECT_ID","workspace");vi.stubEnv("CELO_ATTRIBUTION_CODE","celo_entry123");vi.stubEnv("SELF_AGENT_ENABLED","0");}

describe("Celo deployment payment boundaries", () => {
  it("requires the workspace binding and event tag before enabling custody", () => {
    vi.stubEnv("CELO_AGENT_PRIVATE_KEY",key);vi.stubEnv("CELO_AGENT_PROJECT_ID","");
    expect(platformCustody()).toBeNull(); expect(custodyProblem()).toContain("workspace");
    configure(); expect(platformCustody()).toBe("celo");
    expect(fromDataSuffix(attributionSuffix())?.codes).toContain("celo_entry123");
  });
  it("refuses historical wallets and wrong signer addresses", () => {
    configure();
    const wallet={provider:"celo_eoa",address:privateKeyToAccount(key).address,circleWalletId:null,blockchain:"CELO",dataMode:"LIVE"};
    expect(signerFor(wallet)).not.toBeNull();
    expect(signerFor({...wallet,blockchain:"ARC"})).toBeNull();
    expect(signerFor({...wallet,address:seller})).toBeNull();
  });
  it("signs Celo USDC with the official x402 scheme and returns an onchain hash", async () => {
    configure();
    const {quote,pay}=await import("@/server/integrations/celo/x402");
    const q=await quote("https://research.example.com/");if(q.kind!=="quote")throw new Error("quote missing");
    const signer=signerFor({provider:"celo_eoa",address:privateKeyToAccount(key).address,circleWalletId:null,blockchain:"CELO",dataMode:"LIVE"})!;
    expect((await pay(q.quote,signer,{maxAmountMicro:10000})).settlementId).toBe(hash);
    expect(transport.recovered.toLowerCase()).toBe(signer.address.toLowerCase());
    const sign=vi.spyOn(signer,"signTypedData");
    await expect(pay({...q.quote,amountMicro:10001},signer,{maxAmountMicro:10000})).rejects.toThrow(/exceeds/);
    expect(sign).not.toHaveBeenCalled();
  });
  it("rejects other networks and assets before signing", async () => {
    const {quote}=await import("@/server/integrations/celo/x402");
    transport.network="eip155:5042";expect((await quote("https://research.example.com/")).kind).toBe("unsupported");
    transport.network=CELO.caip2;transport.asset=seller;expect((await quote("https://research.example.com/")).kind).toBe("unsupported");
  });
  it("fails Self verification for missing or expired signatures before network access", async () => {
    const verify=createSelfVerifier();
    expect((await verify.verify({signature:"",timestamp:"",method:"GET",url:"/v1/company-intel"})).valid).toBe(false);
    expect((await verify.verify({signature:"0x1234",timestamp:"1",method:"GET",url:"/v1/company-intel"})).valid).toBe(false);
  });
});
