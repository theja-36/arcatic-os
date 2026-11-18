import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/lib/safe-next";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (code) {
    const store = await cookies();
    const sb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!, {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (list: Array<{ name: string; value: string; options: CookieOptions }>) => list.forEach(({ name, value, options }) => store.set(name, value, options)),
      },
    });
    await sb.auth.exchangeCodeForSession(code);
  }
  // only a path on this site (see safeNext), never an open redirect
  const safe = safeNext(req.nextUrl.searchParams.get("next"), req.url);
  return NextResponse.redirect(new URL(safe, req.url));
}
