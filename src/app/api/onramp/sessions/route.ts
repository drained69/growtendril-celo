import { NextResponse } from "next/server";
export async function POST(_req: Request) {return NextResponse.json({error: "Fund your workspace with USDC on Celo mainnet"}, {status: 503});}
