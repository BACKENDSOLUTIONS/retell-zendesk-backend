const express = require("express");
const fetch = require("node-fetch");

const app = express();

/**
 * IMPORTANT:
 * Retell webhooks can be large (transcript + tool calls + analysis).
 * Default express.json limit is small and causes 413 "Payload Too Large".
 */
app.use(express.json({ limit: "10mb" }));

// ------------------------
// Config
// ------------------------
const EARLY_HANGUP_THRESHOLD_SEC = 20;

// Business hours config (America/Los_Angeles)
const BH_TIMEZONE = "America/Los_Angeles";
const BH_OPEN_HOUR = 8;  // 08:00
const BH_CLOSE_HOUR = 20; // 20:00 (end-exclusive)
const BH_OPEN_MIN = 0;
const BH_CLOSE_MIN = 0;

// Safety limits for Zendesk comment body
const MAX_TRANSCRIPT_CHARS = 30000;      // safe-ish
const MAX_VARS_JSON_CHARS = 6000;        // collected variables block
const MAX_CALL_SUMMARY_CHARS = 6000;     // call summary
const MAX_QA_BODY_CHARS = 60000;         // final QA comment (hard cap)

// ------------------------
// Health-check endpoint
// ------------------------
app.get("/", (req, res) => {
  res.send("Retell → Zendesk backend is running.");
});

// ------------------------
// Helpers
// ------------------------
function safeLower(x) {
  return (x || "").toString().toLowerCase();
}

function truncate(str, maxChars, suffix = "\n...[truncated]") {
  const s = (str || "").toString();
  if (s.length <= maxChars) return s;
  const cut = maxChars - suffix.length;
  return s.slice(0, Math.max(0, cut)) + suffix;
}

function safeJson(obj, maxChars) {
  try {
    const s = JSON.stringify(obj ?? {}, null, 2);
    return truncate(s, maxChars);
  } catch {
    return "{\n  \"error\": \"failed to stringify\"\n}";
  }
}

function didTransfer(call) {
  // 1) transcript_with_tool_calls can include tool_call_invocation
  const twtc = call?.transcript_with_tool_calls;
  if (Array.isArray(twtc)) {
    const has = twtc.some(
      (e) =>
        e?.role === "tool_call_invocation" &&
        safeLower(e?.name).includes("transfer")
    );
    if (has) return true;
  }

  // 2) call.tool_calls — array with {name,type,...}
  const toolCalls = call?.tool_calls;
  if (Array.isArray(toolCalls)) {
    const has = toolCalls.some((t) => safeLower(t?.name).includes("transfer"));
    if (has) return true;
  }

  return false;
}

function detectRequestedHuman(transcript) {
  const t = safeLower(transcript);

  // EN phrases
  const en =
    /\b(human|real person|live agent|representative|talk to someone|speak to someone|agent)\b/.test(
      t
    );

  // UA/RU phrases (optional)
  const ua =
    /(жив(ий|ого)\s+агент|оператор|людин(а|у)|менеджер|з’єднай|з'єднай|переведи)/i.test(
      transcript || ""
    );

  return en || ua;
}

/**
 * Business hours calculator in America/Los_Angeles
 * Returns:
 *  - business_hours: boolean
 *  - weekday: "Mon".."Sun"
 *  - time_hhmm: "HH:MM"
 *  - timezone: "America/Los_Angeles"
 */
function getBusinessHoursNow() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: BH_TIMEZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = fmt.formatToParts(now);
  const part = (type) => parts.find((p) => p.type === type)?.value;

  const weekday = part("weekday") || "Unknown";
  const hh = parseInt(part("hour") || "0", 10);
  const mm = parseInt(part("minute") || "0", 10);
  const time_hhmm = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;

  // Mon-Sat only
  const isWorkingDay = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].includes(weekday);

  // >= 08:00 and < 20:00
  const afterOpen = hh > BH_OPEN_HOUR || (hh === BH_OPEN_HOUR && mm >= BH_OPEN_MIN);
  const beforeClose = hh < BH_CLOSE_HOUR || (hh === BH_CLOSE_HOUR && mm < BH_CLOSE_MIN);

  const business_hours = isWorkingDay && afterOpen && beforeClose;

  return {
    business_hours,
    weekday,
    time_hhmm,
    timezone: BH_TIMEZONE,
  };
}

function buildQaPayload(call) {
  const callId = call?.call_id || "N/A";
  const agentName = call?.agent_name || "N/A";
  const callType = call?.call_type || "N/A";
  const durationSec = Math.round((call?.duration_ms || 0) / 1000);
  const startTs = call?.start_timestamp || "N/A";
  const endTs = call?.end_timestamp || "N/A";

  const vars = call?.collected_dynamic_variables || {};
  const transcriptRaw = call?.transcript || "";

  const transcript = truncate(transcriptRaw, MAX_TRANSCRIPT_CHARS);

  const callSummaryRaw =
    call?.call_analysis?.call_summary ||
    call?.call_analysis?.call_summary_text ||
    "";

  const callSummary = truncate(callSummaryRaw, MAX_CALL_SUMMARY_CHARS);

  const varsJson = safeJson(vars, MAX_VARS_JSON_CHARS);

  const body = [
    "=== AI VOICE CALL REVIEW ===",
    `Call ID: ${callId}`,
    `Agent Name: ${agentName}`,
    `Call Type: ${callType}`,
    `Duration (sec): ${durationSec}`,
    `Start timestamp: ${startTs}`,
    `End timestamp: ${endTs}`,
    "",
    "=== COLLECTED VARIABLES ===",
    varsJson,
    "",
    "=== CALL SUMMARY (from Retell call_analysis) ===",
    callSummary ? callSummary : "N/A",
    "",
    "=== FULL TRANSCRIPT ===",
    transcript ? transcript : "N/A",
  ].join("\n");

  return truncate(body, MAX_QA_BODY_CHARS);
}

function computeTags(call) {
  const tags = new Set();

  // Base tags
  tags.add("retell_ai");
  tags.add("voice_bot");
  tags.add("ai_call_review");

  // Call type tag
  if (call?.call_type) tags.add(`calltype_${safeLower(call.call_type)}`);

  // Voicemail tag
  const inVoicemail = !!call?.call_analysis?.in_voicemail;
  tags.add(inVoicemail ? "voicemail_yes" : "voicemail_no");

  const transferred = didTransfer(call);
  tags.add(transferred ? "ai_transferred" : "ai_not_transferred");

  const transcript = call?.transcript || "";
  const requestedHuman = detectRequestedHuman(transcript);

  const userSentiment = safeLower(call?.call_analysis?.user_sentiment); // positive/neutral/negative etc
  if (userSentiment) tags.add(`sentiment_${userSentiment}`);
  else tags.add("sentiment_unknown");

  const durationSec = (call?.duration_ms || 0) / 1000;
  const disconnectionReason = safeLower(call?.disconnection_reason);

  const userHungUp =
    disconnectionReason.includes("user") || disconnectionReason.includes("client");

  // Hangup classification
  if (userHungUp) {
    if (durationSec > 0 && durationSec < EARLY_HANGUP_THRESHOLD_SEC) {
      tags.add("ai_early_hangup");
    } else {
      tags.add("ai_hangup");
    }
  }

  // Success flag from Retell (if provided)
  const callSuccessful = call?.call_analysis?.call_successful;
  const hasCallSuccessful = typeof callSuccessful === "boolean";

  // Outcome logic (mutually exclusive)
  let outcome = "ai_resolved";

  // FAILED if:
  // - transferred
  // - requested human
  // - sentiment negative
  // - call_successful=false
  // - late hangup
  if (
    transferred ||
    requestedHuman ||
    userSentiment === "negative" ||
    (hasCallSuccessful && callSuccessful === false) ||
    tags.has("ai_hangup")
  ) {
    outcome = "ai_failed";
  }

  // IMPORTANT exception:
  // early_hangup should not automatically mark failed (often "no-chance")
  if (tags.has("ai_early_hangup") && !requestedHuman && userSentiment !== "negative") {
    outcome = "ai_resolved";
    tags.add("ai_no_chance");
  }

  // Ensure mutual exclusivity
  tags.delete("ai_resolved");
  tags.delete("ai_failed");
  tags.add(outcome);

  if (requestedHuman) tags.add("requested_human");

  return Array.from(tags);
}

async function zendeskRequest(path, method, bodyObj) {
  const subdomain = process.env.ZENDESK_SUBDOMAIN;
  const email = process.env.ZENDESK_EMAIL;
  const token = process.env.ZENDESK_API_TOKEN;

  if (!subdomain || !email || !token) {
    throw new Error("Missing Zendesk env vars (ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN)");
  }

  const url = `https://${subdomain}.zendesk.com/api/v2${path}`;

  const resp = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization:
        "Basic " + Buffer.from(`${email}/token:${token}`).toString("base64"),
    },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });

  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

async function createQaTicketFromWebhook(call) {
  const callId = call?.call_id || "N/A";
  const qaBody = buildQaPayload(call);
  const tagsToAdd = computeTags(call);

  const payload = {
    ticket: {
      subject: `AI Voice Call Review — ${callId}`,
      comment: {
        body: qaBody,
        public: false,
      },
      requester: {
        name: "AI Call Review",
        email: "ai-review@internal",
      },
      tags: tagsToAdd,
    },
  };

  const { ok, status, data } = await zendeskRequest("/tickets.json", "POST", payload);
  if (!ok) {
    throw new Error(`Failed to create QA ticket. Zendesk status=${status} body=${JSON.stringify(data).slice(0, 1000)}`);
  }
  return data.ticket?.id;
}

// ------------------------
// Business-hours function for Retell
// ------------------------
app.post("/check-business-hours", (req, res) => {
  try {
    const info = getBusinessHoursNow();

    // Optional: log call id if passed
    const call_id = req.body?.call_id || req.body?.args?.call_id;
    console.log("check-business-hours:", { call_id, ...info });

    res.json(info);
  } catch (err) {
    console.error("Error in /check-business-hours:", err);
    // safest fallback: outside business hours
    res.json({
      business_hours: false,
      weekday: "Unknown",
      time_hhmm: "00:00",
      timezone: BH_TIMEZONE,
      error: err.message,
    });
  }
});

// ------------------------
// Create ticket from Retell (function create_ticket)
// NOTE: serial_number removed, phone added
// ------------------------
app.post("/create-ticket", async (req, res) => {
  try {
    console.log("Incoming body from Retell (/create-ticket):", JSON.stringify(req.body, null, 2));

    const raw = req.body || {};
    const args = raw.args || raw.arguments || raw.parameters || raw;

    const { name, email, issue_description, phone, car_model } = args || {};

    const bodyText =
      `Issue Description:\n${issue_description || "N/A"}\n\n` +
      `Customer Information:\n` +
      `- Name: ${name || "N/A"}\n` +
      `- Email: ${email || "N/A"}\n` +
      `- Phone: ${phone || "N/A"}\n` +
      `- Car Model: ${car_model || "N/A"}`;

    const payload = {
      ticket: {
        subject: `AI Voice Bot — ${name || "Unknown"}`,
        comment: {
          body: bodyText,
          public: false,
        },
        requester: {
          name: name || "AI Call Review",
          email: email || "ai-review@internal",
        },
        tags: ["retell_ai", "voice_bot", "ai_call_review"],
      },
    };

    const { ok, status, data } = await zendeskRequest("/tickets.json", "POST", payload);
    if (!ok) {
      console.error("Zendesk ticket create failed:", status, data);
      return res.status(500).json({ success: false, status, zendesk_response: data });
    }

    const ticketId = data.ticket?.id;
    console.log("Zendesk ticket created:", ticketId);

    // Retell can store ticket_id in dynamic variables if configured on their side
    res.json({
      success: true,
      ticket_id: ticketId,
      zendesk_response: data,
    });
  } catch (err) {
    console.error("Error in /create-ticket:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------
// Webhook from Retell after call (call_ended/call_analyzed/etc.)
// -------------------------------------------
app.post("/retell-webhook", async (req, res) => {
  try {
    // Do NOT log full body (can be huge) — log only high-level info
    const body = req.body || {};
    const call = body.call;

    console.log("Incoming Retell webhook:", {
      event: body.event || body.type || "unknown",
      hasCall: !!call,
      call_id: call?.call_id,
      hasTranscript: !!call?.transcript,
      duration_ms: call?.duration_ms,
      disconnection_reason: call?.disconnection_reason,
    });

    if (!call) {
      return res.json({ success: false, message: "no call object in webhook payload" });
    }

    let ticket_id =
      call.retell_llm_dynamic_variables?.ticket_id ||
      call.metadata?.ticket_id ||
      call.variables?.ticket_id;

    // If no ticket_id, create a QA ticket automatically (per your prompt logic)
    if (!ticket_id) {
      console.log("No ticket_id found in payload. Creating QA ticket...");
      ticket_id = await createQaTicketFromWebhook(call);
      console.log("QA ticket created:", ticket_id);
      return res.json({ success: true, created_qa_ticket: true, ticket_id });
    }

    // Update existing ticket with QA data
    const qaBody = buildQaPayload(call);
    const tagsToAdd = computeTags(call);

    console.log("Updating ticket with QA data:", { ticket_id, tagsToAddCount: tagsToAdd.length });

    const updatePayload = {
      ticket: {
        comment: {
          body: qaBody,
          public: false,
        },
        additional_tags: tagsToAdd,
      },
    };

    const { ok, status, data } = await zendeskRequest(`/tickets/${ticket_id}.json`, "PUT", updatePayload);
    if (!ok) {
      console.error("Zendesk ticket update failed:", status, data);
      return res.status(500).json({ success: false, status, zendesk_response: data });
    }

    console.log("Ticket updated with QA data:", data.ticket?.id);
    return res.json({ success: true, zendesk_response: data });
  } catch (err) {
    console.error("Error in /retell-webhook:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ------------------------
// Error handler (helps diagnose body parser issues cleanly)
// ------------------------
app.use((err, req, res, next) => {
  if (err?.type === "entity.too.large") {
    console.error("Request payload too large:", err.message);
    return res.status(413).json({ success: false, error: "Payload too large" });
  }
  console.error("Unhandled server error:", err);
  res.status(500).json({ success: false, error: err.message || "Server error" });
});

// ------------------------
// Start server
// ------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
