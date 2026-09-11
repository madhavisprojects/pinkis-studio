// Drop this file into any Express app's root and require it to safely
// resolve the real client IP behind a reverse proxy (AWS ALB, Cloudflare, etc).
//
// X-Forwarded-For is a comma-separated list where every entry except the
// last can be set by the client itself. Bots/scrapers routinely spoof it
// (e.g. "X-Forwarded-For: unknown, <real ip>") to poison IP logging and
// geo-lookups. Only the LAST entry -- the one appended by your own trusted
// proxy -- can be relied on.
//
// Usage:
//   const getClientIp = require('./get-client-ip');
//   const ip = getClientIp(req);

const IPV4_OR_IPV6 = /^[0-9a-fA-F:.]+$/;

function getClientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    const parts = forwardedFor.split(',').map(p => p.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && IPV4_OR_IPV6.test(last)) return last;
  }
  return req.ip;
}

module.exports = getClientIp;
