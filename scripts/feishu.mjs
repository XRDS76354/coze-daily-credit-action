import crypto from "node:crypto";

export async function sendFeishu({ title, content } = {}) {
  const webhookUrl = (process.env.FEISHU_WEBHOOK_URL || "").trim();
  if (!webhookUrl) {
    console.log("FEISHU_WEBHOOK_URL is not set; skip Feishu notification.");
    return false;
  }

  const payload = {
    msg_type: "text",
    content: {
      text: [title, content].filter(Boolean).join("\n")
    }
  };

  const secret = (process.env.FEISHU_WEBHOOK_SECRET || "").trim();
  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const sign = crypto
      .createHmac("sha256", `${timestamp}\n${secret}`)
      .update("")
      .digest("base64");
    payload.timestamp = timestamp;
    payload.sign = sign;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  }).catch((error) => {
    console.error(`Feishu notification failed: ${error.message}`);
    return null;
  });

  if (!response) return false;

  const text = await response.text();
  if (!response.ok) {
    console.error(`Feishu notification returned HTTP ${response.status}: ${text}`);
    return false;
  }

  const result = parseJson(text) || {};
  const code = typeof result.code === "number" ? result.code : result.StatusCode;
  if (typeof code === "number" && code !== 0) {
    console.error(`Feishu notification returned code ${code}: ${result.msg || result.StatusMessage || text}`);
    return false;
  }

  console.log("Feishu notification sent.");
  return true;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
