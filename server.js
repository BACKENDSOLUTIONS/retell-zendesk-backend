const express = require("express");
const fetch = require("node-fetch");
const app = express();

app.use(express.json());

// Health-check endpoint
app.get("/", (req, res) => {
  res.send("Retell → Zendesk backend is running.");
});

// Create-ticket endpoint
app.post("/create-ticket", async (req, res) => {
  try {
    // Подивитися, що саме приходить від Retell (можна потім видалити)
console.log("Incoming body from Retell:", JSON.stringify(req.body, null, 2));

// Працюємо з різними варіантами структури
const raw = req.body || {};
const args = raw.args || raw.arguments || raw.parameters || raw;

const {
  name,
  email,
  issue_description,
  serial_number,
  car_model,
} = args || {};
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
            subject: `AI Voice Bot Issue — ${name}`,
            comment: {
              body: `Issue Description:\n${issue_description}\n\nCustomer Information:\n- Name: ${name}\n- Email: ${email}\n- Serial Number: ${serial_number}\n- Car Model: ${car_model}`,
            },
            requester: {
              name: name,
              email: email,
            },
            tags: ["retell_ai", "voice_bot"],
          },
        }),
      }
    );

    const data = await response.json();
    res.json({ success: true, zendesk_response: data });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// IMPORTANT: Render provides the PORT via environment variable
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

