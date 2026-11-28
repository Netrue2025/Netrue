# Netrue website

This repository contains the Netrue landing page, an inline guided quotation chat, a separate quick-chat modal with a protected admin inbox, MongoDB enquiry storage, and a Railway-ready Node.js checkout service. Railway serves the frontend and API from one app. Public files are isolated in `public/`; admin files, secrets, and the service seed file stay outside the web root.

## Railway setup

1. Create a Railway project from this repository. The start command is `npm start` and Railway will install the dependencies from `package.json`.
2. Add a MongoDB database (Railway MongoDB or MongoDB Atlas) and copy its connection string into the `MONGODB_URI` variable. The MongoDB user needs read/write access to the selected database. For Atlas, allow the Railway app to connect through your chosen network-access policy.
3. Set `PAYSTACK_SECRET_KEY` to the appropriate Paystack test key while testing, then switch to the live secret key for production. Keep this value in Railway Variables; it is only read by the server.
4. Set `RECEIPT_COOKIE_SECRET` to a unique random secret with at least 32 characters. Set `PUBLIC_URL` to the full public HTTPS Railway domain, for example `https://your-app.up.railway.app`.
5. Deploy. The app creates MongoDB indexes and inserts missing service catalog entries from `services.json` without overwriting prices already configured in MongoDB.

Production requires `MONGODB_URI`; local development can run in preview mode without it. Paystack checkout requires its secret key; Netrue Pay requires MongoDB, `RECEIPT_COOKIE_SECRET`, and account details saved in `/admin`. Never commit `.env` or place Paystack secret keys in frontend files.

## Manage checkout services and bank transfer

- Open `/admin` and choose **Services** to add services. They appear under **Other services** on checkout. The six established services appear as popular options.
- Choose **Payments** to configure the account name and transfer instructions for Netrue Pay. Enter details on separate lines; bank transfer appears on checkout only after both fields are saved.
- Transfer requests appear under **Transfer approvals** after a customer selects **I have paid**. Confirm the money reached the account before approving. Approval marks the payment paid and enables the receipt; denial leaves it unpaid.
- The checkout lets customers select multiple services, enter the agreed total and choose Netrue Pay or Paystack. Paystack and MongoDB must be configured in Railway for checkout to work.

## Payment and receipt flow

- The checkout supports multiple services and an agreed total in USD, GBP, NGN or BRL.
- Netrue Pay displays the account details configured in admin. After the customer reports the transfer, the payment page waits while an admin approves or denies the request. Only approval issues a receipt.
- Paystack redirects back to the checkout, where the server verifies the transaction before marking it paid.
- A signed, HttpOnly browser cookie keeps a payment session or receipt available for 48 hours. The receipt downloads as a branded PDF.
The chat form validates and stores consented enquiries in the MongoDB `enquiries` collection. Rate limiting is enabled. The visitor can then open WhatsApp or an email draft with their enquiry reference. Email delivery/notifications are not configured, so Netrue should review new enquiry records in MongoDB until an email provider or CRM is connected.

The lightweight quick-chat modal stores conversations in `quick_chats`. The protected admin workspace is at `/admin`. It manages quick chat threads, creates quotes in USD by default (with GBP, NGN and BRL options), and can add, edit or remove public project cards using a title, description and HTTPS image link. Set `ADMIN_USER` and a unique `ADMIN_PASSWORD` of at least 16 characters in Railway Variables to enable it. Admin replies are stored in the thread and the inbox offers an email draft to send to the visitor. Configure an email provider later if you want replies sent directly from the app.

## Admin PWA, visitor activity, and push alerts

- `/admin` is installable as a mobile-first PWA in supported browsers. Sign in over HTTPS, then use **Install admin app** if your browser offers installation.
- The public website asks the visitor before setting the first-party activity cookie. If accepted, the admin's **Live visitors** view shows an anonymous session label, approximate country, current page, page time, session time, and last activity. The app uses trusted CDN country headers when provided, otherwise it looks up the client IP locally with MaxMind GeoLite2. On Railway it prefers the `X-Real-IP` client address so an edge proxy address is not mistaken for the visitor. Only the country code is stored; the raw IP is not written to MongoDB. Names, email addresses, and page query parameters are not used for visitor analytics. Country estimates can still be wrong due to VPNs or carrier routing. Visitors are marked offline after two minutes without activity. Session and cookie identifiers expire after 30 and 180 days respectively. GeoLite2 data is created by MaxMind (https://www.maxmind.com/).
- Push alerts cover new/returning visits, quick chat messages, enquiries, and verified payments. Push delivery requires VAPID keys and an admin must enable notifications on each device/browser. Generate keys locally with `npx web-push generate-vapid-keys`, then add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT=mailto:info@netrue.io` to Railway Variables and redeploy. Keep the private key secret. Open `/admin` over the Railway HTTPS domain, select **Enable push alerts**, then use **Send test notification**. The admin shows server readiness and registered device count. If a test reports VAPID rejection, confirm the public/private key pair matches and disable/re-enable alerts on the device after changing keys. Browser notification permission is device-specific.

## Google reviews

The supplied Google share link can be shown as a link from the landing page, but it does not provide a reliable public feed for embedding review text. To show live reviews, the business must own and verify its Google Business Profile, enable access to the Google Business Profile APIs, and configure server-side OAuth credentials with the review-reading scope. Then the app can request reviews for the verified location and render them. Do not place OAuth credentials in browser code. The location map can be embedded separately with a Google Maps Embed API key.

## Local development

Run `npm install` followed by `npm start`. Without a valid MongoDB URI (including while `.env` still contains the sample `CLUSTER.mongodb.net` value), the app starts in local preview mode so you can view the pages at `http://localhost:3000`; chat storage, the admin inbox, payment, and receipts stay disabled. To try those features, copy `.env.example` to `.env`, enter a real MongoDB URI and Paystack test key, set a unique admin username and a password of at least 16 characters, configure `RECEIPT_COOKIE_SECRET`, then restart the app. Create a quote from `/admin` before trying checkout.

## Launch decisions still needed

- Confirm service names, prices, currencies, and whether each can be purchased online.
- Add live Paystack credentials and a production `PUBLIC_URL` in Railway Variables.
- Confirm public social profile links and the approved project concepts before publication.
- Add approved privacy and terms pages before collecting customer data at production scale.
