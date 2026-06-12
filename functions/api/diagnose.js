/**
 * TechSuppAI — Automotive Diagnostic backend
 * Cloudflare Pages Function: handles POST /api/diagnose
 *
 * File location in your project (this exact path creates the route):
 *   /functions/api/diagnose.js
 *
 * Required secret (set in Cloudflare dashboard, see README):
 *   ANTHROPIC_API_KEY
 */

const MODEL = "claude-sonnet-4-6";   // strong + cost-effective for diagnostics
const MAX_TOKENS = 2500;

const SYSTEM_PROMPT = `You are the senior diagnostic technician at TechSuppAI, an automotive
AI diagnostic service. You have decades of experience with engine performance, no-start
conditions, intermittent stalling, electrical systems, and wiring harness / connector failures.

You receive a structured intake from a customer (vehicle info, symptoms, DTC trouble codes,
conditions, and sometimes an attached scanner report as a photo, PDF, or text).

If a scanner report is attached, READ IT CAREFULLY FIRST and extract everything useful:
VIN, all stored/pending/permanent DTCs, freeze frame data, readiness monitors, live data values.
If the report contains a VIN or codes that differ from what the customer typed, trust the report
and note the difference.

Then produce a diagnosis in this exact structure, in plain language a vehicle owner understands:

## What your vehicle is telling us
One short paragraph summarizing the situation in plain words.

## Most likely causes (ranked)
Numbered list, most likely first. For each: the cause, why it fits THIS vehicle's known issues,
the symptom pattern (constant vs intermittent, cold vs hot), and the codes.
Pay special attention to wiring harness and connector failures when the problem is intermittent,
changes over bumps, or involves communication (U) codes.

## How to confirm it
Specific tests in order, cheapest/easiest first. Name actual components and connector
locations for this year/make/model where you know them.

## Severity & drivability
Is it safe to drive? Can it leave the customer stranded? Be direct.

## Estimated repair
Likely parts and a rough USD parts + labor range. Mark estimates clearly as estimates.

Rules:
- Be specific to the exact year, make, model, and engine. Mention known pattern failures and
  TSBs for this vehicle when relevant.
- Never invent codes that aren't in the intake or report.
- If critical information is missing, say exactly what to check or measure next.
- If symptoms suggest an immediate safety risk (brakes, steering, fuel leak, stalling in
  traffic), lead with a clear safety warning.`;

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "Server not configured: missing ANTHROPIC_API_KEY secret." }, 500);
  }

  let intake;
  try {
    intake = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  // Basic sanity checks
  if (!intake || !intake.vehicle || !intake.problem || !intake.customer) {
    return json({ error: "Incomplete intake data." }, 400);
  }

  // ---- Build the message content for Claude ----
  const content = [];

  // 1) Attached scanner report (photo / PDF / text), if any
  const report = intake.scannerReport;
  if (report && report.base64) {
    const mime = (report.mimeType || "").toLowerCase();

    if (mime === "application/pdf") {
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: report.base64 },
      });
    } else if (/^image\/(jpeg|png|webp|gif)$/.test(mime)) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: mime, data: report.base64 },
      });
    } else {
      // text / csv / log exports — decode and inline as text
      try {
        const decoded = decodeURIComponent(escape(atob(report.base64)));
        content.push({
          type: "text",
          text:
            "=== ATTACHED SCANNER REPORT (" + (report.fileName || "report") + ") ===\n" +
            decoded.slice(0, 50000) +
            "\n=== END OF SCANNER REPORT ===",
        });
      } catch {
        /* unreadable attachment — proceed without it */
      }
    }
  }

  // 2) The structured intake itself (strip the base64 so we don't send it twice)
  const intakeForPrompt = { ...intake };
  if (intakeForPrompt.scannerReport) {
    intakeForPrompt.scannerReport = {
      fileName: report.fileName,
      mimeType: report.mimeType,
      note: "file attached above",
    };
  }

  content.push({
    type: "text",
    text:
      "Customer diagnostic intake from techsuppai.com:\n\n" +
      JSON.stringify(intakeForPrompt, null, 2) +
      "\n\nProduce the diagnosis now, following the required structure.",
  });

  // ---- Call the Claude API ----
  let apiResponse;
  try {
    apiResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
      }),
    });
  } catch (err) {
    return json({ error: "Could not reach the AI service. Please try again." }, 502);
  }

  if (!apiResponse.ok) {
    const detail = await apiResponse.text().catch(() => "");
    console.error("Claude API error", apiResponse.status, detail.slice(0, 500));
    return json({ error: "AI diagnosis failed (status " + apiResponse.status + "). Please try again." }, 502);
  }

  const data = await apiResponse.json();

  // Assemble all text blocks from the response
  const diagnosis = (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  if (!diagnosis) {
    return json({ error: "The AI returned an empty diagnosis. Please try again." }, 502);
  }

  return json({
    ticketId: intake.ticketId || null,
    vehicle: intake.vehicle,
    diagnosis,
  });
}

// Reject non-POST requests cleanly
export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: "Method not allowed. POST a diagnostic intake JSON." }, 405);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
