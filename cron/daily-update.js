// Daily update email — Vercel serverless function.
// Triggered daily by Vercel Cron (see vercel.json). It reads today's commits
// from the public GitHub repo, reads the subscriber list from Firestore, and
// emails everyone via Resend with a personal one-click unsubscribe link.
//
// Env vars: CRON_SECRET, FIREBASE_SERVICE_ACCOUNT, RESEND_API_KEY,
// optional APP_URL, EMAIL_FROM, GITHUB_TOKEN.
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createHmac } from "crypto";

const REPO = "mokshasripadr-lab/nexus-ai-agent-CLI-mode-";
const FROM = process.env.EMAIL_FROM || "Nexus AI <onboarding@resend.dev>";
const APP_URL = process.env.APP_URL || "";
const ROADMAP = [
  { name: "Nexus Web", note: "the full agent in your browser — no install needed." },
  { name: "Nexus IDE", note: "an agent-native editor that reads, writes, and runs your code." },
  { name: "Beta program", note: "early access to new engines, faster models, and pro features." },
];

function db() {
  if (!getApps().length) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
    if (svc.private_key) svc.private_key = svc.private_key.replace(/\\n/g, "\n");
    initializeApp({ credential: cert(svc) });
  }
  return getFirestore();
}

function unsubToken(email) {
  return createHmac("sha256", process.env.CRON_SECRET || "").update(email.toLowerCase()).digest("hex");
}
function unsubUrl(email) {
  const q = new URLSearchParams({ e: email, t: unsubToken(email) });
  return `${APP_URL.replace(/\/$/, "")}/api/unsubscribe?${q.toString()}`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function todaysCommits() {
  const since = new Date(Date.now() - 864e5).toISOString();
  const headers = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/commits?since=${since}&per_page=50`, { headers });
    if (!r.ok) return [];
    const data = await r.json();
    const seen = new Set(), out = [];
    for (const c of data) {
      const m = (c.commit?.message || "").split("\n")[0].trim();
      if (!m || m.startsWith("Merge") || seen.has(m)) continue;
      seen.add(m); out.push(m);
    }
    return out;
  } catch { return []; }
}

function buildHtml(commits, dateStr, unsub) {
  const did = commits.length
    ? `<ul style="margin:0;padding-left:18px;color:#3a3733">${commits.map((c) => `<li style="margin:6px 0">${esc(c)}</li>`).join("")}</ul>`
    : `<p style="color:#6b655c;margin:0">We spent today polishing things behind the scenes — steady progress.</p>`;
  const coming = ROADMAP.map((r) => `<li style="margin:6px 0"><strong style="color:#c15f3c">${r.name}</strong> — <span style="color:#3a3733">${r.note}</span></li>`).join("");
  return `<!doctype html><html><body style="margin:0;background:#f5f1ea;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:28px 20px">
    <div style="background:#fff;border:1px solid #e7e0d5;border-radius:16px;overflow:hidden">
      <div style="background:#1c1b19;padding:22px 24px;color:#f3efe7">
        <div style="font-size:18px;font-weight:700">✦ Nexus AI — Daily Update</div>
        <div style="font-size:13px;color:#b8b0a2;margin-top:2px">${dateStr}</div>
      </div>
      <div style="padding:24px">
        <h2 style="font-size:16px;margin:0 0 10px;color:#1c1b19">What we did today</h2>${did}
        <h2 style="font-size:16px;margin:22px 0 10px;color:#1c1b19">What's coming</h2>
        <ul style="margin:0;padding-left:18px">${coming}</ul>
        <div style="margin-top:24px;padding-top:18px;border-top:1px solid #eee7db">
          <a href="https://github.com/${REPO}" style="display:inline-block;background:#d97757;color:#1c1b19;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:10px;font-size:14px">View the repo →</a>
        </div>
      </div>
    </div>
    <p style="text-align:center;color:#9a9184;font-size:12px;margin:16px 0 0">You're getting this because you signed in to Nexus AI.${unsub ? `<br><a href="${unsub}" style="color:#9a9184;text-decoration:underline">Unsubscribe</a>` : ""}</p>
  </div></body></html>`;
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const hdr = req.headers.authorization || "";
  const qkey = (req.query && req.query.key) || "";
  if (!secret || (hdr !== `Bearer ${secret}` && qkey !== secret)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const dateStr = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const [commits, snap] = await Promise.all([
      todaysCommits(),
      db().collection("subscribers").where("active", "==", true).get(),
    ]);
    const emails = [...new Set(snap.docs.map((d) => d.data().email).filter((e) => e && e.includes("@")))];
    if (emails.length === 0) return res.status(200).json({ ok: true, sent: 0, note: "no subscribers yet" });

    const rk = process.env.RESEND_API_KEY;
    if (!rk) return res.status(500).json({ error: "RESEND_API_KEY not set" });
    let sent = 0;
    for (const email of emails) {
      const link = APP_URL ? unsubUrl(email) : "";
      const html = buildHtml(commits, dateStr, link);
      const headers = link ? { "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : {};
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${rk}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM, to: [email], subject: `Nexus AI — Daily Update (${dateStr})`, html, headers }),
      });
      if (r.ok) sent++;
    }
    return res.status(200).json({ ok: true, subscribers: emails.length, sent, commits: commits.length });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
}
