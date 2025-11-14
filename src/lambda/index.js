// index.mjs または index.js（ハンドラー名は handler）
// ランタイム: Node.js 18.x

const CHATBOT_ENDPOINT = process.env.CHATBOT_ENDPOINT;
const EXPECTED_TOKEN = process.env.WEBHOOK_TOKEN;

// メインハンドラー
export const handler = async (event) => {
  console.log("Received event:", JSON.stringify(event));

  try {
    // 1. 認証トークンチェック（Jira Webhook からのリクエストか確認）
    const headers = event.headers || {};
    // HTTP API v2では header 名が小文字になることが多いので両方見る
    const token = headers["X-Webhook-Token"] || headers["x-webhook-token"];

    if (EXPECTED_TOKEN && token !== EXPECTED_TOKEN) {
      console.warn("Invalid webhook token");
      return {
        statusCode: 401,
        body: JSON.stringify({ message: "Unauthorized" }),
      };
    }

    // 2. Body をパース（Jira は application/json で送ってくる）
    const rawBody = event.body;
    const body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;

    // 3. Jira Webhook payload から必要な情報を抜き出す
    const normalized = normalizeJiraWebhook(body);

    console.log("Normalized issue:", normalized);

    // 4. ここから先は「チャットボット API を叩く処理」
    if (CHATBOT_ENDPOINT) {
      const payloadForChatbot = {
        issueKey: normalized.issueKey,
        summary: normalized.summary,
        description: normalized.description,
        url: normalized.url,
        projectKey: normalized.projectKey,
        updatedBy: normalized.updatedBy,
        instruction:
          "この Jira チケットの内容から、対応した時のリスクと、ざっくりとした実現方法を考えてください。",
      };

      const res = await fetch(CHATBOT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadForChatbot),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error("Chatbot API error:", res.status, text);
        // Jira に対しては 200 を返しておいた方がリトライされにくいので、
        // エラーだけログに残すパターンも多いです
      } else {
        const chatbotResponse = await res.json().catch(() => ({}));
        console.log("Chatbot response:", chatbotResponse);
      }
    } else {
      console.log("CHATBOT_ENDPOINT is not set, skip calling chatbot.");
    }

    // 5. Jira には 200 を返しておけば OK
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true }),
    };
  } catch (err) {
    console.error("Lambda error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Internal server error" }),
    };
  }
};

/**
 * Jira Webhook (標準形式) から必要な情報を抜き出して共通フォーマットにする
 */
function normalizeJiraWebhook(body) {
  const issue = body.issue || {};
  const fields = issue.fields || {};
  const user = body.user || {};

  // Jira Cloud のブラウザ URL は self から組み立てることもできますが、
  // 手っ取り早く description 内に self を書いてしまうのもありです。
  return {
    issueKey: issue.key || "",
    summary: fields.summary || "",
    description: fields.description || "",
    url: issue.self || "", // 後で使いやすいように必要なら変換
    projectKey: fields.project?.key || "",
    updatedBy: user.displayName || "",
  };
}
