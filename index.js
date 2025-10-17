require("dotenv").config();
const express = require("express");
const { Client, middleware } = require("@line/bot-sdk");
const { google } = require("googleapis");

// LINE設定
const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const app = express();
const client = new Client(config);

// Google Sheets設定
const sheetsAuth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth: sheetsAuth });

// Webhook
app.post("/webhook", middleware(config), async (req, res) => {
  const events = req.body.events;
  for (const event of events) {
    if (event.type === "message" && event.message.type === "text") {
      await handleMessage(event);
    }
  }
  res.sendStatus(200);
});

async function handleMessage(event) {
  const text = event.message.text.trim();

  if (text === "発注") {
    await client.replyMessage(event.replyToken, { type: "text", text: "どの商品ですか？" });
  } else if (["A商品", "B商品", "C商品"].includes(text)) {
    await client.replyMessage(event.replyToken, { type: "text", text: `${text}ですね。残りは何個ですか？` });
    await recordToSheet({ product: text });
  } else if (!isNaN(text)) {
    const result = await recordToSheet({ quantity: Number(text) });
    await client.replyMessage(event.replyToken, { type: "text", text: `了解。発注数は ${result} 個です。` });
  } else {
    await client.replyMessage(event.replyToken, { type: "text", text: "「発注」と送ると始まります。" });
  }
}

// Googleスプレッドシートに書き込み・読み込み
async function recordToSheet({ product, quantity }) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const sheetName = "発注記録";
  const now = new Date();
  const date = now.toLocaleDateString("ja-JP");

  try {
    if (product && !quantity) {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A:D`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[date, product, "", ""]] },
      });
      console.log("✅ 商品登録完了:", product);
      return "OK";
    }

    if (quantity) {
      const orderAmount = Math.max(0, 10 - quantity);

      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A:D`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[date, "", quantity, orderAmount]] },
      });

      console.log("✅ 数量登録完了:", quantity, "→ 発注数:", orderAmount);
      return orderAmount;
    }
  } catch (error) {
    console.error("❌ Sheetsエラー:", error.message);
    console.error(error.stack);
    return "エラー";
  }
}

