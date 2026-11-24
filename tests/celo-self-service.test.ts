import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { selfIdentityGate } from "../services/signals-api/identity";
const agentAddress="0x1111111111111111111111111111111111111111";
const verified={valid:true,agentAddress,agentKey:`0x${"0".repeat(24)}${agentAddress.slice(2)}`,agentId:1n,nullifier:2n,agentCount:1n};
async function request(options: {valid?: boolean; payer?: string; unavailable?: boolean}={}) {
 const verify=vi.fn(async()=>{if(options.unavailable)throw new Error("RPC down");return {...verified,valid:options.valid??true};});
 const payment=options.payer?Buffer.from(JSON.stringify({x402Version:2,payload:{authorization:{from:options.payer}}})).toString("base64"):undefined;
 const headers:Record<string,string|undefined>={"payment-signature":payment,"x-self-agent-signature":"test-signature","x-self-agent-timestamp":String(Date.now())};
 const req={method:"GET",originalUrl:"/v1/company-intel?company=Acme",socket:{remoteAddress:"203.0.113.10"},get:(key:string)=>headers[key.toLowerCase()]} as unknown as Request;
 let status=200;const json=vi.fn();const next=vi.fn();
 const res={status:(value:number)=>{status=value;return res;},json} as unknown as Response;
 await selfIdentityGate({verify})(req,res,next);
 return {status,json,next,verify,req};
}
describe("Self identity is an enforced payment gate",()=>{
 it("rejects an unverified agent before payment middleware can run",async()=>{
  const result=await request({valid:false,payer:agentAddress});expect(result.status).toBe(401);expect(result.next).not.toHaveBeenCalled();
 });
 it("rejects a different payment payer even when identity is valid",async()=>{
  const result=await request({payer:"0x2222222222222222222222222222222222222222"});expect(result.status).toBe(403);expect(result.next).not.toHaveBeenCalled();
 });
 it("passes the exact path/query and grants the recovered identity to matching payers",async()=>{
  const result=await request({payer:agentAddress});expect(result.next).toHaveBeenCalledOnce();expect(result.req.agent?.address).toBe(agentAddress);
  expect(result.verify).toHaveBeenCalledWith(expect.objectContaining({method:"GET",url:"/v1/company-intel?company=Acme"}));
 });
 it("fails closed on identity RPC errors",async()=>{
  const result=await request({unavailable:true});expect(result.status).toBe(503);expect(result.next).not.toHaveBeenCalled();
 });
});
