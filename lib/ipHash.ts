import 'server-only';
import { createHmac } from 'node:crypto';

// Client IP extraction and HMAC hashing. The raw IP is never stored, only
// the HMAC digest, keyed by QWIXX_IP_HASH_SECRET.

/**
 * CF-Connecting-IP only. Cloudflare's edge always sets it and overwrites any
 * client-supplied value, so it is trustworthy through the tunnel. X-Forwarded-For
 * is not: its leftmost entry is whatever the caller typed, and this app is
 * also reachable off-tunnel via a NodePort, where no edge rewrites anything
 * and a caller can rotate the header per request to get an unlimited number
 * of rate-limit buckets (finding S7). Returns null when the header is
 * absent, which callers must treat as "did not arrive through the tunnel".
 */
export function clientIp(req: Request): string | null {
  const cfConnectingIp = req.headers.get('cf-connecting-ip')?.trim();
  return cfConnectingIp ? cfConnectingIp : null;
}

export function hashIp(ip: string): string {
  const secret = process.env.QWIXX_IP_HASH_SECRET;
  if (!secret) throw new Error('QWIXX_IP_HASH_SECRET is required.');
  return createHmac('sha256', secret).update(ip).digest('base64url');
}
