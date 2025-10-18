require("dotenv").config();
const express = require("express");
const { Client, middleware } = require("@line/bot-sdk");
const { google } = require("googleapis");

const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const app = express();
const client = new Client(config);

// --- Google Sheets設定 ---
const sheetsAuth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth: sheetsAuth });

// --- JSTの日付取得（UTC対策） ---
function getJstDateString() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10).replace(/-/g, "/");
}

// --- Webhookエンドポイント ---
app.post("/webhook", middleware(config), async (req, res) => {
  const events = req.body.events;
  for (const event of events) {
    if (event.type === "message" && event.message.type === "text") {
      await handleMessage(event);
    }
  }
  res.sendStatus(200);
});

// --- メイン処理 ---
async function handleMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text.trim();
  const today = getJstDateString();

  // 「入力」開始
  if (text === "入力") {
    const alreadyDone = await checkIfInputDone(userId, today);
    if (alreadyDone) {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: `${today} は入力済みです。\n訂正する場合は「訂正」と送信してください。`,
      });
      return;
    }
    await setUserState(userId, "確認中");
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `${today} の入力を始めますか？（はい／いいえ）`,
    });
    return;
  }

  // 「はい」または「いいえ」処理
  const state = await getUserState(userId);
  if (state === "確認中") {
    if (text === "はい") {
      await clearTempData(userId);
      await recordTempData(userId, today, "キャベツ");
      await setUserState(userId, "入力中");
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "キャベツの残数を数字で入力してください。",
      });
      return;
    } else if (text === "いいえ") {
      await setUserState(userId, "通常");
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "入力をキャンセルしました。",
      });
      return;
    } else {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "「はい」または「いいえ」と送信してください。",
      });
      return;
    }
  }

  // --- 数字入力（キャベツ→プリン→カレーの順固定） ---
  if (!isNaN(text)) {
    const nextStep = await handleFixedOrderInput(userId, Number(text));

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
      await setUserState(userId, "登録確認中");
    }
    return;
  }

  // --- 登録確認中のはい／いいえ ---
  if (state === "登録確認中") {
    if (text === "はい") {
      await finalizeRecord(userId, event.replyToken);
      await setUserState(userId, "通常");
      return;
    } else if (text === "いいえ") {
      await clearTempData(userId);
      await setUserState(userId, "通常");
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "登録をキャンセルしました。",
      });
      return;
    } else {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "「はい」または「いいえ」と送信してください。",
      });
      return;
    }
  }

  // --- 入力・訂正・確認の以外は「使い方」 ---
  if (!["入力", "訂正", "確認"].includes(text)) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "使い方",
    });
  }
}

// --- 一時データ（入力中）記録 ---
async function recordTempData(userId, date, product, quantity) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tempSheet = "入力中";
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tempSheet}!A:E`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[userId, date, product, quantity || "", "入力中"]] },
  });
}

// --- 入力ステップ管理 ---
async function handleFixedOrderInput(userId, quantity) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tempSheet = "入力中";
  const date = getJstDateString();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tempSheet}!A:E`,
  });
  const rows = res.data.values || [];
  const todayRows = rows.filter(r => r[0] === userId && r[1] === date);
  const order = ["キャベツ", "プリン", "カレー"];

  if (todayRows.length === 0) return null;
  const current = todayRows[todayRows.length - 1][2];
  const nextIndex = order.indexOf(current);

  // 入力更新
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tempSheet}!A${rows.length}:E${rows.length}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[userId, date, current, quantity, "入力済"]],
    },
  });

  if (nextIndex < order.length - 1) {
    const nextProduct = order[nextIndex + 1];
    await recordTempData(userId, date, nextProduct);
    return nextProduct;
  } else {
    return "完了";
  }
}

// --- 発注記録登録 ---
async function finalizeRecord(userId, replyToken) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tempSheet = "入力中";
  const mainSheet = "発注記録";
  const date = getJstDateString();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tempSheet}!A:E`,
  });
  const rows = res.data.values || [];
  const todayRows = rows.filter(r => r[0] === userId && r[1] === date);

  if (todayRows.length < 3) {
    await client.replyMessage(replyToken, {
      type: "text",
      text: "まだ３商品の入力が完了していません。",
    });
    return;
  }

  for (const row of todayRows) {
    const [uid, d, product, quantity] = row;
    const orderAmount = Math.max(0, 10 - Number(quantity)); // 仮計算
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${mainSheet}!A:F`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[d, product, quantity, orderAmount, uid, "登録済"]] },
    });
  }

  await clearTempData(userId);
  await client.replyMessage(replyToken, {
    type: "text",
    text: "本日の発注データを登録しました。お疲れさまです。",
  });
}

// --- 一時データ削除 ---
async function clearTempData(userId) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tempSheet = "入力中";
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tempSheet}!A:E`,
  });
  const rows = res.data.values || [];
  const filtered = rows.filter(r => r[0] !== userId);
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${tempSheet}!A:E`,
  });
  if (filtered.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tempSheet}!A:E`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: filtered },
    });
  }
}

// --- 入力済みチェック ---
async function checkIfInputDone(userId, date) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const mainSheet = "発注記録";
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${mainSheet}!A:F`,
  });
  const rows = res.data.values || [];
  return rows.some(r => r[0] === date && r[4] === userId);
}

// --- 状態管理 ---
async function setUserState(userId, state) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const stateSheet = "状態";
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${stateSheet}!A:B`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[userId, state]] },
  });
}

async function getUserState(userId) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const stateSheet = "状態";
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${stateSheet}!A:B`,
  });
  const rows = res.data.values || [];
  const latest = rows.reverse().find(r => r[0] === userId);
  return latest ? latest[1] : "通常";
}

app.get("/", (req, res) => res.send("LINE Webhook server is running."));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
