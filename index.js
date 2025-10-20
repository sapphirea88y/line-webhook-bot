// ===== 初期設定 =====
require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const { google } = require('googleapis');

// LINE API 設定
const LINE_CONFIG = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// Google Sheets 設定
const SHEETS = google.sheets({
  version: 'v4',
  auth: new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  }),
});

const client = new Client(LINE_CONFIG);
const app = express();
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;

// ===== Google Sheets 共通操作 =====
async function getSheetValues(range) {
  const res = await SHEETS.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });
  return res.data.values || [];
}

async function appendSheetValues(range, values) {
  await SHEETS.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
}

async function updateSheetValues(range, values) {
  await SHEETS.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
}

async function clearSheetValues(range) {
  await SHEETS.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });
}

// ===== JST時間ユーティリティ =====
function getJSTDate() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function getJSTDateString() {
  const d = getJSTDate();
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function getJSTDateTimeString() {
  return getJSTDate().toISOString().replace("T", " ").slice(0, 19);
}

// ===== LINE Webhook受信 =====
app.post("/webhook", middleware(LINE_CONFIG), async (req, res) => {
  for (const event of req.body.events) {
    if (event.type === "message" && event.message.type === "text") {
      await handleMessage(event);
    }
  }
  res.sendStatus(200);
});


// ===== 状態定数（ユーザーの進行状態） =====
const STATE = {
  通常: "通常",
  入力確認中: "入力確認中",
  入力中: "入力中",
  登録確認中: "登録確認中",
  訂正確認中: "訂正確認中",
  訂正選択中: "訂正選択中",
  訂正入力中: "訂正入力中",
  訂正確認入力中: "訂正確認入力中",
};

// ===== メイン処理：メッセージを状態に応じて振り分け =====
async function handleMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text.trim();
  const state = await getUserState(userId);

  // ログ記録
  const timestamp = getJSTDateTimeString();
  try {
    await appendSheetValues("ログ!A:D", [[userId, timestamp, state, text]]);
  } catch (err) {
    console.error("⚠ ログ記録エラー:", err);
  }

  // 共通キャンセル
  if (text === "キャンセル") {
    await clearTempData(userId);
    await setUserState(userId, STATE.通常);
    return client.replyMessage(event.replyToken, { type: "text", text: "入力を中止しました。" });
  }

  // 状態に応じて処理を振り分け
  const handler = stateHandlers[state] || stateHandlers[STATE.通常];
  await handler({ text, userId, replyToken: event.replyToken });
}

// ===== 状態別の処理（状態マシン） =====
const stateHandlers = {
  async [STATE.通常]({ text, userId, replyToken }) {
    if (text === "入力") return handleInputStart(userId, replyToken);
    if (text === "訂正") return handleCorrectionStart(userId, replyToken);
    if (text === "確認") {
      return client.replyMessage(replyToken, { type: "text", text: "（確認機能は準備中です）" });
    }
    return client.replyMessage(replyToken, {
      type: "text",
      text: "「入力」「訂正」「確認」のいずれかを送信してください。",
    });
  },

  async [STATE.入力確認中]({ text, userId, replyToken }) {
    if (text === "はい") {
      await setUserState(userId, STATE.入力中);
      return client.replyMessage(replyToken, { type: "text", text: "キャベツの残数を数字で入力してください。" });
    }
    if (text === "いいえ") {
      await setUserState(userId, STATE.通常);
      return client.replyMessage(replyToken, { type: "text", text: "入力を中止しました。" });
    }
    return client.replyMessage(replyToken, { type: "text", text: "「はい」または「いいえ」と送信してください。" });
  },

  async [STATE.入力中]({ text, userId, replyToken }) {
    if (isNaN(text)) {
      return client.replyMessage(replyToken, {
        type: "text",
        text: "数字のみで送信してください。\n入力をやめる場合は「キャンセル」と送信してください。",
      });
    }
    return handleInputFlow(userId, Number(text), replyToken);
  },

  async [STATE.登録確認中]({ text, userId, replyToken }) {
    if (text === "はい") return finalizeRecord(userId, replyToken);
    if (text === "いいえ") {
      await clearTempData(userId);
      await setUserState(userId, STATE.通常);
      return client.replyMessage(replyToken, { type: "text", text: "入力を中止しました。" });
    }
    return client.replyMessage(replyToken, { type: "text", text: "「はい」または「いいえ」と送信してください。" });
  },

  async [STATE.訂正確認中]({ text, userId, replyToken }) {
    if (text === "はい") {
      await setUserState(userId, STATE.訂正選択中);
      return client.replyMessage(replyToken, { type: "text", text: "訂正する材料を選んでください。（キャベツ／プリン／カレー）" });
    }
    if (text === "いいえ") {
      await setUserState(userId, STATE.通常);
      return client.replyMessage(replyToken, { type: "text", text: "訂正を中止しました。" });
    }
  },

  async [STATE.訂正選択中]({ text, userId, replyToken }) {
    if (["キャベツ", "プリン", "カレー"].includes(text)) {
      await recordTempData(userId, text);
      await setUserState(userId, STATE.訂正入力中);
      return client.replyMessage(replyToken, { type: "text", text: `${text}の残数を数字で入力してください。` });
    }
    return client.replyMessage(replyToken, {
      type: "text",
      text: "「キャベツ」「プリン」「カレー」のいずれかを送信してください。\n訂正をやめる場合は「キャンセル」と送信してください。",
    });
  },

  async [STATE.訂正入力中]({ text, userId, replyToken }) {
    if (isNaN(text)) {
      return client.replyMessage(replyToken, {
        type: "text",
        text: "数字のみで送信してください。\n訂正をやめる場合は「キャンセル」と送信してください。",
      });
    }
    const temp = await getTempData(userId);
    await recordTempData(userId, temp, Number(text));
    await setUserState(userId, STATE.訂正確認入力中);
    return client.replyMessage(replyToken, {
      type: "text",
      text: `${temp}の残数を${text}に訂正します。よろしいですか？（はい／いいえ）`,
    });
  },

  async [STATE.訂正確認入力中]({ text, userId, replyToken }) {
    const temp = await getTempData(userId);
    if (text === "はい") {
      await updateRecord(temp, userId);
      await setUserState(userId, STATE.通常);
      return client.replyMessage(replyToken, { type: "text", text: `${temp}の残数を訂正しました。` });
    }
    if (text === "いいえ") {
      await setUserState(userId, STATE.訂正選択中);
      return client.replyMessage(replyToken, {
        type: "text",
        text: "訂正をやり直します。訂正する材料を選んでください。（キャベツ／プリン／カレー）",
      });
    }
    return client.replyMessage(replyToken, { type: "text", text: "「はい」または「いいえ」と送信してください。" });
  },
};

// ===== 入力フロー（3商品入力 → 確認へ） =====
async function handleInputFlow(userId, quantity, replyToken) {
  const date = getJSTDateString();
  const rows = await getSheetValues("入力中!A:D");
  const todayRows = rows.filter(r => r[0] === userId && r[1] === date);

  const done = todayRows.map(r => r[2]);
  const all = ["キャベツ", "プリン", "カレー"];
  const remaining = all.filter(p => !done.includes(p));
  const currentProduct = remaining[0] || null;

  if (!currentProduct) {
    await client.replyMessage(replyToken, {
      type: "text",
      text: "３つすべての入力が完了しました。登録しますか？（はい／いいえ）",
    });
    await setUserState(userId, STATE.登録確認中);
    return;
  }

  await recordTempData(userId, currentProduct, quantity);

  const nextRemaining = all.filter(p => ![...done, currentProduct].includes(p));
  if (nextRemaining.length === 0) {
    await client.replyMessage(replyToken, {
      type: "text",
      text: "３つすべての入力が完了しました。登録しますか？（はい／いいえ）",
    });
    await setUserState(userId, STATE.登録確認中);
    return;
  }

  await client.replyMessage(replyToken, {
    type: "text",
    text: `${nextRemaining[0]}の残数を数字で入力してください。`,
  });
}

// ===== 発注記録の数量訂正 =====
async function updateRecord(product, userId) {
  const date = getJSTDateString();
  const rows = await getSheetValues("発注記録!A:F");
  const idx = rows.findIndex(r => r[0] === date && r[2] === product && r[5] === userId);
  if (idx === -1) return;

  const tempRows = await getSheetValues("入力中!A:D");
  const last = tempRows.reverse().find(r => r[0] === userId && r[2] === product);
  if (!last) return;

  rows[idx][3] = Number(last[3]);
  await updateSheetValues(`発注記録!A${idx + 1}:F${idx + 1}`, [rows[idx]]);
}

// ===== 今日の入力が全て済んでいるか確認 =====
async function isInputCompleteForToday(userId) {
  const date = getJSTDateString();
  const rows = await getSheetValues("発注記録!A:F");
  const todayRows = rows.filter(r => r[0] === date && r[5] === userId);
  const items = ["キャベツ", "プリン", "カレー"];

  return items.every(item => {
    const row = todayRows.find(r => r[2] === item);
    return row && (row[3] || row[4]);
  });
}

// ===== 入力中データ操作 =====
async function recordTempData(userId, product, quantity) {
  const date = getJSTDateString();
  await appendSheetValues("入力中!A:D", [[userId, date, product, quantity || ""]]);
}

async function getTempData(userId) {
  const rows = await getSheetValues("入力中!A:D");
  const today = getJSTDateString();
  const userRows = rows.filter(r => r[0] === userId && r[1] === today);
  return userRows.length > 0 ? userRows[userRows.length - 1][2] : null;
}

// ===== 状態管理（ユーザー状態保存・取得） =====
async function getUserState(userId) {
  const rows = await getSheetValues("状態!A:B");
  const row = rows.find(r => r[0] === userId);
  return row ? row[1] : STATE.通常;
}

async function setUserState(userId, state) {
  const rows = await getSheetValues("状態!A:B");
  const idx = rows.findIndex(r => r[0] === userId);
  if (idx >= 0) {
    await updateSheetValues(`状態!B${idx + 1}`, [[state]]);
  } else {
    await appendSheetValues("状態!A:B", [[userId, state]]);
  }
}

// ===== 入力中データ削除（完了orキャンセル時） =====
async function clearTempData(userId) {
  const rows = await getSheetValues("入力中!A:D");
  const remain = rows.filter(r => r[0] !== userId);
  await clearSheetValues("入力中!A:D");
  if (remain.length > 0) {
    await updateSheetValues("入力中!A:D", remain);
  }
}

// ===== 入力確定：発注記録への転記 + 発注数返信 =====
async function finalizeRecord(userId, replyToken) {
  const date = getJSTDateString();

  try {
    const tempRows = await getSheetValues("入力中!A:D");
    const todayRows = tempRows.filter(r => r[0] === userId && r[1] === date);
    if (todayRows.length < 3) {
      return client.replyMessage(replyToken, { type: "text", text: "3商品の入力が未完です。" });
    }

    const mainRows = await getSheetValues("発注記録!A:G");
    let rowNumber = mainRows.length + 1;
    const startRow = rowNumber;

    // ★ 各行の B/E/G は式で書き込む（スプシ側で自動計算）
    for (const [uid, d, product, qty] of todayRows) {
      const formulaB = `=IF(A${rowNumber}="","",TEXT(A${rowNumber},"ddd"))`;
      const formulaE = `=計算式...（略：必要なら後で分離可能）`;
      const formulaG = `=IF(F${rowNumber}="","",IF($C${rowNumber}="キャベツ",TEXT($A${rowNumber}+3,"ddd"),TEXT($A${rowNumber}+2,"ddd")))`;

      await updateSheetValues(`発注記録!A${rowNumber}:G${rowNumber}`, [
        [d, formulaB, product, qty, formulaE, uid, formulaG]
      ]);
      rowNumber++;
    }

    const results = await getSheetValues(`発注記録!A${startRow}:G${rowNumber - 1}`);
    const summary = results.map(r => `${r[2]}：${r[4]}個`).join("\n");

    await clearTempData(userId);
    await setUserState(userId, STATE.通常);

    await client.replyMessage(replyToken, {
      type: "text",
      text: `本日の発注内容を登録しました。\n\n${summary}`,
    });
  } catch (err) {
    console.error("❌ finalizeRecord エラー:", err);
    await client.replyMessage(replyToken, { type: "text", text: "登録中にエラーが発生しました。" });
  }
}

// ===== サーバー起動 =====
app.get("/", (req, res) => res.send("LINE Webhook server is running."));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
