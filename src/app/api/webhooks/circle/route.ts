import { NextResponse } from "next/server";
export async function POST(_req: Request) {return NextResponse.json({error: "Legacy Circle webhooks are disabled on the Celo deployment"}, {status: 410});}
export async function GET() {return NextResponse.json({error: "Gone"}, {status: 410});}
