const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { MongoClient } = require('mongodb');
const PDFDocument = require('pdfkit');

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
      frameAncestors: ["'none'"], objectSrc: ["'none'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
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
const adminLimiter = rateLimit({ windowMs: 60 * 1000, limit: 90, standardHeaders: 'draft-7', legacyHeaders: false });

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
    await collection.updateOne({ id: service.id }, { $setOnInsert: service }, { upsert: true });
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

app.get('/api/services', async (_req, res, next) => {
  try {
    const services = db
      ? await db.collection('services').find({}, { projection: { _id: 0 } }).sort({ name: 1 }).toArray()
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
    if (payment.status === 'review') return res.status(409).json({ error: 'The payment needs manual review. Please contact Netrue.' });
    if (!['pending', 'paid'].includes(payment.status)) return res.status(409).json({ error: 'This payment session could not be started. Please return to the payment page.' });
    if (payment.status !== 'paid') {
      if (!process.env.PAYSTACK_SECRET_KEY) return res.status(503).json({ error: 'Payment verification is not configured.' });
      const transaction = await paystackRequest(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`);
      const correctAmount = transaction.reference === reference && transaction.amount === payment.amountMinor && transaction.currency === payment.currency;
      if (transaction.status !== 'success' || !correctAmount) {
        if (transaction.status === 'success' && !correctAmount) {
          await db.collection('payments').updateOne({ reference, status: 'pending' }, { $set: { status: 'review', verificationIssue: 'amount_or_currency_mismatch', verifiedAt: new Date() } });
          return res.status(409).json({ error: 'The payment needs manual review. Please contact Netrue with your payment reference.' });
        }
        return res.status(402).json({ error: 'Payment has not been completed.' });
      }
      await db.collection('payments').updateOne({ reference, status: 'pending' }, {
        $set: { status: 'paid', paidAt: transaction.paid_at ? new Date(transaction.paid_at) : new Date(), verifiedAt: new Date(), receiptNumber: `NTR-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${reference.slice(-8).toUpperCase()}` }
      });
      if (payment.quoteReference) await db.collection('payment_quotes').updateOne({ reference: payment.quoteReference, checkoutReference: reference }, { $set: { status: 'paid', paidAt: new Date() } });
    }
    const confirmed = await db.collection('payments').findOne({ reference, status: 'paid' });
    if (!confirmed) return res.status(409).json({ error: 'Payment confirmation is being processed. Refresh in a moment.' });
    res.cookie('netrue_receipt', receiptCookieValue(reference), { httpOnly: true, secure: process.env.NODE_ENV === 'production' || Boolean(req.secure), sameSite: 'lax', path: '/api/receipt', maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({ status: 'paid', reference, receiptNumber: confirmed.receiptNumber, receiptUrl: '/api/receipt/download' });
  } catch (error) { next(error); }
});

function streamReceipt(res, payment) {
    const filename = `Netrue-receipt-${payment.receiptNumber}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const pdf = new PDFDocument({ size: 'A4', margin: 54, info: { Title: `Netrue receipt ${payment.receiptNumber}`, Author: 'Netrue' } });
    pdf.pipe(res);
    pdf.rect(0, 0, 595, 176).fill('#173b2c');
    pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text('netrue.', 54, 52);
    pdf.fillColor('#d8e8da').font('Helvetica').fontSize(10).text('PAYMENT RECEIPT', 54, 94, { characterSpacing: 1.7 });
    pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(17).text(payment.receiptNumber, 54, 119);
    pdf.fillColor('#252b28').font('Helvetica-Bold').fontSize(12).text('Payment details', 54, 207);
    pdf.moveTo(54, 229).lineTo(541, 229).strokeColor('#dce2dd').stroke();
    const details = [
      ['Service', payment.serviceName], ['Customer', payment.customerName], ['Email', payment.customerEmail],
      ['Amount paid', formatCurrencyMinor(payment.amountMinor, payment.currency)],
      ['Payment reference', payment.reference], ['Paid on', new Date(payment.paidAt).toLocaleString('en', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC'],
      ['Status', 'PAID']
    ];
    let y = 252;
    for (const [label, value] of details) {
      pdf.fillColor('#6b756f').font('Helvetica').fontSize(9).text(label.toUpperCase(), 54, y, { width: 135 });
      pdf.fillColor('#252b28').font(label === 'Status' ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).text(String(value), 196, y, { width: 340 });
      y += 37;
    }
    pdf.moveTo(54, y + 4).lineTo(541, y + 4).strokeColor('#dce2dd').stroke();
    pdf.fillColor('#6b756f').font('Helvetica').fontSize(9).text('Thank you for choosing Netrue. For receipt support, contact info@netrue.io.', 54, y + 24, { width: 470 });
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
  try { res.json(await db.collection('services').find({}, { projection: { _id: 0, id: 1, name: 1, currency: 1 } }).sort({ name: 1 }).toArray()); }
  catch (error) { next(error); }
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
  await seedServiceCatalog();
  app.listen(port, '0.0.0.0', () => console.log(`Netrue listening on ${port}`));
}

start().catch(error => { console.error(error); process.exit(1); });
