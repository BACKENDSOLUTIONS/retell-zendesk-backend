const express = require("express");
const fetch = require("node-fetch");
const app = express();

// ========================
// Body size limits (Fix 413)
// ========================
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// ------------------------
// Config
// ------------------------
const EARLY_HANGUP_THRESHOLD_SEC = 20;

// Safety truncation to avoid huge Zendesk comments / logs
const MAX_TRANSCRIPT_CHARS = 20000; // adjust if you want more/less
const MAX_VARS_JSON_CHARS = 8000;
const MAX_SUMMARY_CHARS = 4000;

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

function truncate(text, max) {
  const t = (text || "").toString();
  if (!t) return "";
  if (!max || t.length <= max) return t;
  return t.slice(0, max) + "\n\n[TRUNCATED]";
}

function didTransfer(call) {
  // 1) transcript_with_tool_calls often has tool_call_invocation
  const twtc = call?.transcript_with_tool_calls;
  if (Array.isArray(twtc)) {
    const has = twtc.some(
      (e) =>
        e?.role === "tool_call_invocation" &&
        safeLower(e?.name).includes("transfer")
    );
    if (has) return true;
  }

  // 2) call.tool_calls - array with {name,type,...}
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

  // UA/RU phrases
  const ua =
    /(жив(ий|ого)\s+агент|оператор|людин(а|у)|менеджер|з’єднай|з'єднай|переведи)/i.test(
      transcript || ""
    );

  return en || ua;
}

function buildQaPayload(call) {
  const callId = call?.call_id || "N/A";
  const agentName = call?.agent_name || "N/A";
  const callType = call?.call_type || "N/A";
  const durationSec = Math.round((call?.duration_ms || 0) / 1000);
  const startTs = call?.start_timestamp || "N/A";
  const endTs = call?.end_timestamp || "N/A";

  const vars = call?.collected_dynamic_variables || {};
  const varsJson = truncate(JSON.stringify(vars, null, 2), MAX_VARS_JSON_CHARS);

  const transcript = truncate(call?.transcript || "", MAX_TRANSCRIPT_CHARS);

  const callSummaryRaw =
    call?.call_analysis?.call_summary ||
    call?.call_analysis?.call_summary_text ||
    "";

  const callSummary = truncate(callSummaryRaw, MAX_SUMMARY_CHARS);

  const disconnectionReason = call?.disconnection_reason || "N/A";
  const sentiment = call?.call_analysis?.user_sentiment || "N/A";
  const inVoicemail =
    typeof call?.call_analysis?.in_voicemail === "boolean"
      ? call.call_analysis.in_voicemail
      : "N/A";

  return [
    "=== AI VOICE CALL REVIEW ===",
    `Call ID: ${callId}`,
    `Agent Name: ${agentName}`,
    `Call Type: ${callType}`,
    `Duration (sec): ${durationSec}`,
    `Start timestamp: ${startTs}`,
    `End timestamp: ${endTs}`,
    `Disconnection reason: ${disconnectionReason}`,
    `User sentiment: ${sentiment}`,
    `In voicemail (Retell): ${inVoicemail}`,
    "",
    "=== COLLECTED VARIABLES ===",
    varsJson || "N/A",
    "",
    "=== CALL SUMMARY (from Retell call_analysis) ===",
    callSummary ? callSummary : "N/A",
    "",
    "=== FULL TRANSCRIPT ===",
    transcript ? transcript : "N/A",
  ].join("\n");
}

function computeTags(call) {
  const tags = new Set();

  // Base tags
  tags.add("retell_ai");
  tags.add("voice_bot");
  tags.add("ai_call_review");

  // Call type tag
  if (call?.call_type) tags.add(`calltype_${safeLower(call.call_type)}`);

  // Voicemail tag (if present)
  const inVoicemail = !!call?.call_analysis?.in_voicemail;
  tags.add(inVoicemail ? "voicemail_yes" : "voicemail_no");

  const transferred = didTransfer(call);
  tags.add(transferred ? "ai_transferred" : "ai_not_transferred");

  // Human request detection from transcript
  const transcript = call?.transcript || "";
  const requestedHuman = detectRequestedHuman(transcript);
  if (requestedHuman) tags.add("requested_human");

  // Sentiment
  const userSentiment = safeLower(call?.call_analysis?.user_sentiment);
  if (userSentiment) tags.add(`sentiment_${userSentiment}`);
  else tags.add("sentiment_unknown");

  // Duration and hangup
  const durationSec = (call?.duration_ms || 0) / 1000;
  const disconnectionReason = safeLower(call?.disconnection_reason);

  const userHungUp =
    disconnectionReason.includes("user") || disconnectionReason.includes("client");

  // Fix naming: it was ai_hangup but it is user hangup
  if (userHungUp) {
    if (durationSec > 0 && durationSec < EARLY_HANGUP_THRESHOLD_SEC) {
      tags.add("user_early_hangup");
    } else {
      tags.add("user_hangup");
    }
  } else if (disconnectionReason) {
    tags.add(`end_${disconnectionReason.replace(/\s+/g, "_")}`);
  }

  // Call successful flag from Retell
  const callSuccessful = call?.call_analysis?.call_successful;
  const hasCallSuccessful = typeof callSuccessful === "boolean";

  // Outcome logic
  let outcome = "ai_resolved";

  // Mark as failed if transfer happened OR user asked human OR negative sentiment OR call_successful=false OR user_hangup (late)
  if (
    transferred ||
    requestedHuman ||
    userSentiment === "negative" ||
    (hasCallSuccessful && callSuccessful === false) ||
    tags.has("user_hangup")
  ) {
    outcome = "ai_failed";
  }

  // Exception: early hangup should not auto-fail unless explicit human request or negative sentiment
  if (tags.has("user_early_hangup") && !requestedHuman && userSentiment !== "negative") {
    outcome = "ai_resolved";
    tags.add("ai_no_chance");
  }

  // Ensure mutual exclusivity
  tags.delete("ai_resolved");
  tags.delete("ai_failed");
  tags.add(outcome);

  // Additional diagnostics for transfer attempts, if Retell provides it
  // (call.tool_calls might include transfer_call; call.transcript_with_tool_calls might include tool results)
  const toolCalls = call?.tool_calls;
  if (Array.isArray(toolCalls)) {
    const transferAttempted = toolCalls.some((t) => safeLower(t?.name).includes("transfer"));
    if (transferAttempted) tags.add("transfer_attempted");
  }

  // If transcript includes "no human response detected", tag it
  if (safeLower(transcript).includes("no human response detected")) {
    tags.add("transfer_failed_no_human");
  }

  return Array.from(tags);
}

// ------------------------
// Create Zendesk ticket (Retell function create_ticket)
// ------------------------
app.post("/create-ticket", async (req, res) => {
  try {
    console.log("Incoming body from Retell /create-ticket:", {
      hasBody: !!req.body,
      keys: req.body ? Object.keys(req.body) : [],
    });

    const raw = req.body || {};
    const args = raw.args || raw.arguments || raw.parameters || raw;

    const { name, email, issue_description, serial_number, car_model } = args || {};

    const response = await fetch(
      `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:
            "Basic " +
            Buffer.from(
              `${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`
            ).toString("base64"),
        },
        body: JSON.stringify({
          ticket: {
            subject: `AI Voice Bot — ${name || "Unknown"}`,
            comment: {
              body: `Issue Description:\n${issue_description || "N/A"}\n\nCustomer Information:\n- Name: ${
                name || "N/A"
              }\n- Email: ${email || "N/A"}\n- Serial Number: ${
                serial_number || "N/A"
              }\n- Car Model: ${car_model || "N/A"}`,
              public: false,
            },
            requester: {
              name: name || "AI Call Review",
              email: email || "ai-review@internal",
            },
            tags: ["retell_ai", "voice_bot", "ai_call_review"],
          },
        }),
      }
    );

    const data = await response.json();
    const ticketId = data.ticket?.id;

    console.log("Zendesk ticket created:", ticketId);

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
// Retell webhook after call (call_ended / call_analyzed)
// -------------------------------------------
app.post("/retell-webhook", async (req, res) => {
  try {
    // DO NOT log full payload (can be huge)
    const body = req.body || {};
    const call = body.call;

    console.log("Incoming Retell webhook:", {
      hasCall: !!call,
      event: body.event || body.type || "unknown",
      call_id: call?.call_id,
      duration_ms: call?.duration_ms,
      hasTranscript: !!call?.transcript,
    });

    if (!call) {
      console.log("No call object in webhook payload");
      return res.json({
        success: false,
        message: "no call object in webhook payload",
      });
    }

    const ticket_id =
      call.retell_llm_dynamic_variables?.ticket_id ||
      call.metadata?.ticket_id ||
      call.variables?.ticket_id;

    const transcript = call.transcript || "";

    console.log("Parsed from webhook:", {
      ticket_id,
      transcript_length: transcript ? transcript.length : 0,
      disconnection_reason: call.disconnection_reason,
      duration_ms: call.duration_ms,
    });

    if (!ticket_id) {
      console.log("Missing ticket_id in webhook payload", { ticket_id });
      return res.json({
        success: false,
        message: "ticket_id not found in webhook payload",
      });
    }

    // 1) Build QA payload (summary + transcript + metadata)
    const qaBody = buildQaPayload(call);

    // 2) Compute tags
    const tagsToAdd = computeTags(call);

    console.log("Tags to add:", tagsToAdd);

    // 3) Update ticket: add QA comment + tags
    const response = await fetch(
      `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket_id}.json`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization:
            "Basic " +
            Buffer.from(
              `${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`
            ).toString("base64"),
        },
        body: JSON.stringify({
          ticket: {
            comment: {
              body: qaBody,
              public: false,
            },
            additional_tags: tagsToAdd,
          },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Zendesk update failed:", {
        status: response.status,
        data,
      });
      return res.status(500).json({
        success: false,
        message: "Zendesk update failed",
        status: response.status,
        zendesk_response: data,
      });
    }

    console.log("Ticket updated with QA data:", data.ticket?.id);

    return res.json({ success: true, zendesk_response: data });
  } catch (err) {
    console.error("Error in /retell-webhook:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ------------------------
// Start server
// ------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
