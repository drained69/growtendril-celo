import { cookies, headers } from "next/headers";
import { getDb } from "@/server/db/client";
import { currentProject, currentUser } from "@/server/auth/current";
import { can, type Permission } from "@/server/auth/access";
import { createSessionToken, sessionCookieOptions, SESSION_COOKIE } from "@/server/auth/session";
import { rateLimit, clientIp } from "@/server/security/ratelimit";
import { safeErrorMessage } from "@/server/security/safe-error";
import { ZodError } from "zod";

/** Uniform result for server actions consumed by client components. */
export type ActionResult<T = unknown> = { ok: true; data?: T; log?: { agent: string; message: string }[]; message?: string } | { ok: false; error: string; code?: "INSUFFICIENT_CREDIT"; nextHref?: "/billing" | "/app/team" };

export class ActionError extends Error {}

/** Every workspace action starts here: signed-in user, current workspace, and the permission it needs. */
export async function guard(permission: Permission) {
  const user = await currentUser();
  if (!user) throw new ActionError("You are signed out — sign in again.");
  if (!user.emailVerified) throw new ActionError("Confirm your email first — enter the code we sent you.");
  const cur = await currentProject(user.id);
  if (!cur) throw new ActionError("No workspace selected.");
  if (!can(cur.role, permission)) throw new ActionError(`Your role (${cur.role}) cannot do this.`);
  const db = await getDb();
  return { user, project: cur.project, role: cur.role, db };
}

export async function limited(key: string, capacity = 10, refillPerSec = 0.2) {
  const ip = clientIp(await headers());
  const r = rateLimit(`${key}:${ip}`, { capacity, refillPerSec });
  if (!r.ok) throw new ActionError(`Too many requests — retry in ${r.retryAfter}s.`);
}

export { safeErrorMessage };

export function fail(e: unknown): ActionResult<never> {
  const zod = e instanceof ZodError ? e.issues[0] : null;
  // Custom validation messages can contain diagnostic inputs too; pass through the same sanitizer.
  if (zod) {
    const human = /^[A-Z]/.test(zod.message) && zod.message.length > 15;
    const message = human ? zod.message : `${zod.path.join(".") || "input"}: ${zod.message}`;
    return { ok: false, error: safeErrorMessage(new Error(message)) };
  }
  return { ok: false, error: safeErrorMessage(e) };
}

export async function startSession(userId: string, sessionVersion = 0) {
  (await cookies()).set(SESSION_COOKIE, createSessionToken(userId, sessionVersion), sessionCookieOptions);
}

export type LogLine = { agent: string; message: string };
export function collector() {
  const log: LogLine[] = [];
  return { log, push: (agent: string, message: string) => log.push({ agent, message }) };
}
