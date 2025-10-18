require("dotenv").config();
const express = require("express");
const { Client, middleware } = require("@line/bot-sdk");
const { google } = require("googleapis");

// ======================
// 🕐 JSTで日付を取得
// ======================
function getJstDateString() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000); // UTC→JST(+9h)
  const [y, m, d] = jst.toISOString().split("T")[0].split("-");
  return `${y}/${m}/${d}`; // "2025/10/19" のような形式
}

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
  const today = getJstDateString();

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

    // --- 「はい」処理（登録 or 開始の見分け） ---
    if (text === "はい") {
      const status = await getUserInputStatus(userId);

      if (status === "登録待ち") {
        await finalizeRecord(userId, event.replyToken);
        return;
      } else {
        await clearTempData(userId);
        await recordTempData(userId, "キャベツ");
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "キャベツの残数を数字で入力してください。",
        });
        return;
      }
    }

    // --- 入力拒否 ---
    if (text === "いいえ") {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "入力をキャンセルしました。",
      });
      return;
    }

    // --- 数字入力（キャベツ→プリン→カレーの順固定） ---
if (!isNaN(text)) {
  const nextStep = await handleFixedOrderInput(userId, Number(text));

  // 入力中データが存在しなければ nextStep は undefined
  if (!nextStep) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "使い方",
    });
    return;
  }

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

    // --- 訂正（仮） ---
    if (text === "訂正") {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "訂正機能は準備中です。",
      });
      return;
    }

    // --- その他のメッセージ ---
    if (!["入力", "訂正", "確認"].includes(text)) {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "使い方",
      });
    } 
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
  const date = getJstDateString();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tempSheet}!A:E`,
  });
  const rows = res.data.values || [];

  const targetIndex = rows.findIndex(
    (r) => r[0] === userId && r[1] === date && r[3] === ""
  );
  if (targetIndex === -1) return;

  rows[targetIndex][3] = quantity;
  rows[targetIndex][4] = "入力済";

  const nextProduct = orderList[orderList.indexOf(rows[targetIndex][2]) + 1];

  if (nextProduct) {
    await recordTempData(userId, nextProduct);
  } else {
    rows
      .filter(r => r[0] === userId && r[1] === date)
      .forEach(r => (r[4] = "入力済"));
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
  const date = getJstDateString();
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
  const date = getJstDateString();

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

// ======================
// ✅ 入力ステータス判定
// ======================
async function getUserInputStatus(userId) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tempSheet = "入力中";
  const date = getJstDateString();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tempSheet}!A:E`,
  });
  const rows = res.data.values || [];
  const today = rows.filter(r => r[0] === userId && r[1] === date);

  if (today.length === 3 && today.every(r => r[4] === "入力済")) {
    return "登録待ち";
  }
  return "入力中";
}

// ======================
// ✅ 入力済チェック（発注記録）
// ======================
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
// 📦 確定登録処理
// ======================
async function finalizeRecord(userId, replyToken) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tempSheet = "入力中";
  const mainSheet = "発注記録";
  const now = new Date();
  const date = getJstDateString();
  const day = now.toLocaleDateString("ja-JP", { weekday: "short" });

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tempSheet}!A:E`,
    });
    const rows = res.data.values || [];
    const todayInputs = rows.filter((r) => r[0] === userId && r[1] === date);

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
      const orderAmount = Math.max(0, 10 - quantity);

      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${mainSheet}!A:F`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[date, day, product, quantity, orderAmount, userId]],
        },
      });
    }

    await clearTempData(userId);

    await client.replyMessage(replyToken, {
      type: "text",
      text: "本日の発注データを登録しました。お疲れさまです。",
    });

    console.log(`✅ ${userId} のデータ確定登録`);
  } catch (err) {
    console.error("❌ finalizeRecord エラー:", err.message);
    await client.replyMessage(replyToken, {
      type: "text",
      text: "登録時にエラーが発生しました。",
    });
  }
}

// ======================
// 🖥️ サーバー起動
// ======================
app.get("/", (req, res) => res.send("LINE Webhook server is running."));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));


