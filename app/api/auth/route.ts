import { NextResponse } from "next/server";

const PASSWORD = process.env.AUTH_PASSWORD || "sendme123";

export async function POST(request: Request) {
  const { password } = await request.json();
  if (password !== PASSWORD) {
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set("opticalsend_auth", "granted", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
  });
  return res;
}
