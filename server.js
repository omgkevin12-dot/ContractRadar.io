/**
 * ContractRadar Backend
 * Stack: Express · Supabase · Resend (email) · node-cron
 * 
 * Run: node server.js
 */

import express from "express";
import cors from "cors";
import cron from "node-cron";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import Anthropic from "@anthropic-ai/sdk";
import multer from "multer";
import mammoth from "mammoth";
import fs from "fs";
import path from "path";

// ─── Config ────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3001;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Separate anon client used only for verifying user JWTs
const supabaseAnon = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Middleware: verify the Bearer token and attach user to req
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  const { data: { user }, error } = await supabaseAnon.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: "Invalid or expired session. Please log in again." });
  req.userId = user.id;
  req.userEmail = user.email;
  req.userMeta = user.user_metadata || {};
  next();
}

const resend = new Resend(process.env.RESEND_API_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Accepted contract document MIME types
const ACCEPTED_MIMETYPES = new Set([
  "application/pdf",                                                              // .pdf
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",     // .docx
  "application/msword",                                                           // .doc (legacy Word)
  "application/rtf",                                                              // .rtf
  "text/rtf",                                                                     // .rtf (alt MIME)
]);

const upload = multer({
  dest: "uploads/",
  fileFilter: (_, file, cb) => {
    cb(null, ACCEPTED_MIMETYPES.has(file.mimetype));
  },
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB max
});

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

// ─── Helpers ────────────────────────────────────────────────────────────────
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date();
  const target = new Date(dateStr);
  return Math.ceil((target - today) / (1000 * 60 * 60 * 24));
}

function formatCurrency(n) {
  return "$" + Number(n || 0).toLocaleString();
}

// ─── Claude extraction ──────────────────────────────────────────────────────

const CLAUDE_SYSTEM_PROMPT = `Extract contract data and return ONLY valid JSON with no markdown, no preamble, no explanation. Return exactly this shape:
{
  "vendor_name": "string",
  "monthly_cost": number or null,
  "annual_cost": number or null,
  "renewal_date": "YYYY-MM-DD" or null,
  "contract_start_date": "YYYY-MM-DD" or null,
  "auto_renewal": true/false,
  "auto_renewal_notice_days": number or null,
  "termination_notice_days": number or null,
  "price_escalation_clause": "description string" or null,
  "sla_commitments": ["string array"],
  "red_flags": ["string describing specific risk with deadline if applicable"],
  "overpay_flag": true/false,
  "overpay_reason": "string" or null,
  "contract_type": "SaaS" | "Professional Services" | "Infrastructure" | "Hardware" | "Other",
  "payment_terms": "string" or null,
  "governing_law": "string" or null
}

For red_flags: be specific. Include auto-renewal deadlines (e.g., "Auto-renews Jan 15 — must cancel by Nov 15"), price escalation details, unusual termination clauses, SLA gaps vs stated commitments.
For overpay_flag: true if signs of overpayment exist (unused capacity, above-market pricing, duplicate services, unnecessary add-ons).`;

/**
 * Build the Claude message content array based on file MIME type.
 *  - PDF         → native document block (preserves layout, tables)
 *  - DOCX / DOC  → mammoth text extraction → plain text block
 *  - RTF         → read as UTF-8 text block
 */
async function buildMessageContent(filePath, fileName, mimeType) {
  const prompt = `Extract all contract details from this document (${fileName}) and return as JSON only.`;
  const isPDF  = mimeType === "application/pdf";
  const isWord = mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
               || mimeType === "application/msword";
  const isRTF  = mimeType === "application/rtf" || mimeType === "text/rtf";

  if (isPDF) {
    const base64Data = fs.readFileSync(filePath).toString("base64");
    return [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } },
      { type: "text", text: prompt }
    ];
  }

  let rawText;
  if (isWord) {
    const result = await mammoth.extractRawText({ path: filePath });
    rawText = result.value?.trim();
    if (!rawText) throw new Error("No readable text found in Word document.");
  } else if (isRTF) {
    rawText = fs.readFileSync(filePath, "utf-8");
  } else {
    throw new Error(`Unsupported file type: ${mimeType}`);
  }

  return [{ type: "text", text: `${prompt}\n\nDocument contents:\n\n${rawText}` }];
}

async function extractContract(filePath, fileName, mimeType) {
  const content = await buildMessageContent(filePath, fileName, mimeType);

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system: CLAUDE_SYSTEM_PROMPT,
    messages: [{ role: "user", content }]
  });

  const text = message.content.map(b => b.text || "").join("");
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// Health check
app.get("/health", (_, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

/**
 * POST /api/contracts/upload
 * Upload + analyze a PDF, Word, or RTF contract
 */
app.post("/api/contracts/upload", requireAuth, upload.single("contract"), async (req, res) => {
  const company_id = req.userId;

  if (!req.file) return res.status(400).json({ error: "No contract file uploaded. Accepted formats: PDF, DOCX, DOC, RTF." });

  try {
    // Extract with Claude (file type is inferred from MIME type)
    const extracted = await extractContract(req.file.path, req.file.originalname, req.file.mimetype);

    // Save to Supabase
    const { data, error } = await supabase
      .from("contracts")
      .insert({
        company_id,
        file_name: req.file.originalname,
        vendor_name: extracted.vendor_name,
        monthly_cost: extracted.monthly_cost,
        annual_cost: extracted.annual_cost || (extracted.monthly_cost ? extracted.monthly_cost * 12 : null),
        renewal_date: extracted.renewal_date,
        contract_start_date: extracted.contract_start_date,
        auto_renewal: extracted.auto_renewal,
        auto_renewal_notice_days: extracted.auto_renewal_notice_days,
        termination_notice_days: extracted.termination_notice_days,
        price_escalation_clause: extracted.price_escalation_clause,
        sla_commitments: extracted.sla_commitments,
        red_flags: extracted.red_flags,
        overpay_flag: extracted.overpay_flag,
        overpay_reason: extracted.overpay_reason,
        contract_type: extracted.contract_type,
        payment_terms: extracted.payment_terms,
        governing_law: extracted.governing_law,
        analyzed_at: new Date().toISOString()
      })
      .select()
      .single();

    // Clean up temp file
    fs.unlinkSync(req.file.path);

    if (error) throw error;

    res.json({ success: true, contract: data });
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    console.error("Upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/contracts?company_id=xxx
 * Get all contracts for a company
 */
app.get("/api/contracts", requireAuth, async (req, res) => {
  const company_id = req.userId;

  const { data, error } = await supabase
    .from("contracts")
    .select("*")
    .eq("company_id", company_id)
    .order("renewal_date", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ contracts: data });
});

/**
 * DELETE /api/contracts/:id
 */
app.delete("/api/contracts/:id", requireAuth, async (req, res) => {
  const { error } = await supabase
    .from("contracts")
    .delete()
    .eq("id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

/**
 * POST /api/alerts/configure
 * Set up email alert preferences for a company
 */
app.post("/api/alerts/configure", requireAuth, async (req, res) => {
  const company_id = req.userId;
  const { email, company_name, alert_days_before, weekly_digest, send_test } = req.body;

  if (!email) return res.status(400).json({ error: "email is required" });

  const { data, error } = await supabase
    .from("alert_configs")
    .upsert({
      company_id,
      email,
      company_name: company_name || "Your Company",
      alert_days_before: alert_days_before || [30, 60, 90],
      weekly_digest: weekly_digest ?? true,
      updated_at: new Date().toISOString()
    }, { onConflict: "company_id" })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Send test email if requested
  if (send_test) {
    const { data: contracts } = await supabase
      .from("contracts")
      .select("*")
      .eq("company_id", company_id)
      .limit(3);

    await sendAlertEmail(data, contracts || []);
  }

  res.json({ success: true, config: data });
});

/**
 * POST /api/alerts/send-digest
 * Manually trigger digest for a company
 */
app.post("/api/alerts/send-digest", requireAuth, async (req, res) => {
  const company_id = req.userId;

  const { data: config } = await supabase
    .from("alert_configs")
    .select("*")
    .eq("company_id", company_id)
    .single();

  if (!config) return res.status(404).json({ error: "No alert config found" });

  const { data: contracts } = await supabase
    .from("contracts")
    .select("*")
    .eq("company_id", company_id);

  const result = await sendAlertEmail(config, contracts || []);
  res.json({ success: true, emailId: result?.id });
});

/**
 * GET /api/dashboard?company_id=xxx
 * Summary stats for a company
 */
app.get("/api/dashboard", requireAuth, async (req, res) => {
  const company_id = req.userId;

  const { data: contracts, error } = await supabase
    .from("contracts")
    .select("*")
    .eq("company_id", company_id);

  if (error) return res.status(500).json({ error: error.message });

  const totalMonthly = contracts.reduce((s, c) => s + (c.monthly_cost || 0), 0);
  const expiring30 = contracts.filter(c => { const d = daysUntil(c.renewal_date); return d !== null && d <= 30; });
  const expiring60 = contracts.filter(c => { const d = daysUntil(c.renewal_date); return d !== null && d > 30 && d <= 60; });
  const expiring90 = contracts.filter(c => { const d = daysUntil(c.renewal_date); return d !== null && d > 60 && d <= 90; });
  const autoRenewRisk = contracts.filter(c => c.auto_renewal);
  const overpaying = contracts.filter(c => c.overpay_flag);

  res.json({
    total_contracts: contracts.length,
    total_monthly_spend: totalMonthly,
    total_annual_spend: totalMonthly * 12,
    expiring_30_days: expiring30.length,
    expiring_60_days: expiring60.length,
    expiring_90_days: expiring90.length,
    auto_renewal_count: autoRenewRisk.length,
    overpay_count: overpaying.length,
    total_red_flags: contracts.reduce((s, c) => s + (c.red_flags?.length || 0), 0),
    buckets: { urgent: expiring30, soon: expiring60, upcoming: expiring90 }
  });
});

// ─── Email builder ───────────────────────────────────────────────────────────
async function sendAlertEmail(config, contracts) {
  const { email, company_name, alert_days_before = [30, 60, 90] } = config;

  const urgent = contracts.filter(c => {
    const d = daysUntil(c.renewal_date);
    return d !== null && d <= Math.max(...alert_days_before);
  }).sort((a, b) => daysUntil(a.renewal_date) - daysUntil(b.renewal_date));

  const autoRenewRisk = contracts.filter(c => c.auto_renewal && c.renewal_date && daysUntil(c.renewal_date) <= 60);
  const overpaying = contracts.filter(c => c.overpay_flag);
  const totalMonthly = contracts.reduce((s, c) => s + (c.monthly_cost || 0), 0);

  const urgencyColor = (days) => {
    if (days <= 30) return "#ef4444";
    if (days <= 60) return "#f59e0b";
    return "#10b981";
  };

  const contractRows = urgent.map(c => {
    const days = daysUntil(c.renewal_date);
    const color = urgencyColor(days);
    return `
      <tr>
        <td style="padding:12px 16px;border-bottom:1px solid #1e1e2e;font-weight:600;color:#e8e8f0">${c.vendor_name}</td>
        <td style="padding:12px 16px;border-bottom:1px solid #1e1e2e;color:#e8e8f0;font-family:monospace">${formatCurrency(c.monthly_cost)}/mo</td>
        <td style="padding:12px 16px;border-bottom:1px solid #1e1e2e">
          <span style="background:${color}22;color:${color};padding:3px 10px;border-radius:12px;font-size:12px;font-weight:700">${days}d left</span>
        </td>
        <td style="padding:12px 16px;border-bottom:1px solid #1e1e2e;color:#9999bb;font-size:12px">${c.auto_renewal ? "⚠️ Auto-renews" : "Manual renewal"}</td>
      </tr>
    `;
  }).join("");

  const flagItems = contracts
    .flatMap(c => (c.red_flags || []).map(f => ({ vendor: c.vendor_name, flag: f })))
    .slice(0, 6)
    .map(({ vendor, flag }) => `
      <li style="padding:10px 0;border-bottom:1px solid #1e1e2e;color:#e8e8f0">
        <strong style="color:#f59e0b">${vendor}</strong>: ${flag}
      </li>
    `).join("");

  const overpayItems = overpaying.map(c => `
    <li style="padding:10px 0;border-bottom:1px solid #1e1e2e;color:#e8e8f0">
      <strong style="color:#ef4444">${c.vendor_name}</strong> (${formatCurrency(c.monthly_cost)}/mo) — ${c.overpay_reason}
    </li>
  `).join("");

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0f;font-family:'Helvetica Neue',Arial,sans-serif">
  <div style="max-width:680px;margin:0 auto;padding:40px 20px">

    <!-- Header -->
    <div style="background:#12121a;border:1px solid #2a2a3d;border-radius:16px;padding:32px;margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
        <div style="background:#f59e0b;width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px">📋</div>
        <span style="color:#e8e8f0;font-size:20px;font-weight:800;letter-spacing:-0.5px">ContractRadar</span>
      </div>
      <div style="color:#6b6b8a;font-size:12px;font-family:monospace;letter-spacing:2px;text-transform:uppercase">Weekly Contract Intelligence Report</div>
      <div style="color:#9999bb;font-size:13px;margin-top:4px">${company_name} · ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</div>
    </div>

    <!-- Stats row -->
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px">
      <div style="background:#12121a;border:1px solid #2a2a3d;border-top:3px solid #ef4444;border-radius:12px;padding:18px">
        <div style="color:#6b6b8a;font-size:10px;font-family:monospace;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px">Expiring Soon</div>
        <div style="color:#ef4444;font-size:32px;font-weight:800">${urgent.length}</div>
        <div style="color:#6b6b8a;font-size:12px">within 90 days</div>
      </div>
      <div style="background:#12121a;border:1px solid #2a2a3d;border-top:3px solid #f59e0b;border-radius:12px;padding:18px">
        <div style="color:#6b6b8a;font-size:10px;font-family:monospace;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px">Auto-Renewal Risk</div>
        <div style="color:#f59e0b;font-size:32px;font-weight:800">${autoRenewRisk.length}</div>
        <div style="color:#6b6b8a;font-size:12px">need action now</div>
      </div>
      <div style="background:#12121a;border:1px solid #2a2a3d;border-top:3px solid #6366f1;border-radius:12px;padding:18px">
        <div style="color:#6b6b8a;font-size:10px;font-family:monospace;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px">Monthly Spend</div>
        <div style="color:#a5b4fc;font-size:28px;font-weight:800;font-family:monospace">${formatCurrency(totalMonthly)}</div>
        <div style="color:#6b6b8a;font-size:12px">across ${contracts.length} contracts</div>
      </div>
    </div>

    <!-- Expiring contracts table -->
    ${urgent.length > 0 ? `
    <div style="background:#12121a;border:1px solid #2a2a3d;border-radius:12px;overflow:hidden;margin-bottom:20px">
      <div style="padding:18px 16px 14px;border-bottom:1px solid #2a2a3d">
        <span style="color:#e8e8f0;font-weight:700;font-size:15px">⏰ Contracts Requiring Action</span>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:#0a0a0f">
            <th style="padding:10px 16px;text-align:left;color:#6b6b8a;font-size:11px;font-family:monospace;letter-spacing:1px;text-transform:uppercase">Vendor</th>
            <th style="padding:10px 16px;text-align:left;color:#6b6b8a;font-size:11px;font-family:monospace;letter-spacing:1px;text-transform:uppercase">Cost</th>
            <th style="padding:10px 16px;text-align:left;color:#6b6b8a;font-size:11px;font-family:monospace;letter-spacing:1px;text-transform:uppercase">Deadline</th>
            <th style="padding:10px 16px;text-align:left;color:#6b6b8a;font-size:11px;font-family:monospace;letter-spacing:1px;text-transform:uppercase">Type</th>
          </tr>
        </thead>
        <tbody>${contractRows}</tbody>
      </table>
    </div>
    ` : ""}

    <!-- Red flags -->
    ${flagItems ? `
    <div style="background:#12121a;border:1px solid #2a2a3d;border-radius:12px;padding:20px;margin-bottom:20px">
      <div style="color:#e8e8f0;font-weight:700;font-size:15px;margin-bottom:14px">⚠️ Risk Flags</div>
      <ul style="list-style:none;margin:0;padding:0">${flagItems}</ul>
    </div>
    ` : ""}

    <!-- Overpay alerts -->
    ${overpayItems ? `
    <div style="background:#12121a;border:1px solid rgba(239,68,68,0.3);border-radius:12px;padding:20px;margin-bottom:20px">
      <div style="color:#e8e8f0;font-weight:700;font-size:15px;margin-bottom:14px">💸 Overpayment Opportunities</div>
      <ul style="list-style:none;margin:0;padding:0">${overpayItems}</ul>
    </div>
    ` : ""}

    <!-- Footer -->
    <div style="text-align:center;padding:20px;color:#6b6b8a;font-size:12px;font-family:monospace">
      ContractRadar · AI-powered contract intelligence<br>
      <span style="color:#2a2a3d">──────────────────────────────</span>
    </div>
  </div>
</body>
</html>`;

  return await resend.emails.send({
    from: "ContractRadar <Sending@resend.dev>",
    to: [email],
    subject: `📋 ContractRadar: ${urgent.length} contract${urgent.length !== 1 ? "s" : ""} need attention — ${company_name}`,
    html
  });
}

// ─── Cron Jobs ───────────────────────────────────────────────────────────────

// Every Monday at 8am — weekly digest
cron.schedule("0 8 * * 1", async () => {
  console.log("[CRON] Running weekly digest...");
  const { data: configs } = await supabase
    .from("alert_configs")
    .select("*")
    .eq("weekly_digest", true);

  for (const config of (configs || [])) {
    const { data: contracts } = await supabase
      .from("contracts")
      .select("*")
      .eq("company_id", config.company_id);

    try {
      await sendAlertEmail(config, contracts || []);
      console.log(`[CRON] Digest sent to ${config.email}`);
    } catch (e) {
      console.error(`[CRON] Failed for ${config.email}:`, e.message);
    }
  }
}, { timezone: "America/New_York" });

// Every day at 9am — urgent alerts (contracts expiring in ≤30 days)
cron.schedule("0 9 * * *", async () => {
  console.log("[CRON] Checking urgent expirations...");
  const { data: configs } = await supabase.from("alert_configs").select("*");

  for (const config of (configs || [])) {
    const { data: contracts } = await supabase
      .from("contracts")
      .select("*")
      .eq("company_id", config.company_id);

    const urgent = (contracts || []).filter(c => {
      const d = daysUntil(c.renewal_date);
      // Alert if exactly at threshold days
      return config.alert_days_before.includes(d);
    });

    if (urgent.length > 0) {
      try {
        await sendAlertEmail(config, contracts || []);
        console.log(`[CRON] Urgent alert sent to ${config.email} — ${urgent.length} contracts`);
      } catch (e) {
        console.error(`[CRON] Failed urgent alert for ${config.email}:`, e.message);
      }
    }
  }
}, { timezone: "America/New_York" });

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ ContractRadar API running on http://localhost:${PORT}`);
  console.log(`   Cron: weekly digest every Monday 8am ET`);
  console.log(`   Cron: urgent alerts every day 9am ET`);
  fs.mkdirSync("uploads", { recursive: true });
});

export default app;
