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
// 📩 Webhook
// ======================
app.post("/webhook", middleware(config), async (req, res) => {
  try {
    for (const event of req.body.events) {
      if (event.type === "message" && event.message.type === "text") {
        await handleMessage(event);
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.sendStatus(500);
  }
});

// ======================
// 💬 メイン処理
// ======================
async function handleMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text.trim();
  const today = new Date().toLocaleDateString("ja-JP");

  try {
    // --- 「入力」で始まる ---
    if (text === "入力") {
      const alreadyDone = await checkIfInputDone(userId, today);

      if (alreadyDone) {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: `${today} は入力済みです。\n入力の訂正をしたい場合は「訂正」と送信してください。`,
        });
      } else {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: `${today} の入力を始めますか？（はい／いいえ）`,
        });
      }
      return;
    }

    // --- 入力開始確認 ---
    if (text === "はい") {
      // 未入力データをクリア
      await clearTempData(userId);
      await recordTempData(userId, "キャベツ");
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "キャベツの残数を数字で入力してください。",
      });
      return;
    }

    // --- 入力拒否 ---
    if (text === "いいえ") {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "入力をキャンセルしました。",
      });
      return;
    }

    // --- 数字入力 ---
    if (!isNaN(text)) {
      const nextStep = await handleFixedOrderInput(userId, Number(text));

      if (nextStep === "プリン") {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "プリンの残数を数字で入力してください。",
        });
      } else if (nextStep === "カレー") {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "カレーの残数を数字で入力してください。",
        });
      } else if (nextStep === "完了") {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "３つの商品すべて入力されました。\n登録しますか？（はい／いいえ）",
        });
      }
      return;
    }

    // --- 登録確定 ---
    if (text === "登録" || text === "発注") {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "登録には「はい」と返信してください。",
      });
      return;
    }

    if (text === "訂正") {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "訂正機能は準備中です。",
      });
      return;
    }

    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "数字で入力するか、「入力」と送信して始めてください。",
    });
  } catch (err) {
    console.error("❌ handleMessage error:", err.message);
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "エラーが発生しました。もう一度お試しください。",
    });
  }
}

// ======================
// 🧮 入力順制御
// ======================
const orderList = ["キャベツ", "プリン", "カレー"];

async function handleFixedOrderInput(userId, quantity) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tempSheet = "入力中";
  const date = new Date().toLocaleDateString("ja-JP");

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tempSheet}!A:E`,
  });
  const rows = res.data.values || [];

  // 最後の未入力行を探す
  const targetIndex = rows.findIndex(
    (r) => r[0] === userId && r[1] === date && r[3] === ""
  );
  if (targetIndex === -1) return;

  rows[targetIndex][3] = quantity;
  rows[targetIndex][4] = "入力済";

  // 次の商品を決定
  const nextProduct = orderList[orderList.indexOf(rows[targetIndex][2]) + 1];
  if (nextProduct) {
    await recordTempData(userId, nextProduct);
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tempSheet}!A:E`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });

  console.log(`✅ ${rows[targetIndex][2]}: ${quantity}`);
  return nextProduct || "完了";
}

// ======================
// 🗂️ 仮記録管理
// ======================
async function recordTempData(userId, product) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tempSheet = "入力中";
  const date = new Date().toLocaleDateString("ja-JP");
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tempSheet}!A:E`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[userId, date, product, "", "入力中"]] },
  });
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
  const newRows = rows.filter((r) => !(r[0] === userId && r[1] === date));

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
}

async function checkIfInputDone(userId, date) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const mainSheet = "発注記録";
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${mainSheet}!A:F`,
  });
  const rows = res.data.values || [];
  return rows.some((r) => r[0] === date && r[5] === userId);
}

// ======================
// 🖥️ サーバー起動
// ======================
app.get("/", (req, res) => res.send("LINE Webhook server is running."));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
