const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { MongoClient } = require('mongodb');
const PDFDocument = require('pdfkit');
const webPush = require('web-push');
const geoip = require('geoip-country');

const app = express();
const port = Number(process.env.PORT) || 3000;
const publicDir = path.join(__dirname, 'public');
const mongoUri = process.env.MONGODB_URI || '';
const placeholderMongoUri = !mongoUri || /CLUSTER\.mongodb\.net|USER:PASSWORD/i.test(mongoUri);
const client = new MongoClient(placeholderMongoUri ? 'mongodb://127.0.0.1:27017/netrue' : mongoUri);
let db;
let previewMode = false;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], baseUri: ["'self'"], formAction: ["'self'", 'https://checkout.paystack.com'],
      frameAncestors: ["'none'"], frameSrc: ["'self'", 'https://maps.google.com', 'https://www.google.com'], objectSrc: ["'none'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'], connectSrc: ["'self'", 'https://api.paystack.co']
    }
  }
}));
app.use(express.json({ limit: '20kb' }));

const paymentLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false });
const verifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
const receiptLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
const enquiryLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 6, standardHeaders: 'draft-7', legacyHeaders: false });
const quickChatLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false });
const visitorLimiter = rateLimit({ windowMs: 60 * 1000, limit: 180, standardHeaders: 'draft-7', legacyHeaders: false });
const adminLimiter = rateLimit({ windowMs: 60 * 1000, limit: 90, standardHeaders: 'draft-7', legacyHeaders: false });

const vapidConfigured = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (vapidConfigured) {
  webPush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:info@netrue.io', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

function pushFailureHint(error) {
  if ([401, 403].includes(error?.statusCode)) return 'Push service rejected the VAPID credentials. Confirm the Railway key pair and re-enable alerts on devices if the keys changed.';
  if ([404, 410].includes(error?.statusCode)) return 'This browser subscription expired. Re-enable push alerts on that device.';
  return `Push delivery failed${error?.statusCode ? ` (${error.statusCode})` : ''}. Check the Railway deployment logs.`;
}

async function deliverPush(subscription, title, body, url, tag) {
  await webPush.sendNotification(subscription, JSON.stringify({ title, body, url, tag }), { TTL: 120, urgency: 'high' });
}

async function notifyAdmins(title, body, url = '/admin', tag = 'netrue-activity') {
  if (!db || !vapidConfigured) return { sent: 0, failed: 0, subscriptions: 0 };
  try {
    const subscriptions = await db.collection('push_subscriptions').find({}, { projection: { _id: 0 } }).toArray();
    let sent = 0;
    const outcomes = await Promise.allSettled(subscriptions.map(async subscription => {
      try { await deliverPush(subscription, title, body, url, tag); sent += 1; }
      catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) await db.collection('push_subscriptions').deleteOne({ endpoint: subscription.endpoint });
        throw error;
      }
    }));
    const failures = outcomes.filter(item => item.status === 'rejected');
    if (failures.length) console.error('Admin push delivery summary:', failures.map(item => pushFailureHint(item.reason)).join(' | '));
    return { sent, failed: failures.length, subscriptions: subscriptions.length };
  } catch (error) { console.error('Admin push lookup failed:', error.message); return { sent: 0, failed: 1, subscriptions: 0 }; }
}

function countryFromRequest(req) {
  for (const header of ['cf-ipcountry', 'x-vercel-ip-country', 'cloudfront-viewer-country']) {
    const country = String(req.get(header) || '').split(',')[0].trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(country) && country !== 'XX' && country !== 'T1') return country;
  }
  // Railway sets X-Real-IP from its edge proxy, preserving the original client IP
  // even when an additional CDN sits in front of the Railway deployment.
  const ip = String(req.get('x-real-ip') || req.get('cf-connecting-ip') || req.ip || '').split(',')[0].trim().replace(/^::ffff:/i, '');
  if (!ip || ip === '::1' || ip === '127.0.0.1') return null;
  try { return geoip.lookup(ip)?.country || null; } catch { return null; }
}

function requestCookie(req, name) {
  return (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

function validVisitorPage(value) {
  if (typeof value !== 'string' || value.length > 180 || !value.startsWith('/')) return '/';
  try {
    const url = new URL(value, 'https://netrue.invalid');
    if (url.origin !== 'https://netrue.invalid') return '/';
    return `${url.pathname}${url.hash}`.slice(0, 180);
  } catch { return '/'; }
}

function validReference(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value);
}

function formatCurrencyMinor(amountMinor, currency) {
  const formatter = new Intl.NumberFormat('en', { style: 'currency', currency });
  const decimals = formatter.resolvedOptions().maximumFractionDigits;
  return formatter.format(amountMinor / (10 ** decimals));
}

function amountToMinor(value, currency) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,3})?$/.test(value.trim())) return null;
  const decimals = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  const [whole, fraction = ''] = value.trim().split('.');
  if (fraction.length > decimals) return null;
  const minor = Number(whole) * (10 ** decimals) + Number((fraction + '0'.repeat(decimals)).slice(0, decimals) || 0);
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

function receiptCookieValue(reference) {
  const secret = process.env.RECEIPT_COOKIE_SECRET;
  if (!secret) throw new Error('RECEIPT_COOKIE_SECRET is not configured.');
  const signature = crypto.createHmac('sha256', secret).update(reference).digest('hex');
  return `${reference}.${signature}`;
}

function cookieReference(req) {
  const raw = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('netrue_receipt='))?.slice('netrue_receipt='.length);
  if (!raw) return null;
  const [reference, signature] = decodeURIComponent(raw).split('.');
  if (!validReference(reference) || !signature) return null;
  const expected = receiptCookieValue(reference).split('.')[1];
  return safeSecretEqual(signature, expected) ? reference : null;
}

function paymentSessionReference(req) {
  const raw = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('netrue_payment_session='))?.slice('netrue_payment_session='.length);
  if (!raw) return null;
  const [reference, signature] = decodeURIComponent(raw).split('.');
  if (!validReference(reference) || !signature) return null;
  const expected = crypto.createHmac('sha256', process.env.RECEIPT_COOKIE_SECRET || '').update(`session:${reference}`).digest('hex');
  return safeSecretEqual(signature, expected) ? reference : null;
}

function setPaymentSessionCookie(res, reference, req) {
  const signature = crypto.createHmac('sha256', process.env.RECEIPT_COOKIE_SECRET || '').update(`session:${reference}`).digest('hex');
  res.cookie('netrue_payment_session', `${reference}.${signature}`, { httpOnly: true, secure: process.env.NODE_ENV === 'production' || Boolean(req.secure), sameSite: 'lax', path: '/', maxAge: 48 * 60 * 60 * 1000 });
}

function receiptCookieOptions(req) {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production' || Boolean(req.secure), sameSite: 'lax', path: '/api/receipt', maxAge: 48 * 60 * 60 * 1000 };
}

function publicService(service) {
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    amountMinor: Number.isSafeInteger(service.amountMinor) ? service.amountMinor : null,
    currency: service.currency,
    active: service.active === true && Number.isSafeInteger(service.amountMinor) && service.amountMinor > 0 && /^[A-Z]{3}$/.test(service.currency)
  };
}

async function seedServiceCatalog() {
  const services = JSON.parse(fs.readFileSync(path.join(__dirname, 'services.json'), 'utf8'));
  const collection = db.collection('services');
  for (const service of services) {
    await collection.updateOne({ id: service.id }, { $setOnInsert: { ...service, catalogVisible: true } }, { upsert: true });
  }
}

async function paystackRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.status !== true) {
    const error = new Error(result.message || 'Paystack could not complete the request.');
    error.statusCode = response.status >= 500 ? 502 : 400;
    throw error;
  }
  return result.data;
}

app.get('/api/health', (_req, res) => res.json({ ok: true, mode: previewMode ? 'preview' : 'connected' }));

app.post('/api/visitor/pulse', visitorLimiter, async (req, res, next) => {
  try {
    if (requestCookie(req, 'netrue_visitor_consent') !== 'accepted') return res.status(204).end();
    if (!db) return res.status(204).end();
    const now = new Date();
    let visitorId = requestCookie(req, 'netrue_visitor');
    if (!/^[a-f0-9]{32}$/.test(visitorId)) {
      visitorId = crypto.randomBytes(16).toString('hex');
      res.cookie('netrue_visitor', visitorId, { httpOnly: true, secure: process.env.NODE_ENV === 'production' || Boolean(req.secure), sameSite: 'lax', path: '/', maxAge: 180 * 24 * 60 * 60 * 1000 });
    }
    const sessionId = typeof req.body?.sessionId === 'string' && /^[a-f0-9-]{16,40}$/i.test(req.body.sessionId) ? req.body.sessionId : '';
    if (!sessionId) return res.status(400).json({ error: 'Invalid visit session.' });
    const page = validVisitorPage(req.body?.page);
    const previous = await db.collection('visitor_sessions').findOne({ _id: sessionId });
    const countryCode = countryFromRequest(req) || previous?.countryCode || null;
    const event = ['visit', 'heartbeat', 'page', 'inactive', 'resume'].includes(req.body?.event) ? req.body.event : 'heartbeat';
    const sessions = db.collection('visitor_sessions');
    const visitors = db.collection('visitors');
    const isNewSession = !previous;
    const previousVisitor = isNewSession ? await visitors.findOne({ _id: visitorId }, { projection: { _id: 1 } }) : null;
    const previousPath = previous?.currentPage || '';
    const rawGapSeconds = previous?.lastActiveAt ? Math.floor((now - new Date(previous.lastActiveAt)) / 1000) : 0;
    const gapSeconds = rawGapSeconds >= 0 && rawGapSeconds <= 30 ? rawGapSeconds : 0;
    const pageHistory = Array.isArray(previous?.pageHistory) ? previous.pageHistory.slice(-19) : [];
    if (!pageHistory.length) pageHistory.push({ page, enteredAt: now, durationSeconds: 0 });
    else if (previousPath !== page) {
      if (gapSeconds) pageHistory[pageHistory.length - 1].durationSeconds = Math.min(86400, (pageHistory.at(-1).durationSeconds || 0) + gapSeconds);
      pageHistory.push({ page, enteredAt: now, durationSeconds: 0 });
    }
    else pageHistory[pageHistory.length - 1].durationSeconds = Math.min(86400, (pageHistory.at(-1).durationSeconds || 0) + gapSeconds);
    const isOffline = event === 'inactive';
    await sessions.updateOne({ _id: sessionId }, {
      $set: {
        visitorId, visitorLabel: `Visitor ${visitorId.slice(-5).toUpperCase()}`, currentPage: page, countryCode,
        visitorType: previous?.visitorType || (previousVisitor ? 'returning' : 'new'),
        pageHistory, status: isOffline ? 'offline' : 'online', lastActiveAt: isOffline ? (previous?.lastActiveAt || now) : now,
        updatedAt: now, expiresAt: new Date(now.getTime() + 30 * 86400000),
        startedAt: previous?.startedAt || now, totalDurationSeconds: (previous?.totalDurationSeconds || 0) + gapSeconds
      },
      $setOnInsert: { createdAt: now }
    }, { upsert: true });
    if (isNewSession && event !== 'inactive') {
      await visitors.updateOne({ _id: visitorId }, {
        $set: { lastSeenAt: now, countryCode, expiresAt: new Date(now.getTime() + 180 * 86400000) },
        $setOnInsert: { firstSeenAt: now },
        $inc: { visitCount: 1 }
      }, { upsert: true });
      const countryName = countryCode ? new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode) : null;
      void notifyAdmins(previousVisitor ? 'Returning visitor arrived' : 'New website visitor', `Visitor ${visitorId.slice(-5).toUpperCase()}${countryName ? ` from ${countryName}` : ''} opened ${page}.`, '/admin?view=visitors', `visitor-${sessionId}`);
    }
    res.json({ tracked: true });
  } catch (error) { next(error); }
});

app.get('/api/services', async (_req, res, next) => {
  try {
    const services = db
      ? await db.collection('services').find({ $or: [{ catalogVisible: { $exists: false } }, { catalogVisible: true }] }, { projection: { _id: 0 } }).sort({ name: 1 }).toArray()
      : JSON.parse(fs.readFileSync(path.join(__dirname, 'services.json'), 'utf8'));
    res.json(services.map(publicService));
  } catch (error) { next(error); }
});

app.get('/api/projects', async (_req, res, next) => {
  try {
    const projects = db ? await db.collection('projects').find({ active: true }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray() : [];
    res.json(projects);
  } catch (error) { next(error); }
});

app.post('/api/quick-chats', quickChatLimiter, async (req, res, next) => {
  try {
    if (!db) return res.status(503).json({ error: 'Quick chat saving needs MongoDB. Add a valid MONGODB_URI and restart the app.' });
    const { message, name, email, consent } = req.body || {};
    const cleanMessage = typeof message === 'string' ? message.trim() : '';
    const cleanName = typeof name === 'string' ? name.trim() : '';
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (cleanMessage.length < 2 || cleanMessage.length > 1200) return res.status(400).json({ error: 'Write a message between 2 and 1,200 characters.' });
    if (cleanName.length > 100) return res.status(400).json({ error: 'Name must be 100 characters or fewer.' });
    if (cleanEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return res.status(400).json({ error: 'Enter a valid email address for the reply.' });
    if (consent !== true) return res.status(400).json({ error: 'Please agree that Netrue may use your message and email to respond.' });
    const reference = `NTC-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const now = new Date();
    await db.collection('quick_chats').insertOne({
      reference, name: cleanName || 'Visitor', email: cleanEmail,
      messages: [{ sender: 'user', text: cleanMessage, sentAt: now }],
      status: 'new', consent: true, source: 'landing_quick_chat',
      createdAt: now, updatedAt: now
    });
    void notifyAdmins('New quick chat', `A visitor sent a message. Reference ${reference}.`, '/admin?view=chats', `quick-chat-${reference}`);
    res.status(201).json({ accepted: true, reference });
  } catch (error) { next(error); }
});

app.post('/api/enquiries', enquiryLimiter, async (req, res, next) => {
  try {
    if (!db) return res.status(503).json({ error: 'Enquiry saving needs MongoDB. Add a valid MONGODB_URI to your local .env file.' });
    const { intent, category, message, budget, timeline, name, email, whatsapp, consent } = req.body || {};
    const intents = ['Request a quotation', 'Ask about a service', 'Partnership or general enquiry'];
    const categories = ['AI', 'IoT & connected systems', 'Embedded systems', 'Smart agriculture', 'Web or app development', 'Other'];
    const budgets = ['Prefer to discuss', 'Not sure yet', 'Under $1,000', '$1,000–$5,000', '$5,000+'];
    const timelines = ['Exploring', 'Immediately', 'Within 1 month', '1–3 months'];
    if (!intents.includes(intent) || !categories.includes(category) || !budgets.includes(budget) || !timelines.includes(timeline)) return res.status(400).json({ error: 'Please review your enquiry and try again.' });
    if (typeof message !== 'string' || message.trim().length < 3 || message.length > 1500) return res.status(400).json({ error: 'Add a few details about your project (up to 1,500 characters).' });
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) return res.status(400).json({ error: 'Enter a valid name.' });
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const cleanWhatsapp = typeof whatsapp === 'string' ? whatsapp.trim() : '';
    if (cleanEmail && (cleanEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail))) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (cleanWhatsapp.length > 30 || (cleanWhatsapp && !/^\+?[0-9 ()-]{7,30}$/.test(cleanWhatsapp))) return res.status(400).json({ error: 'Enter a valid WhatsApp number.' });
    if (!cleanEmail && !cleanWhatsapp) return res.status(400).json({ error: 'Add an email address or WhatsApp number so Netrue can reply.' });
    if (consent !== true) return res.status(400).json({ error: 'Please confirm that Netrue may use your details to respond.' });
    const reference = `NTQ-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    await db.collection('enquiries').insertOne({
      reference, intent, category, message: message.trim(), budget, timeline,
      name: name.trim(), email: cleanEmail || null, whatsapp: cleanWhatsapp || null,
      consent: true, status: 'new', createdAt: new Date()
    });
    void notifyAdmins('New project enquiry', `A visitor sent an enquiry. Reference ${reference}.`, '/admin?view=chats', `enquiry-${reference}`);
    res.status(201).json({ accepted: true, reference });
  } catch (error) { next(error); }
});

app.post('/api/payment-quotes/lookup', paymentLimiter, async (req, res, next) => {
  try {
    if (!db) return res.status(503).json({ error: 'Quote lookup needs MongoDB.' });
    const reference = typeof req.body?.reference === 'string' ? req.body.reference.trim().toUpperCase() : '';
    if (!/^NTRQ-[A-F0-9]{12}$/.test(reference)) return res.status(400).json({ error: 'Enter a valid Netrue quote reference.' });
    const quote = await db.collection('payment_quotes').findOne({ reference, status: 'open', expiresAt: { $gt: new Date() } });
    if (!quote) return res.status(404).json({ error: 'This quote could not be found or has expired. Contact Netrue for an updated quote.' });
    res.json({ reference: quote.reference, serviceId: quote.serviceId, serviceName: quote.serviceName, amountMinor: quote.amountMinor, currency: quote.currency, agreedPrice: quote.agreedPrice, requiresEmail: !quote.customerEmail });
  } catch (error) { next(error); }
});

function normalizeCheckout(req) {
  const ids = [...new Set(Array.isArray(req.body?.serviceIds) ? req.body.serviceIds : [])].filter(id => typeof id === 'string' && /^[a-z0-9-]{2,80}$/.test(id));
  const currency = typeof req.body?.currency === 'string' ? req.body.currency.toUpperCase() : 'USD';
  const amountMinor = amountToMinor(String(req.body?.agreedPrice || ''), currency);
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
  if (!ids.length || ids.length > 20) return { error: 'Select at least one valid service.' };
  if (!['USD', 'GBP', 'NGN', 'BRL'].includes(currency) || !amountMinor) return { error: 'Enter the agreed total price in a supported currency.' };
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Enter a valid email address for your receipt.' };
  return { ids, currency, amountMinor, email, name };
}

async function preparePayment(body, method) {
  const checked = normalizeCheckout({ body });
  if (checked.error) return checked;
  const services = await db.collection('services').find({ id: { $in: checked.ids }, $or: [{ catalogVisible: { $exists: false } }, { catalogVisible: true }] }, { projection: { _id: 0, id: 1, name: 1 } }).toArray();
  if (services.length !== checked.ids.length) return { error: 'One or more selected services are unavailable.' };
  const reference = `NTR-${crypto.randomUUID()}`;
  const now = new Date();
  const payment = {
    reference, serviceIds: services.map(service => service.id), serviceNames: services.map(service => service.name),
    serviceName: services.map(service => service.name).join(', '), amountMinor: checked.amountMinor, currency: checked.currency,
    customerName: checked.name || 'Customer', customerEmail: checked.email, method,
    status: method === 'bank_transfer' ? 'awaiting_customer_payment' : 'pending', createdAt: now
  };
  await db.collection('payments').insertOne(payment);
  return { payment, ...checked };
}

app.post('/api/payments/initialize-multi', paymentLimiter, async (req, res, next) => {
  try {
    if (!db) return res.status(503).json({ error: 'Checkout needs MongoDB.' });
    if (!process.env.PAYSTACK_SECRET_KEY) return res.status(503).json({ error: 'Paystack is not configured yet. Choose bank transfer or contact Netrue.' });
    if (!process.env.RECEIPT_COOKIE_SECRET || process.env.RECEIPT_COOKIE_SECRET.length < 32 || !process.env.PUBLIC_URL || !/^https:\/\//.test(process.env.PUBLIC_URL)) return res.status(503).json({ error: 'Secure checkout is not configured yet.' });
    const prepared = await preparePayment(req.body, 'paystack');
    if (prepared.error) return res.status(400).json({ error: prepared.error });
    const { payment, email, name } = prepared;
    const callbackUrl = new URL('/payment.html', process.env.PUBLIC_URL); callbackUrl.searchParams.set('reference', payment.reference);
    try {
      const checkout = await paystackRequest('https://api.paystack.co/transaction/initialize', { method: 'POST', body: JSON.stringify({ email, amount: payment.amountMinor, currency: payment.currency, reference: payment.reference, callback_url: callbackUrl.toString(), metadata: { customer_name: name || 'Customer', service_names: payment.serviceNames } }) });
      await db.collection('payments').updateOne({ reference: payment.reference }, { $set: { authorizationUrl: checkout.authorization_url, paystackAccessCode: checkout.access_code } });
      setPaymentSessionCookie(res, payment.reference, req);
      res.json({ authorizationUrl: checkout.authorization_url, reference: payment.reference });
    } catch (error) { await db.collection('payments').updateOne({ reference: payment.reference }, { $set: { status: 'initialization_failed' } }); throw error; }
  } catch (error) { next(error); }
});

app.get('/api/payment-settings', async (_req, res, next) => {
  try {
    const settings = db ? await db.collection('site_settings').findOne({ _id: 'payments' }) : null;
    res.json({ bankTransferEnabled: Boolean(settings?.bankAccountName && settings?.bankAccountDetails), paystackEnabled: Boolean(process.env.PAYSTACK_SECRET_KEY), bankAccountName: settings?.bankAccountName || '', bankAccountDetails: settings?.bankAccountDetails || '' });
  } catch (error) { next(error); }
});

app.post('/api/payments/bank-transfer', paymentLimiter, async (req, res, next) => {
  try {
    if (!db) return res.status(503).json({ error: 'Checkout needs MongoDB.' });
    if (!process.env.RECEIPT_COOKIE_SECRET || process.env.RECEIPT_COOKIE_SECRET.length < 32) return res.status(503).json({ error: 'Secure checkout is not configured yet.' });
    const settings = await db.collection('site_settings').findOne({ _id: 'payments' });
    if (!settings?.bankAccountName || !settings?.bankAccountDetails) return res.status(503).json({ error: 'Bank transfer is not available yet. Choose Paystack or contact Netrue.' });
    const prepared = await preparePayment(req.body, 'bank_transfer');
    if (prepared.error) return res.status(400).json({ error: prepared.error });
    const { payment, bankAccountName, bankAccountDetails } = { ...prepared, ...settings };
    setPaymentSessionCookie(res, payment.reference, req);
    res.status(201).json({ reference: payment.reference, amount: formatCurrencyMinor(payment.amountMinor, payment.currency), serviceNames: payment.serviceNames, bankAccountName, bankAccountDetails, status: payment.status });
  } catch (error) { next(error); }
});

app.get('/api/payments/resume', async (req, res, next) => {
  try {
    if (!db) return res.status(204).end();
    const reference = paymentSessionReference(req);
    if (!reference) return res.status(204).end();
    const payment = await db.collection('payments').findOne({ reference, createdAt: { $gt: new Date(Date.now() - 48 * 60 * 60 * 1000) } });
    if (!payment || payment.status === 'cancelled') return res.status(204).end();
    const settings = await db.collection('site_settings').findOne({ _id: 'payments' });
    if (payment.status === 'paid') res.cookie('netrue_receipt', receiptCookieValue(reference), receiptCookieOptions(req));
    res.json({ reference, method: payment.method, serviceNames: payment.serviceNames || [payment.serviceName], amount: formatCurrencyMinor(payment.amountMinor, payment.currency), status: payment.status, receiptNumber: payment.receiptNumber || null, receiptUrl: payment.status === 'paid' ? '/api/receipt/download' : null, bankAccountName: settings?.bankAccountName || '', bankAccountDetails: settings?.bankAccountDetails || '' });
  } catch (error) { next(error); }
});

app.get('/payment/return-home', (req, res) => {
  res.clearCookie('netrue_payment_session', { httpOnly: true, secure: process.env.NODE_ENV === 'production' || Boolean(req.secure), sameSite: 'lax', path: '/' });
  res.redirect(303, '/');
});

app.post('/api/payments/bank-transfer/:reference/paid', paymentLimiter, async (req, res, next) => {
  try {
    const reference = req.params.reference;
    if (paymentSessionReference(req) !== reference) return res.status(403).json({ error: 'This payment session has expired. Reopen the payment link or contact Netrue.' });
    const payment = await db.collection('payments').findOne({ reference, method: 'bank_transfer', status: 'awaiting_customer_payment' });
    if (!payment) return res.status(409).json({ error: 'This payment is no longer waiting for payment.' });
    await db.collection('payments').updateOne({ reference, status: 'awaiting_customer_payment' }, { $set: { status: 'awaiting_approval', customerMarkedPaidAt: new Date() } });
    void notifyAdmins('Bank transfer needs approval', `${payment.serviceName}: ${formatCurrencyMinor(payment.amountMinor, payment.currency)} (${reference}).`, '/admin?view=payments', `transfer-${reference}`);
    res.json({ status: 'awaiting_approval' });
  } catch (error) { next(error); }
});

app.get('/api/payments/bank-transfer/:reference/status', async (req, res, next) => {
  try {
    const reference = req.params.reference;
    if (paymentSessionReference(req) !== reference) return res.status(403).json({ error: 'Payment session expired.' });
    const payment = await db.collection('payments').findOne({ reference, method: 'bank_transfer' });
    if (!payment) return res.status(404).json({ error: 'Payment not found.' });
    if (payment.status === 'paid') res.cookie('netrue_receipt', receiptCookieValue(reference), receiptCookieOptions(req));
    res.json({ status: payment.status, receiptNumber: payment.receiptNumber || null, receiptUrl: payment.status === 'paid' ? '/api/receipt/download' : null });
  } catch (error) { next(error); }
});

app.post('/api/payments/bank-transfer/:reference/cancel', async (req, res, next) => {
  try {
    const reference = req.params.reference;
    if (paymentSessionReference(req) !== reference) return res.status(403).json({ error: 'Payment session expired.' });
    await db.collection('payments').updateOne({ reference, method: 'bank_transfer', status: { $in: ['awaiting_customer_payment', 'awaiting_approval'] } }, { $set: { status: 'cancelled', cancelledAt: new Date() } });
    res.clearCookie('netrue_payment_session', { httpOnly: true, secure: process.env.NODE_ENV === 'production' || Boolean(req.secure), sameSite: 'lax', path: '/' });
    res.json({ cancelled: true });
  } catch (error) { next(error); }
});

app.post('/api/payments/initialize', paymentLimiter, async (req, res, next) => {
  try {
    if (!db) return res.status(503).json({ error: 'Checkout needs MongoDB. Add a valid MONGODB_URI to your local .env file.' });
    const { serviceId, email, name, quoteReference } = req.body || {};
    if (typeof serviceId !== 'string' || !/^[a-z0-9-]{2,80}$/.test(serviceId)) return res.status(400).json({ error: 'Choose a valid service.' });
    const suppliedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (suppliedEmail && (suppliedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(suppliedEmail))) return res.status(400).json({ error: 'Enter a valid email address.' });
    const cleanName = typeof name === 'string' ? name.trim().slice(0, 120) : '';

    const quoteRef = typeof quoteReference === 'string' ? quoteReference.trim().toUpperCase() : '';
    if (!/^NTRQ-[A-F0-9]{12}$/.test(quoteRef)) return res.status(400).json({ error: 'Apply your Netrue quote before continuing.' });
    const quote = await db.collection('payment_quotes').findOne({ reference: quoteRef, serviceId, status: 'open', expiresAt: { $gt: new Date() } });
    if (!quote) return res.status(409).json({ error: 'This quote is unavailable or has expired. Contact Netrue for an updated quote.' });
    if (quote.customerEmail && suppliedEmail && quote.customerEmail !== suppliedEmail) return res.status(400).json({ error: 'Use the email address that was provided with this quote.' });
    const customerEmail = quote.customerEmail || suppliedEmail;
    if (!customerEmail) return res.status(400).json({ error: 'Enter an email address so Paystack can process the payment and send a receipt.' });
    const item = { id: quote.serviceId, name: quote.serviceName, amountMinor: quote.amountMinor, currency: quote.currency };
    if (!process.env.PAYSTACK_SECRET_KEY) return res.status(503).json({ error: 'Online payment is not configured yet. Please contact Netrue.' });
    if (!process.env.RECEIPT_COOKIE_SECRET || process.env.RECEIPT_COOKIE_SECRET.length < 32) return res.status(503).json({ error: 'Secure receipt downloads are not configured yet.' });
    if (!process.env.PUBLIC_URL || !/^https:\/\//.test(process.env.PUBLIC_URL)) return res.status(503).json({ error: 'The secure payment callback is not configured yet.' });

    const reference = `NTR-${crypto.randomUUID()}`;
    const reserved = await db.collection('payment_quotes').updateOne({ _id: quote._id, status: 'open', expiresAt: { $gt: new Date() } }, { $set: { status: 'checkout_started', checkoutReference: reference, checkoutStartedAt: new Date() } });
    if (!reserved.modifiedCount) return res.status(409).json({ error: 'This quote has already been used to start a checkout. Contact Netrue if you need a new payment link.' });
    const callbackUrl = new URL('/payment.html', process.env.PUBLIC_URL);
    callbackUrl.searchParams.set('reference', reference);
    await db.collection('payments').insertOne({
      reference, serviceId: item.id, serviceName: item.name, amountMinor: item.amountMinor,
      currency: item.currency, quoteReference: quote.reference, customerName: cleanName || quote.customerName || 'Customer', customerEmail,
      status: 'pending', createdAt: new Date()
    });
    let checkout;
    try {
      checkout = await paystackRequest('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        body: JSON.stringify({
          email: customerEmail, amount: item.amountMinor, currency: item.currency, reference,
          callback_url: callbackUrl.toString(),
          metadata: { customer_name: cleanName || quote.customerName || 'Customer', service_id: item.id, service_name: item.name }
        })
      });
    } catch (error) {
      await db.collection('payments').updateOne({ reference }, { $set: { status: 'initialization_failed', initializationFailedAt: new Date() } });
      await db.collection('payment_quotes').updateOne({ _id: quote._id, checkoutReference: reference }, { $set: { status: 'open' }, $unset: { checkoutReference: '', checkoutStartedAt: '' } });
      throw error;
    }
    try {
      await db.collection('payments').updateOne({ reference }, { $set: { authorizationUrl: checkout.authorization_url, paystackAccessCode: checkout.access_code } });
    } catch (error) {
      console.error('Could not save optional Paystack checkout metadata:', error.message);
    }
    res.json({ authorizationUrl: checkout.authorization_url, reference });
  } catch (error) { next(error); }
});

app.get('/api/payments/verify/:reference', verifyLimiter, async (req, res, next) => {
  try {
    if (!db) return res.status(503).json({ error: 'Payment verification needs MongoDB. Add a valid MONGODB_URI to your local .env file.' });
    const { reference } = req.params;
    if (!validReference(reference)) return res.status(400).json({ error: 'Invalid payment reference.' });
    const payment = await db.collection('payments').findOne({ reference });
    if (!payment) return res.status(404).json({ error: 'Payment reference was not found.' });
    if (!['pending', 'review', 'paid'].includes(payment.status)) return res.status(409).json({ error: 'This payment session could not be started. Please return to the payment page.' });
    if (payment.status !== 'paid') {
      if (!process.env.PAYSTACK_SECRET_KEY) return res.status(503).json({ error: 'Payment verification is not configured.' });
      const transaction = await paystackRequest(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`);
      const actualAmount = Number(transaction.amount);
      const actualCurrency = typeof transaction.currency === 'string' ? transaction.currency.trim().toUpperCase() : '';
      const expectedCurrency = String(payment.currency || '').trim().toUpperCase();
      const correctReference = String(transaction.reference || '') === reference;
      const correctAmount = Number.isSafeInteger(actualAmount) && actualAmount === Number(payment.amountMinor);
      const correctCurrency = actualCurrency === expectedCurrency;
      if (transaction.status !== 'success' || !correctReference || !correctAmount || !correctCurrency) {
        if (transaction.status === 'success' && (!correctReference || !correctAmount || !correctCurrency)) {
          await db.collection('payments').updateOne({ reference, status: { $in: ['pending', 'review'] } }, { $set: {
            status: 'review', verificationIssue: 'paystack_transaction_mismatch', verificationCheckedAt: new Date(),
            verificationExpected: { amountMinor: Number(payment.amountMinor), currency: expectedCurrency, reference },
            verificationReceived: { amountMinor: Number.isSafeInteger(actualAmount) ? actualAmount : null, currency: actualCurrency || null, reference: String(transaction.reference || '') }
          } });
          return res.status(409).json({ error: 'The payment needs manual review. Please contact Netrue with your payment reference.' });
        }
        return res.status(402).json({ error: 'Payment has not been completed.' });
      }
      const markedPaid = await db.collection('payments').updateOne({ reference, status: { $in: ['pending', 'review'] } }, {
        $set: { status: 'paid', paidAt: transaction.paid_at ? new Date(transaction.paid_at) : new Date(), verifiedAt: new Date(), receiptNumber: `NTR-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${reference.slice(-8).toUpperCase()}` }
      });
      if (markedPaid.modifiedCount) void notifyAdmins('Payment completed', `${payment.serviceName} payment verified (${reference}).`, '/admin?view=visitors', `payment-${reference}`);
      if (payment.quoteReference) await db.collection('payment_quotes').updateOne({ reference: payment.quoteReference, checkoutReference: reference }, { $set: { status: 'paid', paidAt: new Date() } });
    }
    const confirmed = await db.collection('payments').findOne({ reference, status: 'paid' });
    if (!confirmed) return res.status(409).json({ error: 'Payment confirmation is being processed. Refresh in a moment.' });
    res.cookie('netrue_receipt', receiptCookieValue(reference), receiptCookieOptions(req));
    res.json({ status: 'paid', reference, receiptNumber: confirmed.receiptNumber, serviceName: confirmed.serviceName, amount: formatCurrencyMinor(confirmed.amountMinor, confirmed.currency), receiptUrl: '/api/receipt/download' });
  } catch (error) { next(error); }
});

function streamReceipt(res, payment) {
    const filename = `Netrue-receipt-${payment.receiptNumber}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const pdf = new PDFDocument({ size: 'A4', margin: 54, info: { Title: `Netrue payment receipt ${payment.receiptNumber}`, Author: 'Netrue Limited', Subject: `Receipt for ${payment.serviceName}` } });
    pdf.pipe(res);
    pdf.rect(0, 0, 595, 210).fill('#173b2c');
    pdf.rect(0, 204, 595, 6).fill('#c7a34e');
    // The three ascending bars and coral dot match the Netrue favicon mark.
    pdf.roundedRect(54, 48, 7, 15, 3).fill('#d9e9d9');
    pdf.roundedRect(65, 37, 7, 26, 3).fill('#d9e9d9');
    pdf.roundedRect(76, 43, 7, 20, 3).fill('#d9e9d9');
    pdf.circle(86, 62, 2.5).fill('#df5147');
    pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(23).text('netrue', 101, 42);
    pdf.fillColor('#dce8dc').font('Helvetica').fontSize(9).text('NETRUE LIMITED  /  DIGITAL & ENGINEERING', 54, 91, { characterSpacing: 1.2 });
    pdf.fillColor('#e6c76d').font('Helvetica-Bold').fontSize(10).text('PAYMENT RECEIPT', 54, 126, { characterSpacing: 1.7 });
    pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(17).text(payment.receiptNumber, 54, 148);
    pdf.roundedRect(454, 132, 87, 28, 14).fill('#e8f2e8');
    pdf.fillColor('#246441').font('Helvetica-Bold').fontSize(9).text('PAID', 454, 142, { width: 87, align: 'center', characterSpacing: 1 });
    pdf.roundedRect(54, 235, 487, 103, 12).fill('#f4f6ef');
    pdf.fillColor('#748076').font('Helvetica-Bold').fontSize(8).text('AMOUNT RECEIVED', 74, 257, { characterSpacing: 1.2 });
    pdf.fillColor('#203f2e').font('Helvetica-Bold').fontSize(27).text(formatCurrencyMinor(payment.amountMinor, payment.currency), 74, 278, { width: 430 });
    pdf.fillColor('#657369').font('Helvetica').fontSize(10).text(payment.serviceName, 74, 316, { width: 435 });
    pdf.fillColor('#252b28').font('Helvetica-Bold').fontSize(12).text('Payment details', 54, 374);
    pdf.moveTo(54, 397).lineTo(541, 397).strokeColor('#dce2dd').lineWidth(1).stroke();
    const details = [
      ['Customer', payment.customerName || 'Customer'], ['Receipt email', payment.customerEmail],
      ['Payment reference', payment.reference], ['Paid on', new Date(payment.paidAt).toLocaleString('en', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC']
    ];
    let y = 421;
    for (const [label, value] of details) {
      pdf.fillColor('#7b857c').font('Helvetica-Bold').fontSize(8).text(label.toUpperCase(), 54, y, { width: 135, characterSpacing: .6 });
      pdf.fillColor('#26392d').font('Helvetica').fontSize(10).text(String(value || '—'), 196, y - 1, { width: 345 });
      y += 43;
    }
    pdf.moveTo(54, y + 1).lineTo(541, y + 1).strokeColor('#dce2dd').lineWidth(1).stroke();
    pdf.fillColor('#253c2d').font('Helvetica-Bold').fontSize(12).text('Thank you for choosing Netrue.', 54, y + 25);
    pdf.fillColor('#707b72').font('Helvetica').fontSize(9).text('Questions about this receipt? Contact info@netrue.io  ·  netrue.io', 54, y + 47, { width: 487 });
    const paymentNote = payment.method === 'bank_transfer' ? 'This receipt confirms a bank transfer reviewed and approved by Netrue.' : 'This receipt confirms payment processed securely by Paystack.';
    pdf.fillColor('#a0a79f').font('Helvetica').fontSize(8).text(paymentNote, 54, 773, { width: 487, align: 'center' });
    pdf.end();
}

app.get('/api/receipt/download', receiptLimiter, async (req, res, next) => {
  try {
    if (!db) return res.status(503).json({ error: 'Receipt downloads need MongoDB.' });
    const reference = cookieReference(req);
    if (!reference) return res.status(401).send('Use the same browser that completed the payment to download its receipt.');
    const payment = await db.collection('payments').findOne({ reference, status: 'paid' });
    if (!payment) return res.status(404).send('A receipt is available only after a verified payment.');
    streamReceipt(res, payment);
  } catch (error) { next(error); }
});

function safeSecretEqual(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  const needsJson = req.originalUrl.startsWith('/api/');
  if (!db) return needsJson
    ? res.status(503).json({ error: 'Admin tools need a connected MongoDB database.' })
    : res.status(503).send('Admin tools need a connected MongoDB database. Check MONGODB_URI and restart the app.');
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD || process.env.ADMIN_USER.startsWith('replace_') || process.env.ADMIN_PASSWORD.length < 16) return needsJson
    ? res.status(503).json({ error: 'Set ADMIN_USER and an ADMIN_PASSWORD of at least 16 characters, then restart the app.' })
    : res.status(503).send('Admin sign-in is not configured. Set ADMIN_USER and an ADMIN_PASSWORD of at least 16 characters, then restart the app.');
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Netrue Admin", charset="UTF-8"');
    return res.status(401).send('Administrator sign-in required.');
  }
  let credentials = '';
  try { credentials = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch {}
  const separator = credentials.indexOf(':');
  const user = separator >= 0 ? credentials.slice(0, separator) : '';
  const password = separator >= 0 ? credentials.slice(separator + 1) : '';
  if (!safeSecretEqual(user, process.env.ADMIN_USER) || !safeSecretEqual(password, process.env.ADMIN_PASSWORD)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Netrue Admin", charset="UTF-8"');
    return res.status(401).send('Administrator sign-in required.');
  }
  res.setHeader('Cache-Control', 'no-store');
  next();
}

const adminDirectory = path.join(__dirname, 'admin');
app.get('/admin', adminLimiter, requireAdmin, (_req, res) => res.sendFile(path.join(adminDirectory, 'index.html')));
app.use('/admin/assets', adminLimiter, requireAdmin, express.static(adminDirectory, { index: false, maxAge: '5m' }));
app.use('/api/admin', adminLimiter, requireAdmin);

app.get('/api/admin/services', async (_req, res, next) => {
  try { res.json(await db.collection('services').find({ $or: [{ catalogVisible: { $exists: false } }, { catalogVisible: true }] }, { projection: { _id: 0, id: 1, name: 1, description: 1, currency: 1, catalogVisible: 1 } }).sort({ name: 1 }).toArray()); }
  catch (error) { next(error); }
});

app.get('/api/admin/service-catalog', async (_req, res, next) => {
  try { res.json(await db.collection('services').find({}, { projection: { _id: 0, id: 1, name: 1, description: 1, catalogVisible: 1 } }).sort({ name: 1 }).toArray()); }
  catch (error) { next(error); }
});

app.post('/api/admin/services', async (req, res, next) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    const id = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
    if (name.length < 2 || name.length > 100 || !id) return res.status(400).json({ error: 'Enter a service name between 2 and 100 characters.' });
    if (description.length > 500) return res.status(400).json({ error: 'Description must be 500 characters or fewer.' });
    const service = { id, name, description, amountMinor: null, currency: null, active: true, catalogVisible: true, createdAt: new Date() };
    try { await db.collection('services').insertOne(service); } catch (error) { if (error.code === 11000) return res.status(409).json({ error: 'A service with that name already exists.' }); throw error; }
    res.status(201).json({ id, name, description });
  } catch (error) { next(error); }
});

app.patch('/api/admin/services/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[a-z0-9-]{2,80}$/.test(id)) return res.status(400).json({ error: 'Invalid service.' });
    if (typeof req.body?.catalogVisible === 'boolean') {
      const result = await db.collection('services').updateOne({ id }, { $set: { catalogVisible: req.body.catalogVisible, updatedAt: new Date() } });
      if (!result.matchedCount) return res.status(404).json({ error: 'Service not found.' });
      return res.json({ updated: true, catalogVisible: req.body.catalogVisible });
    }
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    if (name.length < 2 || name.length > 100) return res.status(400).json({ error: 'Enter a service name between 2 and 100 characters.' });
    if (description.length > 500) return res.status(400).json({ error: 'Description must be 500 characters or fewer.' });
    const result = await db.collection('services').findOneAndUpdate({ id }, { $set: { name, description, updatedAt: new Date() } }, { returnDocument: 'after', projection: { _id: 0, id: 1, name: 1, description: 1 } });
    if (!result) return res.status(404).json({ error: 'Service not found.' });
    res.json(result);
  } catch (error) { next(error); }
});

app.delete('/api/admin/services/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[a-z0-9-]{2,80}$/.test(id)) return res.status(400).json({ error: 'Invalid service.' });
    const activeQuote = await db.collection('payment_quotes').findOne({ serviceId: id, status: 'open', expiresAt: { $gt: new Date() } }, { projection: { _id: 1 } });
    if (activeQuote) return res.status(409).json({ error: 'This service has an open payment quote. Wait for it to expire or close the quote before removing the service.' });
    const result = await db.collection('services').updateOne({ id }, { $set: { catalogVisible: false, updatedAt: new Date() } });
    if (!result.matchedCount) return res.status(404).json({ error: 'Service not found.' });
    res.json({ removed: true });
  } catch (error) { next(error); }
});

app.get('/api/admin/payment-settings', async (_req, res, next) => {
  try { const settings = await db.collection('site_settings').findOne({ _id: 'payments' }); res.json({ bankAccountName: settings?.bankAccountName || '', bankAccountDetails: settings?.bankAccountDetails || '' }); }
  catch (error) { next(error); }
});

app.put('/api/admin/payment-settings', async (req, res, next) => {
  try {
    const bankAccountName = typeof req.body?.bankAccountName === 'string' ? req.body.bankAccountName.trim().slice(0, 120) : '';
    const bankAccountDetails = typeof req.body?.bankAccountDetails === 'string' ? req.body.bankAccountDetails.trim().slice(0, 1200) : '';
    if (Boolean(bankAccountName) !== Boolean(bankAccountDetails)) return res.status(400).json({ error: 'Enter both account name and account details, or clear both to disable bank transfer.' });
    await db.collection('site_settings').updateOne({ _id: 'payments' }, { $set: { bankAccountName, bankAccountDetails, updatedAt: new Date() } }, { upsert: true });
    res.json({ saved: true, bankTransferEnabled: Boolean(bankAccountName && bankAccountDetails) });
  } catch (error) { next(error); }
});

app.get('/api/admin/payments/pending', async (_req, res, next) => {
  try { res.json(await db.collection('payments').find({ method: 'bank_transfer', status: 'awaiting_approval' }, { projection: { _id: 0, reference: 1, serviceName: 1, serviceNames: 1, amountMinor: 1, currency: 1, customerName: 1, customerEmail: 1, customerMarkedPaidAt: 1 } }).sort({ customerMarkedPaidAt: 1 }).limit(100).toArray()); }
  catch (error) { next(error); }
});

app.patch('/api/admin/payments/:reference/review', async (req, res, next) => {
  try {
    const action = req.body?.action;
    if (!['approve', 'deny'].includes(action)) return res.status(400).json({ error: 'Choose approve or deny.' });
    const reference = req.params.reference;
    const payment = await db.collection('payments').findOne({ reference, method: 'bank_transfer', status: 'awaiting_approval' });
    if (!payment) return res.status(404).json({ error: 'This transfer is no longer awaiting approval.' });
    const now = new Date();
    const set = action === 'approve' ? { status: 'paid', paidAt: now, verifiedAt: now, receiptNumber: `NTR-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${reference.slice(-8).toUpperCase()}`, reviewedBy: req.authUser || 'admin' } : { status: 'denied', deniedAt: now, reviewedBy: req.authUser || 'admin' };
    const result = await db.collection('payments').updateOne({ reference, status: 'awaiting_approval' }, { $set: set });
    if (!result.modifiedCount) return res.status(409).json({ error: 'This transfer was already reviewed.' });
    res.json({ status: set.status });
  } catch (error) { next(error); }
});

app.get('/api/admin/push/vapid-public-key', (_req, res) => res.json({ configured: vapidConfigured, publicKey: vapidConfigured ? process.env.VAPID_PUBLIC_KEY : null }));

app.get('/api/admin/push/status', async (_req, res, next) => {
  try {
    const subscriptions = await db.collection('push_subscriptions').countDocuments();
    const fingerprint = vapidConfigured ? crypto.createHash('sha256').update(process.env.VAPID_PUBLIC_KEY).digest('hex').slice(0, 10) : null;
    res.json({ configured: vapidConfigured, subscriptions, fingerprint });
  } catch (error) { next(error); }
});

app.post('/api/admin/push/subscriptions', async (req, res, next) => {
  try {
    const subscription = req.body || {};
    if (typeof subscription.endpoint !== 'string' || !subscription.endpoint.startsWith('https://') || typeof subscription.keys?.p256dh !== 'string' || typeof subscription.keys?.auth !== 'string') return res.status(400).json({ error: 'A valid browser push subscription is required.' });
    const now = new Date();
    await db.collection('push_subscriptions').updateOne({ endpoint: subscription.endpoint }, {
      $set: { endpoint: subscription.endpoint, expirationTime: subscription.expirationTime || null, keys: subscription.keys, updatedAt: now },
      $setOnInsert: { createdAt: now }
    }, { upsert: true });
    res.status(201).json({ subscribed: true });
  } catch (error) { next(error); }
});

app.delete('/api/admin/push/subscriptions', async (req, res, next) => {
  try {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    if (!endpoint.startsWith('https://')) return res.status(400).json({ error: 'A valid subscription endpoint is required.' });
    await db.collection('push_subscriptions').deleteOne({ endpoint });
    res.json({ unsubscribed: true });
  } catch (error) { next(error); }
});

app.get('/api/admin/visitors', async (_req, res, next) => {
  try {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 2 * 60 * 1000);
    await db.collection('visitor_sessions').updateMany({ status: 'online', lastActiveAt: { $lte: cutoff } }, { $set: { status: 'offline', endedAt: now } });
    const sessions = await db.collection('visitor_sessions').find({ expiresAt: { $gt: now } }, {
      projection: { _id: 0, visitorLabel: 1, visitorType: 1, countryCode: 1, currentPage: 1, pageHistory: 1, status: 1, startedAt: 1, lastActiveAt: 1, totalDurationSeconds: 1 }
    }).sort({ lastActiveAt: -1 }).limit(100).toArray();
    res.json({ online: sessions.filter(session => session.status === 'online').length, sessions });
  } catch (error) { next(error); }
});

app.get('/api/admin/projects', async (_req, res, next) => {
  try { res.json(await db.collection('projects').find({}, { projection: { _id: 0 } }).sort({ updatedAt: -1 }).toArray()); }
  catch (error) { next(error); }
});

function validateProject(body = {}) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
  if (title.length < 2 || title.length > 120) return { error: 'Project title must be 2 to 120 characters.' };
  if (description.length < 5 || description.length > 1200) return { error: 'Description must be 5 to 1,200 characters.' };
  let parsed;
  try { parsed = new URL(imageUrl); } catch { return { error: 'Enter a valid HTTPS image link.' }; }
  if (parsed.protocol !== 'https:' || imageUrl.length > 1500) return { error: 'Enter a valid HTTPS image link.' };
  return { project: { title, description, imageUrl } };
}

app.post('/api/admin/projects', async (req, res, next) => {
  try {
    const checked = validateProject(req.body);
    if (checked.error) return res.status(400).json({ error: checked.error });
    const now = new Date();
    const project = { id: crypto.randomUUID(), ...checked.project, active: true, createdAt: now, updatedAt: now };
    await db.collection('projects').insertOne(project);
    res.status(201).json(project);
  } catch (error) { next(error); }
});

app.patch('/api/admin/projects/:id', async (req, res, next) => {
  try {
    const checked = validateProject(req.body);
    if (checked.error) return res.status(400).json({ error: checked.error });
    const result = await db.collection('projects').findOneAndUpdate({ id: req.params.id }, { $set: { ...checked.project, updatedAt: new Date() } }, { returnDocument: 'after', projection: { _id: 0 } });
    if (!result) return res.status(404).json({ error: 'Project not found.' });
    res.json(result);
  } catch (error) { next(error); }
});

app.delete('/api/admin/projects/:id', async (req, res, next) => {
  try {
    const result = await db.collection('projects').deleteOne({ id: req.params.id });
    if (!result.deletedCount) return res.status(404).json({ error: 'Project not found.' });
    res.json({ deleted: true });
  } catch (error) { next(error); }
});

app.post('/api/admin/payment-quotes', async (req, res, next) => {
  try {
    const { serviceId, email, name, agreedPrice, currency } = req.body || {};
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (cleanEmail && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 254)) return res.status(400).json({ error: 'Enter a valid customer email.' });
    if (typeof serviceId !== 'string' || !/^[a-z0-9-]{2,80}$/.test(serviceId)) return res.status(400).json({ error: 'Choose a service.' });
    const service = await db.collection('services').findOne({ id: serviceId });
    const allowedCurrencies = ['USD', 'GBP', 'NGN', 'BRL'];
    const quoteCurrency = typeof currency === 'string' ? currency.trim().toUpperCase() : 'USD';
    if (!service || !allowedCurrencies.includes(quoteCurrency)) return res.status(400).json({ error: 'Choose USD, GBP, NGN or BRL and a valid service.' });
    const amountMinor = amountToMinor(String(agreedPrice || ''), quoteCurrency);
    if (!amountMinor) return res.status(400).json({ error: 'Enter a valid agreed price.' });
    const customerName = typeof name === 'string' ? name.trim().slice(0, 120) : '';
    const reference = `NTRQ-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    const now = new Date();
    await db.collection('payment_quotes').insertOne({ reference, serviceId: service.id, serviceName: service.name, amountMinor, agreedPrice: String(agreedPrice).trim(), currency: quoteCurrency, customerName, customerEmail: cleanEmail, status: 'open', createdAt: now, expiresAt: new Date(now.getTime() + 14 * 86400000), createdBy: req.authUser || 'admin' });
    res.status(201).json({ reference, serviceName: service.name, amount: formatCurrencyMinor(amountMinor, quoteCurrency), currency: quoteCurrency, customerName, customerEmail: cleanEmail, expiresAt: new Date(now.getTime() + 14 * 86400000).toISOString(), paymentUrl: `${process.env.PUBLIC_URL || ''}/payment.html?quote=${encodeURIComponent(reference)}` });
  } catch (error) { next(error); }
});

app.get('/api/admin/quick-chats', async (req, res, next) => {
  try {
    const filter = req.query.status && ['new', 'in_progress', 'resolved'].includes(req.query.status) ? { status: req.query.status } : {};
    const chats = await db.collection('quick_chats').find(filter, { projection: { _id: 0 } }).sort({ updatedAt: -1 }).limit(100).toArray();
    res.json(chats);
  } catch (error) { next(error); }
});

app.patch('/api/admin/quick-chats/:reference', async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!['new', 'in_progress', 'resolved'].includes(status)) return res.status(400).json({ error: 'Choose a valid status.' });
    const result = await db.collection('quick_chats').updateOne({ reference: req.params.reference }, { $set: { status, updatedAt: new Date() } });
    if (!result.matchedCount) return res.status(404).json({ error: 'Quick chat not found.' });
    res.json({ updated: true });
  } catch (error) { next(error); }
});

app.post('/api/admin/quick-chats/:reference/messages', async (req, res, next) => {
  try {
    const { text } = req.body || {};
    if (typeof text !== 'string' || text.trim().length < 2 || text.length > 1200) return res.status(400).json({ error: 'Reply must be between 2 and 1,200 characters.' });
    const now = new Date();
    const result = await db.collection('quick_chats').updateOne({ reference: req.params.reference }, {
      $push: { messages: { sender: 'admin', text: text.trim(), sentAt: now } },
      $set: { status: 'in_progress', updatedAt: now }
    });
    if (!result.matchedCount) return res.status(404).json({ error: 'Quick chat not found.' });
    res.json({ replied: true });
  } catch (error) { next(error); }
});

app.use(express.static(publicDir, { index: 'index.html', maxAge: '1h' }));
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API endpoint not found.' });
  res.status(404).sendFile(path.join(publicDir, '404.html'), error => { if (error && !res.headersSent) res.status(404).send('Page not found.'); });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (res.headersSent) return;
  const status = error.statusCode || 500;
  res.status(status).json({ error: status < 500 ? error.message : 'Something went wrong. Please try again or contact Netrue.' });
});

async function start() {
  if (placeholderMongoUri) {
    if (process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV === 'production') {
      throw new Error('A valid MONGODB_URI is required in production. Add it in Railway Variables.');
    }
    previewMode = true;
    app.listen(port, '0.0.0.0', () => console.log(`Netrue preview listening on ${port}; MongoDB features are disabled until MONGODB_URI is configured.`));
    return;
  }
  await client.connect();
  db = client.db();
  await db.collection('payments').createIndex({ reference: 1 }, { unique: true });
  await db.collection('payments').createIndex({ status: 1, createdAt: -1 });
  await db.collection('enquiries').createIndex({ reference: 1 }, { unique: true });
  await db.collection('enquiries').createIndex({ status: 1, createdAt: -1 });
  await db.collection('quick_chats').createIndex({ reference: 1 }, { unique: true });
  await db.collection('quick_chats').createIndex({ status: 1, updatedAt: -1 });
  await db.collection('services').createIndex({ id: 1 }, { unique: true });
  await db.collection('payment_quotes').createIndex({ reference: 1 }, { unique: true });
  await db.collection('payment_quotes').createIndex({ customerEmail: 1, status: 1, expiresAt: 1 });
  await db.collection('projects').createIndex({ id: 1 }, { unique: true });
  await db.collection('projects').createIndex({ active: 1, createdAt: -1 });
  await db.collection('visitor_sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('visitor_sessions').createIndex({ status: 1, lastActiveAt: -1 });
  await db.collection('visitors').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('push_subscriptions').createIndex({ endpoint: 1 }, { unique: true });
  await seedServiceCatalog();
  app.listen(port, '0.0.0.0', () => console.log(`Netrue listening on ${port}`));
}

start().catch(error => { console.error(error); process.exit(1); });
