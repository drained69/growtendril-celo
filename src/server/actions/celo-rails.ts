"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";
import { schema as s } from "@/server/db/client";
import { audit } from "@/server/db/helpers";
import { toMicro } from "@/lib/money";
import { fail, guard, limited, type ActionResult } from "@/server/actions/_common";
import { keyIsOnAccount, prepareSession, sessionGrant, type SessionGrant } from "@/server/integrations/celo/altana";
import { formatPayout, isPayoutToken, PAYOUT_TOKEN_KEYS, type PayoutToken } from "@/server/integrations/celo/corridors";
import { previewCorridor } from "@/server/integrations/celo/textile";
import { attachAltanaWallet, getWallet, setAltanaWalletStatus } from "@/server/integrations/celo/wallets";
import { campaignMatchesTerms, readFundedCampaign } from "@/server/integrations/celo/escrow";
import { escrowPreview } from "@/server/domain/growth/escrow-preview";

const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).nullable();
const grantInput = z.object({
  capUsd: z.string().regex(/^\d{1,6}(\.\d{1,2})?$/, "Enter a cap in dollars, such as 25"),
  period: z.enum(["day", "week", "month"]),
  days: z.number().int().min(1).max(90),
  tokens: z.array(z.string()).max(PAYOUT_TOKEN_KEYS.length),
});

export async function saveAltanaWalletAction(address: string): Promise<ActionResult> {
  try {
    // Only the workspace owner decides which wallet holds the team's money.
    const { project, db, user } = await guard("manage_workspace");
    await limited("altana-wallet");
    if (!isAddress(address)) return { ok: false, error: "The wallet address is invalid" };
    await attachAltanaWallet(db, { projectId: project.id, userId: user.id, address: getAddress(address) });
    revalidatePath("/app", "layout");
    return { ok: true, message: "Altana wallet connected" };
  } catch (e) {
    return fail(e);
  }
}

export interface PreparedSession { id: string; publicKey: string; sessionAddress: string; expiry: number; permissions: SessionGrant; skipped: string[] }

/** The server creates the agent key and limits. The owner's passkey then grants them directly onchain. */
export async function prepareAltanaSessionAction(input: z.input<typeof grantInput>): Promise<ActionResult<PreparedSession>> {
  try {
    const { project, db, user } = await guard("manage_wallet");
    await limited("altana-session");
    const v = grantInput.parse(input);
    const wallet = await getWallet(db, project.id);
    if (wallet?.provider !== "altana" || !wallet.address) return { ok: false, error: "Create an Altana wallet first" };
    const capMicro = toMicro(v.capUsd);
    if (capMicro <= 0) return { ok: false, error: "Choose a spending cap above zero" };
    const localCaps: Partial<Record<PayoutToken, bigint>> = {};
    const skipped: string[] = [];
    await Promise.all(v.tokens.filter(isPayoutToken).map(async (token) => {
      const price = await previewCorridor(token, BigInt(capMicro)).catch(() => null);
      // Headroom covers rate movement. The USD₮ cap remains the limit on what can be converted.
      if (price?.buyAmount) localCaps[token] = BigInt(price.buyAmount) * 125n / 100n;
      else skipped.push(token);
    }));
    const permissions = sessionGrant(BigInt(capMicro), v.period, localCaps);
    const prepared = await prepareSession(db, { projectId: project.id, userId: user.id, walletAddress: wallet.address as Address, capMicro, period: v.period, days: v.days, serialized: permissions });
    return { ok: true, data: { ...prepared, skipped } };
  } catch (e) {
    return fail(e);
  }
}

/** Spending starts only after the wallet contract itself shows that it holds the agent key. */
export async function activateAltanaSessionAction(id: string, txHash: string | null): Promise<ActionResult> {
  try {
    const { project, db, user } = await guard("manage_wallet");
    const grant = hash.parse(txHash);
    const [row] = await db.select().from(s.altanaSessions).where(and(eq(s.altanaSessions.id, id), eq(s.altanaSessions.projectId, project.id), eq(s.altanaSessions.status, "pending")));
    if (!row) return { ok: false, error: "This session request is no longer open" };
    if (!await keyIsOnAccount(row.walletAddress, row.publicKey)) return { ok: false, error: "Celo does not show this session key on your wallet yet. Try again in a few seconds." };
    await db.update(s.altanaSessions).set({ status: "active", grantTxHash: grant, updatedAt: new Date() }).where(eq(s.altanaSessions.id, row.id));
    await setAltanaWalletStatus(db, project.id, "ACTIVE");
    await audit(db, { projectId: project.id, actorType: "user", actorId: user.id, action: "wallet.altana_session_granted", target: row.publicKey, data: { capMicro: row.capMicro, period: row.period, expiresAt: row.expiresAt.toISOString(), txHash: grant } });
    revalidatePath("/app", "layout");
    return { ok: true, message: "Session key active" };
  } catch (e) {
    return fail(e);
  }
}

/** Stops the agent locally the moment the owner asks, then records the onchain revoke once Celo confirms it. */
export async function confirmAltanaRevokeAction(id: string, txHash: string | null): Promise<ActionResult> {
  try {
    const { project, db, user } = await guard("manage_wallet");
    const revoke = hash.parse(txHash);
    const [row] = await db.select().from(s.altanaSessions).where(and(eq(s.altanaSessions.id, id), eq(s.altanaSessions.projectId, project.id), eq(s.altanaSessions.status, "active")));
    if (!row) return { ok: false, error: "No active session key to revoke" };
    await setAltanaWalletStatus(db, project.id, "PAUSED");
    if (await keyIsOnAccount(row.walletAddress, row.publicKey)) return { ok: false, error: "Payouts are paused, but Celo still shows this key. Try the revoke again." };
    await db.update(s.altanaSessions).set({ status: "revoked", revokeTxHash: revoke, updatedAt: new Date() }).where(eq(s.altanaSessions.id, row.id));
    await audit(db, { projectId: project.id, actorType: "user", actorId: user.id, action: "wallet.altana_session_revoked", target: row.publicKey, data: { txHash: revoke } });
    revalidatePath("/app", "layout");
    return { ok: true, message: "Session key revoked onchain" };
  } catch (e) {
    return fail(e);
  }
}

export async function setKolPayoutTokenAction(kolId: string, token: string): Promise<ActionResult> {
  try {
    const { project, db, user } = await guard("manage_wallet");
    if (token && !isPayoutToken(token)) return { ok: false, error: "Choose a supported payout currency" };
    const [kol] = await db.select({ token: s.kols.payoutToken }).from(s.kols).where(and(eq(s.kols.id, kolId), eq(s.kols.projectId, project.id)));
    if (!kol) return { ok: false, error: "Creator not found" };
    if ((kol.token ?? "") === token) return { ok: true, message: "No change" };
    await db.update(s.kols).set({ payoutToken: token || null, updatedAt: new Date() }).where(and(eq(s.kols.id, kolId), eq(s.kols.projectId, project.id)));
    await audit(db, { projectId: project.id, actorType: "user", actorId: user.id, action: "kol.payout_token", target: kolId, data: { from: kol.token ?? "USDC", to: token || "USDC" } });
    revalidatePath(`/app/kols/${kolId}`);
    return { ok: true, message: `Future payments use ${token || "USDC"}` };
  } catch (e) {
    return fail(e);
  }
}

/** Links a program to its escrow only after the chain shows this funder's campaign with the exact published terms. */
export async function confirmEscrowFundingAction(programId: string, owner: string): Promise<ActionResult> {
  try {
    const { project, db, user } = await guard("approve");
    await limited("escrow-confirm");
    if (!isAddress(owner)) return { ok: false, error: "The funding wallet is invalid" };
    const preview = await escrowPreview(db, project.id, programId);
    if (!preview.contract) return { ok: false, error: "Escrow is not deployed yet" };
    const funder = getAddress(owner);
    if (preview.terms.owner && preview.terms.owner.toLowerCase() !== funder.toLowerCase()) return { ok: false, error: "This program is already linked to another funding wallet" };
    const { campaignId, campaign } = await readFundedCampaign(preview.contract as Address, funder, preview.terms.salt);
    if (!campaignMatchesTerms(campaign, funder, preview.terms)) return { ok: false, error: "Celo does not show a funded campaign with these exact terms from this wallet" };
    await db.update(s.creatorPrograms).set({ escrowCampaignId: campaignId, escrowOwner: funder }).where(and(eq(s.creatorPrograms.id, programId), eq(s.creatorPrograms.projectId, project.id)));
    await audit(db, { projectId: project.id, actorType: "user", actorId: user.id, action: "escrow.funded", target: programId, data: { campaignId, owner: funder, contract: preview.contract } });
    revalidatePath(`/app/campaigns/${programId}/escrow`);
    return { ok: true, message: "Escrow funding confirmed on Celo" };
  } catch (e) {
    return fail(e);
  }
}

export async function previewPayoutAction(token: string, amountUsd: string): Promise<ActionResult<{ receives: string }>> {
  try {
    await guard("view");
    await limited("corridor-preview", 20, 1);
    if (!isPayoutToken(token) || !/^\d{1,6}(\.\d{1,2})?$/.test(amountUsd) || Number(amountUsd) < 1) return { ok: false, error: "Enter at least 1 USD₮" };
    const price = await previewCorridor(token, BigInt(toMicro(amountUsd)));
    if (!price.buyAmount) return { ok: false, error: "No Textile FX maker is pricing this corridor right now" };
    return { ok: true, data: { receives: formatPayout(token, price.buyAmount) } };
  } catch (e) {
    return fail(e);
  }
}
