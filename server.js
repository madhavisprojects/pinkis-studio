require('dotenv').config();
const express      = require('express');
const path         = require('path');
const cors         = require('cors');
const mongoose      = require('mongoose');
const bcrypt         = require('bcryptjs');
const jwt            = require('jsonwebtoken');
const rateLimit       = require('express-rate-limit');
const crypto          = require('crypto'); // used for generating payment reference IDs
const { mountManualUpiKit } = require('./manual-upi-kit');

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

// ═══════════════════════════════════════════════════
// Payments — "Pay for Your Project" button beside "Book Strategy Call".
// Clients pay whatever amount they were quoted for their project, so
// (unlike a fixed-price product) trusting the client-submitted amount here
// is fine — there's nothing fixed-value to under-pay for; the studio just
// follows up on whatever comes in. Manual UPI deep link + UTR, verified by
// hand in the admin panel — no third-party payment gateway/account involved.
// ═══════════════════════════════════════════════════
const PaymentSchema = new mongoose.Schema({
  transactionId:   { type: String, required: true, unique: true }, // our own generated reference
  name:            String,
  email:           String,
  amount:          String,
  currency:        String,
  status:          { type: String, enum: ['pending', 'completed', 'rejected'], default: 'pending' },
  utr:             String,
  visitorId:       String,
  createdDate:     { type: Date, default: Date.now },
  lastUpdatedDate: { type: Date, default: Date.now },
});
const Payment = mongoose.model('Payment', PaymentSchema);

const ADMIN_UPI_ID = process.env.ADMIN_UPI_ID || '';
const ADMIN_UPI_NAME = process.env.ADMIN_UPI_NAME || 'PinkisAppStudio';
const MIN_PAYMENT = 1;
const MAX_PAYMENT = 100000; // sanity ceiling — a mistyped amount shouldn't try to charge millions

app.use(cors());
app.use(express.json());
// express.static(__dirname) below serves the whole app directory, so without
// this guard .git/, .env, .ebextensions/ etc. are all publicly downloadable —
// confirmed exploitable in production (scanners were pulling .git/config,
// .git/HEAD and .git/logs/HEAD with real content, not a 404).
app.use((req, res, next) => {
  if (req.path.split('/').some(seg => seg.length > 1 && seg[0] === '.')) {
    return res.status(404).end();
  }
  next();
});
app.use(express.static(__dirname));

// ═══════════════════════════════════════════════════
// Manual UPI payment — "Pay for Your Project" checkout
// See manual-upi-kit.js for the reusable backend piece (same one ILoveU
// will use) and manual-upi-widget.js for the matching frontend piece.
// ═══════════════════════════════════════════════════
mountManualUpiKit(app, {
  upiId: ADMIN_UPI_ID,
  upiName: ADMIN_UPI_NAME,
  adminAuth,
  getAmount: async (req) => {
    const value = Number(req.body?.amount);
    return (!Number.isFinite(value) || value < MIN_PAYMENT || value > MAX_PAYMENT) ? NaN : value;
  },
  onSubmit: async (req, { amount, utr }) => {
    const name = String(req.body?.name || '').slice(0, 200);
    const email = String(req.body?.email || '').slice(0, 200);
    const visitorId = req.body?.visitorId ? String(req.body.visitorId).slice(0, 64) : '';
    const transactionId = 'proj_' + crypto.randomBytes(6).toString('hex');
    await Payment.create({
      transactionId, name, email, amount: amount.toFixed(2), currency: 'INR',
      status: 'pending', utr, visitorId
    });
  },
  onApprove: (req) => Payment.findByIdAndUpdate(
    req.params.key, { status: 'completed', lastUpdatedDate: new Date() }, { new: true }
  ),
  onReject: (req) => Payment.findByIdAndUpdate(
    req.params.key, { status: 'rejected', lastUpdatedDate: new Date() }, { new: true }
  ),
});

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
  hadInteraction: Boolean, // any mouse/scroll/key/touch event fired this visit
  dwellMs:        Number,  // ms page stayed open before hidden/closed
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

// Behavioral follow-up beacon — fires on tab hide/close via sendBeacon, once
// the location beacon above has already created the visitor row. No IP
// lookup here; just records whether the visit showed any human interaction
// and how long the page stayed open. A clean IP (not hosting/proxy) only
// means "not a lazy bot" — this catches scripted browsers on real IPs too.
app.post('/api/visitor-behavior', visitLimiter, async (req, res) => {
  const { visitorId, hadInteraction, dwellMs } = req.body;
  if (!visitorId) return res.status(400).json({ success: false, error: 'visitorId is required' });

  await AppVisitor.findOneAndUpdate(
    { visitorId: String(visitorId).slice(0, 64) },
    { $set: {
        hadInteraction: !!hadInteraction,
        dwellMs: Number.isFinite(dwellMs) ? Math.max(0, Math.min(dwellMs, 24 * 60 * 60 * 1000)) : undefined,
        lastUpdatedDate: new Date()
    } }
  );
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════
// Leads — "Start a Project" / "Request Callback" form submissions
// ═══════════════════════════════════════════════════
const LeadSchema = new mongoose.Schema({
  source:          { type: String, enum: ['project-form', 'callback-form'], required: true },
  name:            String,
  email:           String,
  company:         String,
  budget:          String,
  message:         String,
  interests:       [String],
  visitorId:       String,
  createdDate:     { type: Date, default: Date.now },
  lastUpdatedDate: { type: Date, default: Date.now },
});
const Lead = mongoose.model('Lead', LeadSchema);

const leadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many submissions. Please try again later.' }
});

app.post('/api/leads', leadLimiter, async (req, res) => {
  const { source, name, email, company, budget, message, interests, visitorId } = req.body;
  if (!['project-form', 'callback-form'].includes(source) || !name || !email) {
    return res.status(400).json({ success: false, error: 'name, email and source are required' });
  }
  await Lead.create({
    source,
    name: String(name).slice(0, 200),
    email: String(email).slice(0, 200),
    company: company ? String(company).slice(0, 200) : undefined,
    budget: budget ? String(budget).slice(0, 100) : undefined,
    message: message ? String(message).slice(0, 5000) : undefined,
    interests: Array.isArray(interests) ? interests.map(i => String(i).slice(0, 50)).slice(0, 10) : undefined,
    visitorId: visitorId ? String(visitorId).slice(0, 64) : undefined,
  });
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════
// Chat transcripts — one document per visitorId, appended to on every
// /api/studio-chat exchange, so the admin can see what visitors asked.
// ═══════════════════════════════════════════════════
const ChatLogSchema = new mongoose.Schema({
  visitorId:       { type: String, required: true, unique: true },
  messages:        [{ role: String, content: String, at: { type: Date, default: Date.now } }],
  createdDate:     { type: Date, default: Date.now },
  lastUpdatedDate: { type: Date, default: Date.now },
});
const ChatLog = mongoose.model('ChatLog', ChatLogSchema);

// ═══════════════════════════════════════════════════
// Site chatbot — answers visitor questions about the studio
// (services, past work, apps, team, how to get started).
// OpenRouter free model first, falls back to Groq on 429 —
// same pattern as ProChat's astrologer/health chat routes.
// ═══════════════════════════════════════════════════
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many messages. Please try again in a few minutes.' }
});

const STUDIO_SYSTEM_PROMPT = `You are the PinkisAppStudio website assistant — a friendly, concise guide for visitors on pinkisappstudio.space.

About PinkisAppStudio:
- A full-stack engineering studio (Bhopal / Remote) of 7 senior engineers building and running production apps for real businesses, end-to-end from idea to production.
- Team: Madhavi Poranki (Tech Lead), Jahnavi Bomminayuni (Data Scientist), Hari Krishna Chowdhary (AI & ML Lead), Nitesh (Frontend), Sanidhya (Backend), Manish Pandey (Backend + DevOps), Mayank Thakur (App Developer). No juniors hidden on projects — clients work directly with senior engineers.

Services: Mobile apps (Flutter, Swift, Kotlin, Java), Web platforms (React, Next.js, Tailwind), Backend & infrastructure (Node, Java, MongoDB), SEO & growth, API integrations (Meta, Google, Stripe), DevOps & cloud (AWS, CI/CD), Cloud migration (AWS/Azure/GCP), Database migration (MongoDB/MySQL/PostgreSQL), Testing (QA, security, load), Infrastructure maintenance.

Process: 6 phases — Discover, Plan, Build (2-week sprints, weekly Friday demos), Test, Launch (phased rollout), Scale. Clients own their code and repo from day one, no lock-in.

Sample work: KatyayaniVistar (AgriTech mobile app, 250+ product catalog, ₹25K+/mo revenue), MehadiMarket (Next.js home-essentials marketplace).

Apps built & run by the studio (live products in the Apps Marketplace section):
- ProTalk — professional networking platform with chat, calls, AI assistants
- UrShop — multi-tenant shop platform for local businesses with live order tracking
- Mehdis — custom stitching marketplace (upload design + measurements)
- ILoveU — tap-to-share location utility app
- VizagDocVisits — doctor home-visit booking platform
- SriLaxmiENTClinic — clinic website for Sri Lakshmi ENT Hospital

Modules: Business Directory (skilled labour/suppliers directory), CloudKitchen (homemaker food marketplace with scheduled dispatch).

AI agents & models built internally: WhatsAppSalesAgent, DeploymentAgent, DataSeedAgent, Aria (cloned-voice AI companion in ProTalk), LeadGenCRM, MarketingAgent.

Contact: pinkisstudiop@gmail.com, +91 99893 36847 (also WhatsApp), Bhopal / Remote. Response within one business day. Visitors can also use the "Start a Project" / "Request Callback" forms on this page.

Answer visitor questions about services, the team, past work, the studio's own apps, and how to get started. There's no fixed public pricing — invite them to share their budget range via the contact form so the team can scope it. Keep replies short — 2-4 sentences, friendly and professional, no markdown formatting. If asked something unrelated to the studio's business, politely redirect to how the studio can help with a software project. If they want to start a project or get a quote, point them to the "Start a Project" form, WhatsApp button, or email above.`;

app.post('/api/studio-chat', chatLimiter, async (req, res) => {
  try {
    const { message, history, visitorId } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ success: false, error: 'No message' });
    }

    const messages = [
      { role: 'system', content: STUDIO_SYSTEM_PROMPT },
      ...(Array.isArray(history) ? history.slice(-10) : []),
      { role: 'user', content: message.slice(0, 2000) }
    ];

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` },
      body: JSON.stringify({ model: 'google/gemma-4-31b-it:free', messages, temperature: 0.5 }),
    });

    const data = await response.json();
    let reply = data.choices?.[0]?.message?.content;
    if (!reply) {
      // OpenRouter's free pool gets rate-limited upstream (429) — retry on Groq
      console.error('[StudioChat] OpenRouter error:', JSON.stringify(data));
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages, temperature: 0.5 }),
      });
      const groqData = await groqRes.json();
      reply = groqData.choices?.[0]?.message?.content;
    }
    if (!reply) {
      return res.status(500).json({ success: false, error: 'Assistant did not respond' });
    }

    if (visitorId) {
      const vid = String(visitorId).slice(0, 64);
      await ChatLog.findOneAndUpdate(
        { visitorId: vid },
        {
          $push: { messages: { $each: [
            { role: 'user', content: message.slice(0, 2000) },
            { role: 'assistant', content: reply }
          ] } },
          $set: { lastUpdatedDate: new Date() },
          $setOnInsert: { createdDate: new Date() }
        },
        { upsert: true }
      );
    }

    res.json({ success: true, reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Chat service error' });
  }
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
  const noInteraction = await AppVisitor.countDocuments({ hadInteraction: false });
  res.json({ success: true, visitors, stats: { total, bots, real: total - bots, noInteraction } });
});

app.delete('/api/admin/visitors', adminAuth, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ success: false, error: 'ids required' });
  await AppVisitor.deleteMany({ _id: { $in: ids } });
  res.json({ success: true });
});

app.get('/api/admin/leads', adminAuth, async (req, res) => {
  const leads = await Lead.find().sort({ createdDate: -1 }).limit(500).lean();
  res.json({ success: true, leads });
});

app.delete('/api/admin/leads', adminAuth, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ success: false, error: 'ids required' });
  await Lead.deleteMany({ _id: { $in: ids } });
  res.json({ success: true });
});

app.get('/api/admin/payments', adminAuth, async (req, res) => {
  const payments = await Payment.find().sort({ createdDate: -1 }).limit(500).lean();
  res.json({ success: true, payments });
});

// Approve/reject routes for /api/admin/payments/:key/approve|reject are
// mounted by manual-upi-kit.js above.

app.delete('/api/admin/payments', adminAuth, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ success: false, error: 'ids required' });
  await Payment.deleteMany({ _id: { $in: ids } });
  res.json({ success: true });
});

app.get('/api/admin/chats', adminAuth, async (req, res) => {
  const chats = await ChatLog.find().sort({ lastUpdatedDate: -1 }).limit(200).lean();
  res.json({ success: true, chats });
});

app.delete('/api/admin/chats', adminAuth, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ success: false, error: 'ids required' });
  await ChatLog.deleteMany({ _id: { $in: ids } });
  res.json({ success: true });
});

// SPA fallback — keep last, after API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`PinkisAppStudio server running on port ${PORT}`));
