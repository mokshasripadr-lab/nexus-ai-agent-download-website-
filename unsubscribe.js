// One-click unsubscribe — Vercel serverless function.
// The link in each email carries the email + a signed token, so it works
// without login and can't be forged. Sets active=false.
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createHmac, timingSafeEqual } from "crypto";

function db() {
  if (!getApps().length) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
    if (svc.private_key) svc.private_key = svc.private_key.replace(/\\n/g, "\n");
    initializeApp({ credential: cert(svc) });
  }
  return getFirestore();
}

function tokenValid(email, token) {
  const expected = createHmac("sha256", process.env.CRON_SECRET || "").update(email.toLowerCase()).digest("hex");
  if (!token || expected.length !== token.length) return false;
  try { return timingSafeEqual(Buffer.from(expected), Buffer.from(token)); } catch { return false; }
}

function page(res, title, msg) {
  res.setHeader("Content-Type", "text/html");
  res.status(200).send(`<!doctype html><html><body style="margin:0;background:#f5f1ea;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
    <div style="max-width:460px;margin:80px auto;padding:32px;background:#fff;border:1px solid #e7e0d5;border-radius:16px;text-align:center">
      <div style="font-size:22px;font-weight:700;color:#1c1b19">✦ ${title}</div>
      <p style="color:#6b655c;font-size:15px;margin:14px 0 0">${msg}</p>
    </div></body></html>`);
}

export default async function handler(req, res) {
  const email = String((req.query && req.query.e) || "").trim().toLowerCase();
  const token = String((req.query && req.query.t) || "");
  if (!email || !tokenValid(email, token)) return page(res, "Invalid link", "This unsubscribe link is invalid or expired.");
  try {
    const snap = await db().collection("subscribers").where("email", "==", email).get();
    await Promise.all(snap.docs.map((d) => d.ref.update({ active: false })));
    return page(res, "You're unsubscribed", `${email} will no longer receive the daily update. Sign in again anytime to re-subscribe.`);
  } catch {
    return page(res, "Something went wrong", "We couldn't process that just now — please try again later.");
  }
}
