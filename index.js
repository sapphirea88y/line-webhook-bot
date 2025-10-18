require("dotenv").config();
const express = require("express");
const { Client, middleware } = require("@line/bot-sdk");
const { google } = require("googleapis");

// ===== LINE設定 =====
const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const app = express();
const client = new Client(config);

// ===== Google Sheets設定 =====
const sheetsAuth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth: sheetsAuth });

// ===== Webhook =====
app.post("/webhook", middleware(config), async (req, res) => {
  const events = req.body.events;
  for (const event of events) {
    if (event.type === "message" && event.message.type === "text") {
      await handleMessage(event);
    }
  }
  res.sendStatus(200);
});

// ===== メインメッセージ処理 =====
async function handleMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text.trim();
  const state = await getUserState(userId);

  console.log(`🗣 ${userId} (${state}) → ${text}`);

  // === キャンセル共通処理 ===
  if (text === "キャンセル") {
    await clearTempData(userId);
    await setUserState(userId, "通常");
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "入力を中止しました。",
    });
    return;
  }

  // === 通常状態 ===
  if (state === "通常") {
    if (text === "入力") {
      await handleInputStart(userId, event.replyToken);
      return;
    }
    if (text === "訂正") {
      await handleCorrectionStart(userId, event.replyToken);
      return;
    }
    if (text === "確認") {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "（確認機能は準備中です）",
      });
      return;
    }

    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "「入力」「訂正」「確認」のいずれかを送信してください。",
    });
    return;
  }

  // === 入力確認中 ===
  if (state === "入力確認中") {
    if (text === "はい") {
      await setUserState(userId, "入力中");
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "キャベツの残数を数字で入力してください。",
      });
      return;
    }
    if (text === "いいえ") {
      await setUserState(userId, "通常");
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "入力を中止しました。",
      });
      return;
    }
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "「はい」または「いいえ」と送信してください。",
    });
    return;
  }

  // === 訂正確認中 ===
  if (state === "訂正確認中") {
    if (text === "はい") {
      await setUserState(userId, "訂正選択中");
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "入力を訂正する材料を選んでください。（キャベツ／プリン／カレー）",
      });
      return;
    }
    if (text === "いいえ") {
      await setUserState(userId, "通常");
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "訂正を中止しました。",
      });
      return;
    }
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "「はい」または「いいえ」と送信してください。",
    });
    return;
  }

  // === 訂正選択中 ===
  if (state === "訂正選択中") {
    if (["キャベツ", "プリン", "カレー"].includes(text)) {
      await recordTempData(userId, text); // 訂正対象を一時記録
      await setUserState(userId, "訂正入力中");
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: `${text}の残数を数字で入力してください。`,
      });
      return;
    }
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "「キャベツ」「プリン」「カレー」のいずれかを送信してください。\n訂正をやめる場合は「キャンセル」と送信してください。",
    });
    return;
  }

  // === 入力中 ===
  if (state === "入力中") {
    if (isNaN(text)) {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "数字のみで送信してください。\n入力をやめる場合は「キャンセル」と送信してください。",
      });
      return;
    }
    await handleInputFlow(userId, Number(text), event.replyToken);
    return;
  }

  await client.replyMessage(event.replyToken, {
    type: "text",
    text: "状態が不明です。「入力」または「訂正」と送信してください。",
  });
}

// ===== 関数群 =====

// 入力の最初
async function handleInputStart(userId, replyToken) {
  const date = new Date().toLocaleDateString("ja-JP");
  await setUserState(userId, "入力確認中");
  await client.replyMessage(replyToken, {
    type: "text",
    text: `${date}日の入力を始めますか？（はい／いいえ）`,
  });
}

// 訂正の最初
async function handleCorrectionStart(userId, replyToken) {
  const date = new Date().toLocaleDateString("ja-JP");
  await setUserState(userId, "訂正確認中");
  await client.replyMessage(replyToken, {
    type: "text",
    text: `${date}日の入力を訂正しますか？（はい／いいえ）`,
  });
}

// 入力中の流れ
async function handleInputFlow(userId, quantity, replyToken) {
  const date = new Date().toLocaleDateString("ja-JP");
  const temp = await getTempData(userId);

  const nextProduct = !temp
    ? "キャベツ"
    : temp === "キャベツ"
    ? "プリン"
    : temp === "プリン"
    ? "カレー"
    : null;

  if (!nextProduct) {
    await client.replyMessage(replyToken, {
      type: "text",
      text: "３つすべての入力が完了しました。登録しますか？（はい／いいえ）",
    });
    await setUserState(userId, "登録確認中");
    return;
  }

  await recordTempData(userId, nextProduct, quantity);
  await client.replyMessage(replyToken, {
    type: "text",
    text: `${nextProduct}の残数を数字で入力してください。`,
  });
}

// 一時記録シート書き込み
async function recordTempData(userId, product, quantity) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const sheetName = "入力中";
  const date = new Date().toLocaleDateString("ja-JP");
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:D`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[userId, date, product, quantity || ""]] },
  });
}

// 一時記録取得（最後の記録商品）
async function getTempData(userId) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const sheetName = "入力中";
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:D`,
  });
  const rows = res.data.values || [];
  const today = new Date().toLocaleDateString("ja-JP");
  const userRows = rows.filter((r) => r[0] === userId && r[1] === today);
  return userRows.length > 0 ? userRows[userRows.length - 1][2] : null;
}

// 状態取得
async function getUserState(userId) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "状態!A:B",
  });
  const rows = res.data.values || [];
  const row = rows.find((r) => r[0] === userId);
  return row ? row[1] : "通常";
}

// 状態保存
async function setUserState(userId, state) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const sheet = "状態";
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheet}!A:B`,
  });
  const rows = res.data.values || [];
  const idx = rows.findIndex((r) => r[0] === userId);
  if (idx >= 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheet}!B${idx + 1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[state]] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheet}!A:B`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[userId, state]] },
    });
  }
}

// 仮データ削除
async function clearTempData(userId) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const sheet = "入力中";
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheet}!A:D`,
  });
  const rows = res.data.values || [];
  const remain = rows.filter((r) => r[0] !== userId);
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${sheet}!A:D`,
  });
  if (remain.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheet}!A:D`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: remain },
    });
  }
}

app.get("/", (req, res) => res.send("LINE Webhook server is running."));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
