require('dotenv').config();
const express      = require('express');
const path         = require('path');
const cors         = require('cors');
const mongoose      = require('mongoose');
const bcrypt         = require('bcryptjs');
const jwt            = require('jsonwebtoken');
const rateLimit       = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 8080;

if (!process.env.JWT_SECRET) {
  console.error('❌  JWT_SECRET is not set. Refusing to start with an insecure default.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅  MongoDB connected'))
  .catch(err => console.error('❌  MongoDB connection failed:', err.message));

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ═══════════════════════════════════════════════════
// Admin (platform login)
// ═══════════════════════════════════════════════════
const adminSchema = new mongoose.Schema({
  username:        { type: String, required: true, unique: true },
  password:        { type: String, required: true },
  createdDate:     { type: Date, default: Date.now },
  lastUpdatedDate: { type: Date, default: Date.now },
});
const Admin = mongoose.model('Admin', adminSchema);

async function seedAdmin() {
  const exists = await Admin.findOne();
  if (!exists) {
    if (!process.env.ADMIN_PASSWORD) {
      console.error('⚠️   No admin account exists and ADMIN_PASSWORD is not set — skipping admin seed.');
      return;
    }
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
    await Admin.create({ username: process.env.ADMIN_USERNAME || 'pinkisstudio_admin', password: hash });
    console.log('🔑  Admin seeded');
  }
}
mongoose.connection.once('open', seedAdmin);

function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, error: 'No token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error();
    req.adminId = payload.id;
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Unauthorized' });
  }
}

// ═══════════════════════════════════════════════════
// Who's-visiting-PinkisAppStudio — one row per visitorId (a random ID kept
// in the browser's localStorage, no login required), upserted on every page
// load. IP + ISP + city-level location work with no browser consent; lat/lng
// only fill in if the visitor grants GPS permission, and "denied" is
// recorded too. Also flags proxy/hosting/mobile IPs so the admin can tell
// real visitors from bots/crawlers at a glance. Mirrors the ProTalk /
// UrShop / ILoveU visitor-tracking pattern.
// ═══════════════════════════════════════════════════
const AppVisitorSchema = new mongoose.Schema({
  visitorId:   { type: String, required: true, unique: true },
  geoStatus:   { type: String, enum: ['granted', 'denied', 'unknown'], default: 'unknown' },
  latitude:    Number,
  longitude:   Number,
  accuracy:    Number,
  userAgent:   String,
  ipAddress:   String,
  ipCity:      String,
  ipRegion:    String,
  ipCountry:   String,
  ipIsp:       String,
  ipProxy:     Boolean, // known VPN/proxy exit node
  ipHosting:   Boolean, // datacenter/cloud IP — most bots & crawlers run from these
  ipMobile:    Boolean, // carrier/mobile network IP
  visitCount:      { type: Number, default: 1 },
  createdDate:     { type: Date, default: Date.now },
  lastUpdatedDate: { type: Date, default: Date.now },
});
const AppVisitor = mongoose.model('AppVisitor', AppVisitorSchema);

// Free IP geolocation, no API key/consent needed. Skips loopback/private ranges.
async function lookupIpLocation(ip) {
  if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.')) {
    return null;
  }
  try {
    const r = await fetch(`http://ip-api.com/json/${ip}?fields=status,city,regionName,country,isp,proxy,hosting,mobile`);
    const data = await r.json();
    if (data.status !== 'success') return null;
    return {
      ipCity: data.city, ipRegion: data.regionName, ipCountry: data.country, ipIsp: data.isp,
      ipProxy: data.proxy, ipHosting: data.hosting, ipMobile: data.mobile
    };
  } catch (err) {
    console.error('IP lookup failed:', err.message);
    return null;
  }
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many login attempts. Please try again later.' }
});

// Anonymous visitor beacon fires once per page load — rate-limit by IP
const visitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
});

app.post('/api/visitor-location', visitLimiter, async (req, res) => {
  const { visitorId, geoStatus, lat, lng, accuracy } = req.body;
  if (!visitorId) return res.status(400).json({ success: false, error: 'visitorId is required' });

  const forwardedFor = req.headers['x-forwarded-for'];
  const ipAddress = forwardedFor ? forwardedFor.split(',')[0].trim() : req.ip;
  const ipLocation = await lookupIpLocation(ipAddress);
  const status = geoStatus === 'granted' || geoStatus === 'denied' ? geoStatus : 'unknown';

  await AppVisitor.findOneAndUpdate(
    { visitorId: String(visitorId).slice(0, 64) },
    {
      $set: {
        geoStatus: status,
        latitude:  status === 'granted' ? lat : undefined,
        longitude: status === 'granted' ? lng : undefined,
        accuracy:  status === 'granted' ? accuracy : undefined,
        userAgent: req.headers['user-agent'],
        ipAddress,
        ipCity: ipLocation?.ipCity, ipRegion: ipLocation?.ipRegion,
        ipCountry: ipLocation?.ipCountry, ipIsp: ipLocation?.ipIsp,
        ipProxy: ipLocation?.ipProxy, ipHosting: ipLocation?.ipHosting, ipMobile: ipLocation?.ipMobile,
        lastUpdatedDate: new Date()
      },
      $inc: { visitCount: 1 },
      $setOnInsert: { createdDate: new Date() }
    },
    { upsert: true }
  );
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════
// Admin routes
// ═══════════════════════════════════════════════════
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const admin = await Admin.findOne({ username });
  if (!admin) return res.status(401).json({ success: false, error: 'Invalid credentials' });
  const match = await bcrypt.compare(password, admin.password);
  if (!match) return res.status(401).json({ success: false, error: 'Invalid credentials' });
  const token = jwt.sign({ id: admin._id, role: 'admin' }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ success: true, token, username: admin.username });
});

app.get('/api/admin/visitors', adminAuth, async (req, res) => {
  const visitors = await AppVisitor.find().sort({ lastUpdatedDate: -1 }).limit(500).lean();
  const total = await AppVisitor.countDocuments();
  const bots  = await AppVisitor.countDocuments({ $or: [{ ipHosting: true }, { ipProxy: true }] });
  res.json({ success: true, visitors, stats: { total, bots, real: total - bots } });
});

app.delete('/api/admin/visitors', adminAuth, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ success: false, error: 'ids required' });
  await AppVisitor.deleteMany({ _id: { $in: ids } });
  res.json({ success: true });
});

// SPA fallback — keep last, after API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`PinkisAppStudio server running on port ${PORT}`));
