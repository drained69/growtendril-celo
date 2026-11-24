# Application boundary review

Reviewed November 23, 2026. Scope: authorization, Self identity, Signals seller, SSRF/public HTTP, configuration/secrets and readiness. Source was read only; no live network, identities or payments were used. Findings below describe the reviewed baseline; root is responsible for implementation and final re-verification. Line references may shift during concurrent fixes.

## Finding [BOUNDARY-1]: Production silently starts an ephemeral financial database

**Verdict**: CONFIRMED
**Step Execution**: ✓1(source),2(trace),3(offline reproduction),4(impact),5(remediation)
**Rules Applied**: [R4:✓, R5:✓, R6:✗(configuration error), R8:✓, R10:✓, R11:✗(no token call), R12:✓, R13:✓, R14:✓, R15:✗(no flash loan), R16:✗(no oracle)]
**Preferred Tag**: [POC-PASS]
**Severity**: High
**Location**: src/server/db/client.ts:17; src/server/db/client.ts:31; src/app/api/health/route.ts:15
**Description**: `open()` selects PGlite whenever DATABASE_URL is absent, including NODE_ENV=production. The deployment configuration does not establish a persistent volume. `/api/health` returns 200 after querying this accidental local database.
**Impact**: A production deployment with a missing/misspelled database variable becomes healthy while accepting account, approval, credit, receipt and idempotency state on ephemeral storage. Redeploys can destroy those records. The service can lose proof of paid balances and financial decisions, requiring manual reconstruction. This is a deployment blocker even without an external attacker.
**Evidence**: An offline command with NODE_ENV=production, DATABASE_URL empty and PGLITE_DIR=memory:// called getDb() and returned `{ productionWithoutDatabaseUrlOpens: true, driver: 'PgliteDatabase' }`. Dockerfile and railway.json configure no database readiness enforcement.
**Suggested fix**: Require external PostgreSQL in production, unless an explicit audited durable-local-storage mode is selected. Make production readiness fail before accepting work when required persistence/session/encryption configuration is absent. Keep PGlite for tests and development.

### Postcondition Analysis
**Postconditions Created**: Financial state exists only on a disposable deployment filesystem, while health is green.
**Postcondition Types**: [STATE, BALANCE, ACCESS]
**Who Benefits**: No attacker required; a configuration mistake creates financial availability and accounting failure.

## Finding [BOUNDARY-2]: SDK diagnostics can disclose private RPC credentials

**Verdict**: CONFIRMED
**Step Execution**: ✓1(source),2(trace),3(offline reproduction),4(impact),5(remediation)
**Rules Applied**: [R4:✓, R5:✓, R6:✓, R8:✓, R10:✓, R11:✗(no token dependency), R12:✓, R13:✗(not design justification), R14:✗(no bounds), R15:✗(no flash loan), R16:✗(no oracle)]
**Preferred Tag**: [POC-PASS]
**Severity**: Medium
**Location**: src/server/actions/_common.ts:44; src/server/actions/_common.ts:47; src/server/domain/agent/withdraw.ts:142
**Description**: fail() only classifies a narrow collection of infrastructure errors. A viem error or its wrapped Error can contain the full configured private CELO_MAINNET_RPC URL in e.message, but an opaque token in a URL path is not recognized by the existing API-key regex. Domain execution paths also save raw error messages in ledger records, which are visible to workspace readers.
**Impact**: A legitimate workspace caller can trigger RPC failure and obtain the deployment's paid RPC token. The exposed token can be reused outside the workspace and consume provider budget or reveal privileged infrastructure access. Raw diagnostics can also persist in receipts and activity.
**Evidence**: Direct offline invocation `fail(new Error("HTTP request failed. URL: https://celo-provider.example/v1/FAKE_PRIVATE_RPC_TOKEN"))` returned `{ok:false,error:"HTTP request failed. URL: https://celo-provider.example/v1/FAKE_PRIVATE_RPC_TOKEN"}`.
**Suggested fix**: Map known viem/SDK infrastructure errors to safe fixed messages and sanitize diagnostics before database/audit/log persistence. Keep only expected application errors user-visible. Do not rely solely on regexes requiring the literal string api_key. Add regression tests with opaque path/query RPC tokens and nested viem causes.

### Postcondition Analysis
**Postconditions Created**: The infrastructure credential becomes available to client callers and potentially read-only teammates.
**Postcondition Types**: [ACCESS, EXTERNAL]
**Who Benefits**: A caller who can invoke payment/RPC operations and induce an RPC error.

## Finding [BOUNDARY-3]: Public Self gate is unbounded before expensive onchain verification

**Verdict**: CONFIRMED
**Step Execution**: ✓1(source),2(dependency trace),3(offline SDK reproduction),4(impact),5(remediation)
**Rules Applied**: [R4:✓, R5:✓, R6:✗(permissionless caller), R8:✓, R10:✓, R11:✗(no token dependency), R12:✓, R13:✗(not design justification), R14:✓, R15:✗(no flash loan), R16:✗(no oracle)]
**Preferred Tag**: [POC-PASS]
**Severity**: Medium
**Location**: services/signals-api/identity.ts:10; src/server/integrations/celo/self.ts:13; node_modules/@selfxyz/agent-sdk/dist/SelfAgentVerifier.js:443
**Description**: The service calls SelfAgentVerifier.verify without ingress rate/concurrency limits or an RPC deadline. The SDK's per-agent rate limiter executes only after onchain proof checks (SDK line 588); unregistered agents return before it. cacheTtl(0) also prevents caching failed status lookups. Any new private key can generate a cryptographically valid HTTP signature without Self registration or payment.
**Impact**: Permissionless callers force unlimited registry reads, consume a paid RPC quota, saturate pending requests and deny real users access to paid research. Rotating keys or changing signed query URLs avoids the replay cache. Even repeated registered requests hit the chain before the rate limiter.
**Evidence**: With registry methods stubbed to count calls (no network), twenty real SDK-signed requests from an unregistered key each returned invalid but produced forty registry calls despite perMinute:10. The SDK rate check is later in the execution trace and the application has no earlier limiter.
**Suggested fix**: Add a bounded ingress token bucket/concurrency guard before verification, enforce a deadline, and validate bounded header/path lengths. Establish the proxy trust boundary before using IP headers. Consider short bounded status caches with explicit revocation tradeoffs. Use shared rate/replay storage if scaling across instances; local caches alone are not distributed protection.

### Postcondition Analysis
**Postconditions Created**: Expensive RPC work is allocated to callers who have not proven registration or paid.
**Postcondition Types**: [EXTERNAL, TIMING]
**Who Benefits**: Any internet caller able to generate a signature for its own arbitrary EVM key.

## Finding [BOUNDARY-4]: Paid research presents provider outages as zero observations

**Verdict**: CONFIRMED
**Step Execution**: ✓1(source),2(trace),3(boundary substitution),4(impact),5(remediation)
**Rules Applied**: [R4:✓, R5:✓, R6:✗(provider failure), R8:✓, R10:✓, R11:✗(not token transfer), R12:✓, R13:✓, R14:✓, R15:✗(no flash loan), R16:✗(research data, not price oracle)]
**Preferred Tag**: [CODE-TRACE]
**Severity**: Medium
**Location**: services/signals-api/server.ts:35; services/signals-api/server.ts:65; services/signals-api/server.ts:83
**Description**: json() collapses transport errors and non-2xx responses to null. The narrative endpoint maps null to stories:0, while company enrichment returns dataMode:LIVE, signals:[] and a sources list even if every upstream request failed. Both respond 200 under the payment middleware.
**Impact**: Customers can be charged for unavailable research and receive invented zero observations. GrowTendril's growth decisions cannot distinguish no demand from missing data, potentially stopping or reallocating legitimate campaigns based on outages.
**Evidence**: Substitute upstream response null into `stories: r?.nbHits ?? 0`: each failed week becomes a measured zero. For company data, orgInfo null and hn null bypass both source loops, then return a successful LIVE result. The x402 seller settles successful 200 responses.
**Suggested fix**: Preserve provider availability/error status, use nullable observations for failed windows, return partial results explicitly, and return 503 when no useful source succeeded. Validate inputs and expected upstream response shape before responding. Ensure the payment middleware does not settle an outage response.

### Postcondition Analysis
**Postconditions Created**: Unavailable data becomes a paid, apparently valid observation and can influence stored evidence/decision logic.
**Postcondition Types**: [STATE, EXTERNAL, BALANCE]
**Who Benefits**: No attacker required; rate limits and transient provider outages trigger this condition.

## Finding [BOUNDARY-5]: Doctor success does not mean mainnet prerequisites are satisfied

**Verdict**: CONFIRMED
**Step Execution**: ✓1(source),2(trace),3(boundary substitution),4(impact),5(remediation)
**Rules Applied**: [R4:✓, R5:✓, R6:✗(operator command), R8:✓, R10:✓, R11:✗(read only), R12:✓, R13:✓, R14:✓, R15:✗(no flash loan), R16:✗(no oracle)]
**Preferred Tag**: [CODE-TRACE]
**Severity**: Low
**Location**: scripts/celo-doctor.ts:23; src/app/.well-known/agent-registration.json/route.ts:14
**Description**: Doctor exits nonzero only if RPC chain mismatch or custody is unavailable. Missing PostgreSQL, malformed/missing session and encryption configuration, absent ERC-8004 ID, failed Self verification, zero gas or missing seller setup do not affect exit status. Metadata likewise marks an agent active based on any truthy CELO_AGENT_ID string without checking parsing or onchain ownership.
**Impact**: An operator or deployment automation can consider the service mainnet-ready when it cannot sign in users, preserve money records, prove an identity or transact. Metadata may publish null/incorrect IDs through Number(id) conversion.
**Evidence**: For input rpcMatches=true and custody='celo', the final if condition is false independently of every other results field, including selfVerified=false. No onchain ERC owner or agentWallet query is performed.
**Suggested fix**: Separate cheap liveness from explicit mainnet readiness; define required checks by role (web/buyer/seller) and return nonzero for failed required checks. Validate ID as safe canonical unsigned integer or use string encoding where supported, and verify registry ownership/wallet/URI. Expose pending state honestly rather than treating configured strings as verified registration.

### Postcondition Analysis
**Postconditions Created**: Configuration presence is mistaken for operational readiness and verified identity.
**Postcondition Types**: [STATE, EXTERNAL]
**Who Benefits**: No attacker required; operator mistakes pass checks.

## Refuted candidates and checked boundaries

- **Legacy X-PAYMENT payer-binding bypass: REFUTED in installed x402 2.32.0.** The identity gate reads only payment-signature, and @x402/express records x-payment in a context field, but @x402/core processHTTPRequest actually calls extractPayment(adapter), which reads only payment-signature/PAYMENT-SIGNATURE. A request using x-payment alone gets a new 402 and cannot settle or access protected content. Rejecting legacy/ambiguous headers defensively remains reasonable, but this is not a confirmed payment bypass.
- **Case, trailing slash and HEAD paywall mismatches: REFUTED.** Installed core route matching normalizes trailing slashes, uses case-insensitive matching and maps HEAD to GET.
- **Private-network crawl/payment SSRF through ordinary inputs: REFUTED in reviewed paths.** getPublicText validates all DNS answers and pins the request lookup to an approved answer, rechecks redirect targets, forbids signed payment redirects and does not reuse unchecked pooled connections. Public literals, loopback, mapped IPv4, link-local and private ranges are rejected.
- **Cross-workspace project-cookie authority: REFUTED.** currentProject rechecks membership and LIVE mode; the cookie is a preference rather than an authorization grant. Server actions use guard() and role-specific checks.
- **Google token claim parser alone lacks JWT cryptographic verification: REFUTED as a reachable token-injection finding.** The reviewed auth path obtains the ID token directly from Google's TLS token endpoint after authorization-code/PKCE exchange, then checks audience, issuer, expiry and verified email. No route accepts arbitrary caller ID tokens.
- **Production email silently logs OTPs: REFUTED.** Console fallback is development-only; production without provider setup fails the send.
- **IP-header trust needs explicit deployment configuration.** clientIp trusts the first X-Forwarded-For entry or X-Real-IP. A direct Node/Docker exposure can spoof these and bypass IP-only login rate limiting, but whether Railway ingress overwrites these headers was not verified in this offline scope. Add account-based login throttling and a documented trusted proxy policy; do not report ingress spoofability as proven for every hosting provider.

## Verification limits

No live Self identity, valid facilitator key, real x402 settlement, hosted DNS, private production RPC, PostgreSQL failover or public mainnet deployment was exercised. The suite's mocked Self success tests validate application branching, not a live passport-backed identity. The above review does not certify all smart contracts or all inherited application code.
