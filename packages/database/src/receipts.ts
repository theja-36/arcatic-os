import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Push receipts: the service worker reports "displayed" and "clicked" for a notification. It has no
 * session, so each push carries a signed token for exactly that notification (HMAC-SHA256 with a
 * server secret). The token proves the report refers to a push the server really sent; it grants
 * nothing else.
 */
export const RECEIPT_EVENTS = ["displayed", "clicked"] as const;
export type ReceiptEvent = (typeof RECEIPT_EVENTS)[number];

const sig = (secret: string, id: string) => createHmac("sha256", secret).update(`push-receipt:${id}`).digest("base64url").slice(0, 32);
export const signReceipt = (secret: string, notificationId: string) => `${notificationId}.${sig(secret, notificationId)}`;
export function verifyReceipt(secret: string, token: unknown): string | null {
  if (typeof token !== "string") return null;
  const i = token.lastIndexOf(".");
  if (i < 1) return null;
  const id = token.slice(0, i), given = Buffer.from(token.slice(i + 1)), want = Buffer.from(sig(secret, id));
  return given.length === want.length && timingSafeEqual(given, want) && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}
