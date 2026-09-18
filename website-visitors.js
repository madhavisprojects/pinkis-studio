// Drop this file into any Express app's root and require it for everything
// the admin "Visitors" table needs: resolving the real client IP behind a
// reverse proxy, flagging bot/crawler user agents, and free IP geolocation.
//
// getClientIp — these apps sit behind TWO proxy hops: Cloudflare, then AWS's
// ALB in front of Elastic Beanstalk. Cloudflare sets X-Forwarded-For to the
// real visitor IP, but the ALB then APPENDS its own view of the client --
// which is Cloudflare's edge IP -- giving "X-Forwarded-For: <real ip>,
// <cloudflare ip>". Trusting only the last entry (the old approach here)
// grabbed Cloudflare's own IP instead of the visitor's, which is why real
// visitors were showing up flagged as proxy/hosting traffic.
//
// Cloudflare's CF-Connecting-IP header is the reliable fix: Cloudflare
// always sets it to the true visitor IP and strips any client-supplied
// value at its edge, so it can't be spoofed. Prefer it when present; fall
// back to the X-Forwarded-For heuristic for traffic that isn't behind
// Cloudflare (e.g. hitting the raw EB URL directly, or local dev).
//
// isBotUserAgent — real browsers never send an empty UA or self-identify as
// a bot/crawler/scanner -- catches things like "RadixAbuseResearch/1.0"
// that IP-hosting/proxy checks miss because they run from ordinary
// residential/mobile IPs.
//
// lookupIpLocation — free city-level IP geolocation via ip-api.com (no key,
// no browser consent needed), plus the proxy/hosting/mobile flags used to
// spot bots on clean-looking IPs. Skips loopback/private ranges so local
// dev doesn't burn lookups.
//
// Usage:
//   const { getClientIp, isBotUserAgent, lookupIpLocation } = require('./website-visitors');
//   const ip = getClientIp(req);
//   const uaBot = isBotUserAgent(req.headers['user-agent']);
//   const geo = await lookupIpLocation(ip); // null for private/loopback IPs or a failed lookup

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

const BOT_UA_PATTERN = /\bbot\b|crawler|spider|scraper|slurp|research|scan(ner)?|monitor|uptimerobot|pingdom|curl\/|wget\/|python-requests|python-urllib|go-http-client|okhttp|libwww-perl|apache-httpclient|headlesschrome|phantomjs|selenium|puppeteer|facebookexternalhit|bingpreview|ahrefsbot|semrushbot|mj12bot|dotbot|petalbot|bytespider|censys|shodan|masscan|nmap|zgrab|nuclei|netcraft/i;
function isBotUserAgent(ua) {
  if (!ua) return true;
  return BOT_UA_PATTERN.test(ua);
}

async function lookupIpLocation(ip) {
  if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.')) {
    return null;
  }
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,city,regionName,country,lat,lon,isp,proxy,hosting,mobile`);
    const data = await res.json();
    if (data.status !== 'success') return null;
    return {
      ipCity: data.city,
      ipRegion: data.regionName,
      ipCountry: data.country,
      ipLatitude: data.lat,
      ipLongitude: data.lon,
      ipIsp: data.isp,
      ipProxy: data.proxy,
      ipHosting: data.hosting,
      ipMobile: data.mobile
    };
  } catch (err) {
    console.error('IP lookup failed:', err.message);
    return null;
  }
}

module.exports = { getClientIp, isBotUserAgent, lookupIpLocation };
