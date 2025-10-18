require("dotenv").config();
const express = require("express");
const { Client, middleware } = require("@line/bot-sdk");
const { google } = require("googleapis");

// ======================
// 🔧 設定
// ======================
const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const app = express();
const client = new Client(config);

const sheetsAuth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth: sheetsAuth });

// ======================
// 📩 LINE Webhook
// ======================
app.post("/webhook", middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    for (const event of events) {
      if (event.type === "message" && event.message.type === "text") {
        await handleMessage(event);
      }
    }
    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Webhook error:", error.message);
    res.sendStatus(500);
  }
});

// ======================
// 💬 メイン処理
// ======================
async function handleMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text.trim();

  try {
    if (text === "発注") {
      // 入力中データをクリアしてから新規開始
      await clearTempData(userId);
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "どの商品ですか？（キャベツ／プリン／カレー）",
      });
      return;
    }

    if (["キャベツ", "プリン", "カレー"].includes(text)) {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: `${text}ですね。残りは何個ですか？`,
      });
      await recordTempData(userId, text);
      return;
    }

    if (!isNaN(text)) {
      // 最新の未入力商品に数量を記録
      await updateTempQuantity(userId, Number(text));

      if (await checkCompleteInput(userId)) {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "３つの商品すべて入力されました。\n登録しますか？（はい／いいえ）",
        });
      } else {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "次の商品を入力してください。",
        });
      }
      return;
    }

    if (text === "はい") {
      await finalizeRecord(userId, event.replyToken);
      return;
    }

    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "「発注」と送ると始まります。",
    });
  } catch (error) {
    console.error("❌ handleMessage error:", error.message);
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "エラーが発生しました。もう一度お試しください。",
    });
  }
}

// ======================
// 🗂️ 仮記録関係
// ======================
async function recordTempData(userId, product, quantity) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tempSheet = "入力中";
  const date = new Date().toLocaleDateString("ja-JP");

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tempSheet}!A:E`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[userId, date, product, quantity || "", "入力中"]] },
  });

  console.log(`📝 仮記録: ${userId} - ${product}: ${quantity || "(未入力)"}`);
}

async function updateTempQuantity(userId, quantity) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tempSheet = "入力中";
  const date = new Date().toLocaleDateString("ja-JP");

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tempSheet}!A:E`,
  });

  const rows = res.data.values || [];
  const targetIndex = rows.findIndex(r => r[0] === userId && r[1] === date && r[3] === "");

  if (targetIndex === -1) return;

  rows[targetIndex][3] = quantity;
  rows[targetIndex][4] = "入力済";

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tempSheet}!A:E`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });

  console.log(`✅ ${rows[targetIndex][2]} の数量更新: ${quantity}`);
}

async function checkCompleteInput(userId) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tempSheet = "入力中";
  const date = new Date().toLocaleDateString("ja-JP");

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tempSheet}!A:E`,
  });

  const rows = res.data.values || [];
  const todayInputs = rows.filter(r => r[0] === userId && r[1] === date);
  return todayInputs.length >= 3;
}

async function clearTempData(userId) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tempSheet = "入力中";
  const date = new Date().toLocaleDateString("ja-JP");

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tempSheet}!A:E`,
  });

  const rows = res.data.values || [];
  const newRows = rows.filter(r => !(r[0] === userId && r[1] === date));

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${tempSheet}!A:E`,
  });

  if (newRows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tempSheet}!A:E`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: newRows },
    });
  }

  console.log(`🧹 ${userId} の未完データ削除`);
}

// ======================
// 📦 確定登録処理
// ======================
async function finalizeRecord(userId, replyToken) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tempSheet = "入力中";
  const mainSheet = "発注記録";
  const now = new Date();
  const date = now.toLocaleDateString("ja-JP");
  const day = now.toLocaleDateString("ja-JP", { weekday: "short" });

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tempSheet}!A:E`,
    });
    const rows = res.data.values || [];
    const todayInputs = rows.filter(r => r[0] === userId && r[1] === date);

    if (todayInputs.length < 3) {
      await client.replyMessage(replyToken, {
        type: "text",
        text: "まだ３商品の入力が完了していません。",
      });
      return;
    }

    for (const row of todayInputs) {
      const product = row[2];
      const quantity = Number(row[3]);
      const orderAmount = Math.max(0, 10 - quantity); // 仮の発注計算式

      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${mainSheet}!A:F`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[date, day, product, quantity, orderAmount, userId]],
        },
      });
    }

    // 仮データ削除
    await clearTempData(userId);

    await client.replyMessage(replyToken, {
      type: "text",
      text: "本日の発注データを登録しました。お疲れさまです。",
    });

    console.log(`✅ ${userId} の入力データを確定登録`);
  } catch (err) {
    console.error("❌ finalizeRecord エラー:", err.message);
    await client.replyMessage(replyToken, {
      type: "text",
      text: "登録時にエラーが発生しました。",
    });
  }
}

// ======================
// 🖥️ Render用サーバー起動
// ======================
app.get("/", (req, res) => res.send("LINE Webhook server is running."));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
