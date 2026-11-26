"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createPublicClient, createWalletClient, custom, http, keccak256, parseAbi, toHex, type Address, type EIP1193Provider, type Hex } from "viem";
import { celo } from "viem/chains";
import { isOutcomeEscrowCode, OUTCOME_ESCROW_ABI } from "@growth-tools/escrow";
import { Button, Field, Input } from "@/components/ui";
import { CopyField } from "@/components/ui/copy";
import { fmtUsdc } from "@/lib/money";
import { confirmEscrowFundingAction } from "@/server/actions/celo-rails";

const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as Address;
const ERC20 = parseAbi(["function approve(address spender,uint256 amount) returns (bool)"]);
const readonly = createPublicClient({ chain:celo, transport:http("https://forno.celo.org",{timeout:15_000,retryCount:1}) });
const ZERO = "0x0000000000000000000000000000000000000000";
export interface EscrowTerms { salt:string; campaignId:string|null; owner:string|null; termsHash:string; budgetMicro:number; deadline:number; baseMicro:number; qualityBonusMicro:number; outcomeBonusMicro:number; outcomeCap:number; slots:number }
export interface EscrowReward { id:string; recipient:string; score:number; outcomes:number; amountMicro:number; evidenceHash:string }
type Kind="approve"|"fund"|"queue"|"claim"|"refund"|"reduce"|"dispute"|"resolveRelease"|"resolveReject";

/** Every action here is signed in the user's own wallet on Celo mainnet. GrowTendril never holds these funds. */
export function EscrowControls({ programId, contract, attribution, terms, rewards, canManage }: { programId:string; contract:string|null; attribution:Hex|null; terms:EscrowTerms; rewards:EscrowReward[]; canManage:boolean }) {
  const [arbiter,setArbiter]=useState(""),[busy,setBusy]=useState(false),[message,setMessage]=useState(""),[lastHash,setLastHash]=useState<string|null>(null);
  const router=useRouter();
  const funded=!!terms.campaignId;
  async function bind(owner:Address) {
    const saved=await confirmEscrowFundingAction(programId,owner);
    if(!saved.ok)throw new Error(saved.error);
    router.refresh();
  }
  async function action(kind:Kind,reward?:EscrowReward) {
    setBusy(true);setMessage("");
    let submittedHash: string | null = null;
    try {
      if(!contract || !/^0x[\da-f]{40}$/i.test(contract))throw new Error("Escrow is not deployed yet");
      const escrow=contract as Address;
      const provider=(window as unknown as {ethereum?:EIP1193Provider}).ethereum;
      if(!provider)throw new Error("Open a browser with an EVM wallet to use escrow.");
      const client=createWalletClient({chain:celo,transport:custom(provider)});
      const [account]=await client.requestAddresses();
      if(!account)throw new Error("Connect a wallet");
      try { await client.switchChain({id:celo.id}); }
      catch(e) { if((e as {code?:number}).code!==4902)throw e; await client.addChain({chain:celo}); await client.switchChain({id:celo.id}); }
      if(await client.getChainId()!==celo.id || await readonly.getChainId()!==celo.id)throw new Error("Select Celo mainnet in your wallet");
      const code=await readonly.getCode({address:escrow});
      if(!code || !isOutcomeEscrowCode(code))throw new Error("The configured contract does not match the reviewed OutcomeRewardsEscrow.");
      const [token,hold]=await Promise.all([readonly.readContract({address:escrow,abi:OUTCOME_ESCROW_ABI,functionName:"token"}),readonly.readContract({address:escrow,abi:OUTCOME_ESCROW_ABI,functionName:"refundHold"})]);
      if(token.toLowerCase()!==USDC.toLowerCase()||hold!==259200n)throw new Error("Escrow must use Celo USDC and a 72-hour refund hold");
      const salt=terms.salt as Hex;
      const id=(terms.campaignId??await readonly.readContract({address:escrow,abi:OUTCOME_ESCROW_ABI,functionName:"campaignKey",args:[account,salt]})) as Hex;
      if(kind==="approve" || kind==="fund") {
        if(funded)throw new Error("This escrow campaign is already funded");
        const campaign=await readonly.readContract({address:escrow,abi:OUTCOME_ESCROW_ABI,functionName:"campaigns",args:[id]});
        if(campaign[0]!==ZERO){await bind(account);setMessage("This wallet's funded campaign is now linked.");return;}
        if(Date.now()/1000>=terms.deadline)throw new Error("Fund before the campaign ends");
      } else if(!funded) throw new Error("Fund this campaign first");
      const r=reward?keccak256(toHex(reward.id)):undefined;
      let hash:Hex;
      const send=async(request:Parameters<typeof client.writeContract>[0])=>client.writeContract({...request,...(attribution?{dataSuffix:attribution}:{})} as Parameters<typeof client.writeContract>[0]);
      if(kind==="approve") {
        if(!window.confirm(`Allow the escrow contract to take exactly ${fmtUsdc(terms.budgetMicro)} of real USDC from this wallet on Celo mainnet?`))return;
        const {request}=await readonly.simulateContract({account,address:USDC,abi:ERC20,functionName:"approve",args:[escrow,BigInt(terms.budgetMicro)]});
        hash=await send(request);
      } else if(kind==="fund") {
        if(!/^0x[\da-f]{40}$/i.test(arbiter)||/^0x0{40}$/i.test(arbiter)||arbiter.toLowerCase()===account.toLowerCase())throw new Error("Choose a separate, nonzero dispute arbiter wallet");
        if(!window.confirm(`Move ${fmtUsdc(terms.budgetMicro)} of real USDC into escrow on Celo mainnet? If this arbiter stays silent for 14 days after a dispute, the creator can claim.`))return;
        const {request}=await readonly.simulateContract({account,address:escrow,abi:OUTCOME_ESCROW_ABI,functionName:"createCampaign",args:[salt,arbiter as Address,BigInt(terms.deadline),BigInt(terms.budgetMicro),BigInt(terms.baseMicro),BigInt(terms.qualityBonusMicro),BigInt(terms.outcomeBonusMicro),BigInt(terms.outcomeCap),BigInt(terms.slots),terms.termsHash as Hex]});
        hash=await send(request);
      } else if(kind==="queue" && reward && r) {
        const {request}=await readonly.simulateContract({account,address:escrow,abi:OUTCOME_ESCROW_ABI,functionName:"queueReward",args:[id,r,reward.recipient as Address,BigInt(reward.score),BigInt(reward.outcomes),reward.evidenceHash as Hex]});
        hash=await send(request);
      } else if(kind==="claim" && r) {
        const {request}=await readonly.simulateContract({account,address:escrow,abi:OUTCOME_ESCROW_ABI,functionName:"claim",args:[id,r]});
        hash=await send(request);
      } else if(kind==="reduce" && reward && r) {
        const {request}=await readonly.simulateContract({account,address:escrow,abi:OUTCOME_ESCROW_ABI,functionName:"reduceOutcomes",args:[id,r,BigInt(reward.outcomes),reward.evidenceHash as Hex]});
        hash=await send(request);
      } else if(kind==="dispute" && r) {
        const {request}=await readonly.simulateContract({account,address:escrow,abi:OUTCOME_ESCROW_ABI,functionName:"dispute",args:[id,r]});
        hash=await send(request);
      } else if((kind==="resolveRelease" || kind==="resolveReject") && r) {
        const {request}=await readonly.simulateContract({account,address:escrow,abi:OUTCOME_ESCROW_ABI,functionName:"resolve",args:[id,r,kind==="resolveRelease"]});
        hash=await send(request);
      } else if(kind==="refund") {
        const {request}=await readonly.simulateContract({account,address:escrow,abi:OUTCOME_ESCROW_ABI,functionName:"refundUnused",args:[id]});
        hash=await send(request);
      } else throw new Error("Unknown escrow action");
      submittedHash = hash;setLastHash(hash);setMessage("Submitted on Celo. Waiting for confirmation…");
      const receipt=await readonly.waitForTransactionReceipt({hash,timeout:60_000});
      if(receipt.status!=="success"){setMessage("The transaction reverted on Celo. No escrow state changed.");return;}
      if(kind==="fund")await bind(account);
      setMessage("Confirmed on Celo.");
    } catch(e) {setMessage(submittedHash?"Could not confirm this action. Check its transaction before retrying.":e instanceof Error?e.message.slice(0,220):"The escrow action could not be completed.");}
    finally{setBusy(false);}
  }
  const off=busy||!contract;
  return <div className="space-y-4">
    <p className="text-sm text-ink-2">{fmtUsdc(terms.budgetMicro)} on Celo mainnet · 72-hour refund hold · seven-day final review · disputes time out after 14 days.</p>
    {!contract?<p className="text-sm text-ink-3">Escrow funding opens once the contract is deployed on Celo mainnet.</p>:<CopyField value={contract} />}
    {terms.campaignId&&<CopyField value={terms.campaignId} />}
    {canManage&&<>{!funded&&<Field label="Independent dispute arbiter" htmlFor="escrow-arbiter"><Input id="escrow-arbiter" value={arbiter} onChange={e=>setArbiter(e.target.value)} placeholder="0x…" disabled={busy} /></Field>}<div className="flex flex-wrap gap-2">{!funded&&<><Button disabled={off} onClick={()=>action("approve")}>1. Approve exact USDC budget</Button><Button disabled={off} onClick={()=>action("fund")}>2. Fund escrow</Button></>}{funded&&<Button disabled={off} variant="ghost" onClick={()=>action("refund")}>Return unused funds</Button>}</div></>}
    <p className="text-xs text-ink-3">These are real funds, held by the contract and separate from your workspace contract. The contract bounds rewards; the business attests quality and customer outcomes.</p>
    {rewards.map(r=><div key={r.id} className="space-y-2 rounded-xl border border-line p-3"><p className="text-sm">{fmtUsdc(r.amountMicro)} · quality {r.score}/100 · {r.outcomes} eligible actions</p><code className="block break-all text-xs">{r.recipient}</code><div className="flex flex-wrap gap-2">{canManage&&<><Button disabled={off||!funded} onClick={()=>action("queue",r)}>Approve and queue reward</Button><Button disabled={off||!funded} variant="ghost" onClick={()=>action("reduce",r)}>Apply refunded outcomes</Button></>}<Button disabled={off||!funded} variant="ghost" onClick={()=>action("claim",r)}>Claim after refund hold</Button><Button disabled={off||!funded} variant="ghost" onClick={()=>action("dispute",r)}>Dispute before hold ends</Button>{canManage&&<><Button disabled={off||!funded} variant="ghost" onClick={()=>action("resolveRelease",r)}>Arbiter: release</Button><Button disabled={off||!funded} variant="ghost" onClick={()=>action("resolveReject",r)}>Arbiter: reject</Button></>}</div></div>)}
    {message&&<p role="status" className="text-sm text-ink-2">{message}</p>}
    {lastHash&&<a className="break-all text-xs underline" href={`https://celoscan.io/tx/${lastHash}`} target="_blank" rel="noopener noreferrer">View transaction {lastHash}</a>}
  </div>;
}
