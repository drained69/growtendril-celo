import { NextResponse, type NextRequest } from "next/server";

/** Coarse gate (cookie presence) + security headers. Signature verification happens server-side. */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (["/app", "/onboarding", "/billing", "/verify"].some((p) => pathname === p || pathname.startsWith(`${p}/`)) && !req.cookies.get("celo_gos_session")) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  const res = NextResponse.next();
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // Limits framing, injected base URLs, plugins and form hijacking without breaking Next.js inline scripts.
  res.headers.set("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'");
  if (process.env.NODE_ENV === "production") res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
