# Netrue website

This repository contains the Netrue landing page, an inline guided quotation chat, a separate quick-chat modal with a protected admin inbox, MongoDB enquiry storage, and a Railway-ready Node.js checkout service. Railway serves the frontend and API from one app. Public files are isolated in `public/`; admin files, secrets, and the service seed file stay outside the web root.

## Railway setup

1. Create a Railway project from this repository. The start command is `npm start` and Railway will install the dependencies from `package.json`.
2. Add a MongoDB database (Railway MongoDB or MongoDB Atlas) and copy its connection string into the `MONGODB_URI` variable. The MongoDB user needs read/write access to the selected database. For Atlas, allow the Railway app to connect through your chosen network-access policy.
3. Set `PAYSTACK_SECRET_KEY` to the appropriate Paystack test key while testing, then switch to the live secret key for production. Keep this value in Railway Variables; it is only read by the server.
4. Set `RECEIPT_COOKIE_SECRET` to a unique random secret with at least 32 characters. Set `PUBLIC_URL` to the full public HTTPS Railway domain, for example `https://your-app.up.railway.app`.
5. Deploy. The app creates MongoDB indexes and inserts missing service catalog entries from `services.json` without overwriting prices already configured in MongoDB.

Production requires `MONGODB_URI`; local development can run in preview mode without it. Without a Paystack secret key, checkout stays unavailable and the rest of the site remains usable. Never commit `.env` or place Paystack secret keys in frontend files.

## Configure payable services

Service prices were not included in the brief, so every seeded service is disabled and has no amount. No payment can start until Netrue confirms its service prices and currency. Configure each service in MongoDB `services` with:

```json
{
  "id": "ai-systems",
  "name": "AI systems and workflows",
  "description": "Applied AI features, intelligent workflows, and data-assisted tools.",
  "amountMinor": null,
  "currency": null,
  "active": false
}
```

Replace `amountMinor` with the approved amount in the currency's smallest unit, choose the Paystack-supported currency agreed for that service, and set `active` to `true`. Repeat for approved services. For example, in `mongosh`, after setting the actual approved amount and currency:

```js
db.services.updateOne(
  { id: "ai-systems" },
  { $set: { amountMinor: APPROVED_AMOUNT_IN_MINOR_UNITS, currency: "APPROVED_CURRENCY_CODE", active: true } }
)
```

Do not leave the placeholder text in a database command. You can also edit `services.json` before deployment; it seeds any missing entries. The catalog is intentionally not editable from the public website.

## Payment and receipt flow

- Create a payment quote from `/admin` with the customer email, service, currency, and agreed price. The quote is valid for 14 days and can be sent using the generated email draft.
- The customer opens the payment link, confirms the matching email, selects the quoted service, and enters the agreed amount. The server checks the quote and price before initializing Paystack; the browser cannot set an arbitrary charge.
- After return from Paystack, the server verifies the transaction amount and currency against the saved MongoDB record. Only a verified transaction is marked paid.
- A PDF receipt is generated from the verified record. The browser receives a signed, HttpOnly cookie that permits repeat downloads in that same browser for 30 days. The payment page also provides a saved-receipt link.
- A quote is reserved when checkout starts to prevent duplicate use. If Paystack initialization fails, the quote is reopened. A quote whose checkout was started but abandoned needs a fresh quote from the admin.
The chat form validates and stores consented enquiries in the MongoDB `enquiries` collection. Rate limiting is enabled. The visitor can then open WhatsApp or an email draft with their enquiry reference. Email delivery/notifications are not configured, so Netrue should review new enquiry records in MongoDB until an email provider or CRM is connected.

The lightweight quick-chat modal stores conversations in `quick_chats`. The protected admin workspace is at `/admin`. It manages quick chat threads, creates quotes in USD by default (with GBP, NGN and BRL options), and can add, edit or remove public project cards using a title, description and HTTPS image link. Set `ADMIN_USER` and a unique `ADMIN_PASSWORD` of at least 16 characters in Railway Variables to enable it. Admin replies are stored in the thread and the inbox offers an email draft to send to the visitor. Configure an email provider later if you want replies sent directly from the app.

## Local development

Run `npm install` followed by `npm start`. Without a valid MongoDB URI (including while `.env` still contains the sample `CLUSTER.mongodb.net` value), the app starts in local preview mode so you can view the pages at `http://localhost:3000`; chat storage, the admin inbox, payment, and receipts stay disabled. To try those features, copy `.env.example` to `.env`, enter a real MongoDB URI and Paystack test key, set a unique admin username and a password of at least 16 characters, configure `RECEIPT_COOKIE_SECRET`, then restart the app. Create a quote from `/admin` before trying checkout.

## Launch decisions still needed

- Confirm service names, prices, currencies, and whether each can be purchased online.
- Add live Paystack credentials and a production `PUBLIC_URL` in Railway Variables.
- Confirm public social profile links and the approved project concepts before publication.
- Add approved privacy and terms pages before collecting customer data at production scale.
