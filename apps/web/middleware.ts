import { createServerClient, type CookieOptions } from "@supabase/ssr";

type CookieToSet = { name: string; value: string; options: CookieOptions };
import { NextResponse, type NextRequest } from "next/server";

/** Refreshes the Supabase session cookie and gates app routes. */
export async function middleware(req: NextRequest) {
  let res = NextResponse.next({ request: req });
  const sb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (cookies: CookieToSet[]) => {
        cookies.forEach(({ name, value }) => req.cookies.set(name, value));
        res = NextResponse.next({ request: req });
        cookies.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      },
    },
  });
  const { data } = await sb.auth.getUser();
  const isPublic = req.nextUrl.pathname.startsWith("/sign-in") || req.nextUrl.pathname.startsWith("/auth");
  if (!data.user && !isPublic) {
    const to = new URL("/sign-in", req.url);
    to.searchParams.set("next", req.nextUrl.pathname);
    return NextResponse.redirect(to);
  }
  return res;
}

// PWA files and the offline page must load without a session (the service worker fetches them)
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|icons/|offline).*)"] };
