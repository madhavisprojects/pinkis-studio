// Drop this file into any Express app's root and require it to safely
// resolve the real client IP behind a reverse proxy (AWS ALB, Cloudflare, etc).
//
// These apps sit behind TWO proxy hops: Cloudflare, then AWS's ALB in front
// of Elastic Beanstalk. Cloudflare sets X-Forwarded-For to the real visitor
// IP, but the ALB then APPENDS its own view of the client -- which is
// Cloudflare's edge IP -- giving "X-Forwarded-For: <real ip>, <cloudflare ip>".
// Trusting only the last entry (the old approach here) grabbed Cloudflare's
// own IP instead of the visitor's, which is why real visitors were showing
// up flagged as proxy/hosting traffic.
//
// Cloudflare's CF-Connecting-IP header is the reliable fix: Cloudflare
// always sets it to the true visitor IP and strips any client-supplied
// value at its edge, so it can't be spoofed. Prefer it when present; fall
// back to the X-Forwarded-For heuristic for traffic that isn't behind
// Cloudflare (e.g. hitting the raw EB URL directly, or local dev).
//
// Usage:
//   const getClientIp = require('./website-visitors');
//   const ip = getClientIp(req);

const IPV4_OR_IPV6 = /^[0-9a-fA-F:.]+$/;

function getClientIp(req) {
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp && IPV4_OR_IPV6.test(cfIp)) return cfIp;

  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    const parts = forwardedFor.split(',').map(p => p.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && IPV4_OR_IPV6.test(last)) return last;
  }
  return req.ip;
}

module.exports = getClientIp;
