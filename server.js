const express = require("express");
const fetch = require("node-fetch");
const app = express();

app.use(express.json());

// ------------------------
// Config
// ------------------------
const EARLY_HANGUP_THRESHOLD_SEC = 20;

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

function didTransfer(call) {
  // 1) transcript_with_tool_calls часто містить tool_call_invocation
  const twtc = call?.transcript_with_tool_calls;
  if (Array.isArray(twtc)) {
    const has = twtc.some(
      (e) =>
        e?.role === "tool_call_invocation" &&
        safeLower(e?.name).includes("transfer")
    );
    if (has) return true;
  }

  // 2) call.tool_calls (як у твоєму логу) — масив з {name,type,...}
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

  // UA/RU phrases (на випадок, якщо буде)
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
  const transcript = call?.transcript || "";
  const callSummary =
    call?.call_analysis?.call_summary ||
    call?.call_analysis?.call_summary_text ||
    "";

  return [
    "=== AI VOICE CALL REVIEW ===",
    `Call ID: ${callId}`,
    `Agent Name: ${agentName}`,
    `Call Type: ${callType}`,
    `Duration (sec): ${durationSec}`,
    `Start timestamp: ${startTs}`,
    `End timestamp: ${endTs}`,
    "",
    "=== COLLECTED VARIABLES ===",
    JSON.stringify(vars, null, 2),
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

  // Base tags (твоя “основа”)
  tags.add("retell_ai");
  tags.add("voice_bot");
  tags.add("ai_call_review");

  // Call type tag (корисно для Explore)
  if (call?.call_type) tags.add(`calltype_${safeLower(call.call_type)}`);

  // Voicemail tag (якщо є)
  const inVoicemail = !!call?.call_analysis?.in_voicemail;
  tags.add(inVoicemail ? "voicemail_yes" : "voicemail_no");

  const transferred = didTransfer(call);
  tags.add(transferred ? "ai_transferred" : "ai_not_transferred");

  const transcript = call?.transcript || "";
  const requestedHuman = detectRequestedHuman(transcript);

  const userSentiment = safeLower(call?.call_analysis?.user_sentiment); // "positive"/"neutral"/"negative" etc
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

  // Success flag (якщо Retell дав)
  const callSuccessful = call?.call_analysis?.call_successful;
  const hasCallSuccessful = typeof callSuccessful === "boolean";

  // Outcome logic (взаємовиключно)
  let outcome = "ai_resolved";

  // FAILED якщо:
  // - був transfer (за твоєю логікою він йде як failed + transferred)
  // - або user просив людину
  // - або sentiment negative
  // - або call_successful=false (якщо є)
  // - або пізній hangup (ai_hangup) — зазвичай це “не зайшло”
  if (
    transferred ||
    requestedHuman ||
    userSentiment === "negative" ||
    (hasCallSuccessful && callSuccessful === false) ||
    tags.has("ai_hangup")
  ) {
    outcome = "ai_failed";
  }

  // ВАЖЛИВИЙ виняток:
  // early_hangup НЕ має автоматично псувати метрику failed
  // (бо це часто “не хочу говорити з AI”)
  // Але якщо клієнт явно просив людину/негатив — тоді лишаємо failed.
  if (tags.has("ai_early_hangup") && !requestedHuman && userSentiment !== "negative") {
    outcome = "ai_resolved"; // трактуємо як "no-chance / not counted as failure"
    tags.add("ai_no_chance");
  }

  // Гарантуємо взаємовиключність
  tags.delete("ai_resolved");
  tags.delete("ai_failed");
  tags.add(outcome);

  // Якщо хочеш — можна також тегнути запит на людину
  if (requestedHuman) tags.add("requested_human");

  return Array.from(tags);
}

// ------------------------
// Створення тікета з Retell (function create_ticket)
// ------------------------
app.post("/create-ticket", async (req, res) => {
  try {
    console.log("Incoming body from Retell:", JSON.stringify(req.body, null, 2));

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

    // Retell збереже ticket_id у call.retell_llm_dynamic_variables.ticket_id
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
// Webhook від Retell після дзвінка
// -------------------------------------------
app.post("/retell-webhook", async (req, res) => {
  try {
    console.log("Incoming Retell webhook RAW:", JSON.stringify(req.body));

    const body = req.body || {};
    const { call } = body;

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
    const hasTranscript = !!transcript;

    console.log("Parsed from webhook:", {
      ticket_id,
      hasTranscript,
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

    // 1) Формуємо QA-пейлоад (summary + transcript + metadata)
    const qaBody = buildQaPayload(call);

    // 2) Рахуємо теги (взаємовиключно resolved/failed)
    const tagsToAdd = computeTags(call);

    console.log("Tags to add:", tagsToAdd);

    // 3) Апдейтимо тікет: додаємо transcript + summary і теги
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
