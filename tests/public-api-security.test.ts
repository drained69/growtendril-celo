import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";

process.env.PGLITE_DIR = "memory://";
delete process.env.DATABASE_URL;

const worker = vi.hoisted(() => ({ runOnce: vi.fn(async () => 3) }));
vi.mock("@/server/jobs/worker", () => worker);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("scheduler authentication", () => {
  it("requires the Bearer scheme and compares bytes safely", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret");
    const { POST } = await import("@/app/api/cron/cycle/route");
    for (const authorization of ["cron-secret", "Bearer crón-secret", "Bearer wrong", ""]) {
      const response = await POST(new Request("https://example.test/api/cron/cycle", { method: "POST", headers: { authorization } }));
      expect(response.status).toBe(401);
    }
    expect(worker.runOnce).not.toHaveBeenCalled();
    const response = await POST(new Request("https://example.test/api/cron/cycle", { method: "POST", headers: { authorization: "Bearer cron-secret" } }));
    expect(await response.json()).toEqual({ processed: 3 });
    expect(worker.runOnce).toHaveBeenCalledOnce();
  });
});
