// ===== 初期設定と定数 =====
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

const app = express();
const client = new Client(LINE_CONFIG);

// ===== Google Sheets操作 共通関数 =====
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;

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

// ===== JST関連ユーティリティ =====
function getJSTDate() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

// "YYYY/MM/DD" 形式の文字列
function getJSTDateString() {
  const jst = getJSTDate();
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, '0');
  const d = String(jst.getDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

// "YYYY-MM-DD HH:mm:ss"（ログ用）
function getJSTDateTimeString() {
  const jst = getJSTDate();
  return jst.toISOString().replace('T', ' ').slice(0, 19);
}

// ===== Webhook =====
app.post('/webhook', middleware(LINE_CONFIG), async (req, res) => {
  const events = req.body.events;
  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      await handleMessage(event);
    }
  }
  res.sendStatus(200);
});

// ======== 確認メッセージを生成するだけの関数 ========
async function generateConfirmText(userId) {
  const date = getTargetDateString();
  const sheetName = "発注記録";
  const rows = await getSheetValues(`${sheetName}!A:G`);
  const userRows = rows.filter(r => r[0] === date);

  if (userRows.length === 0) {
    return `${date}の記録は見つかりませんでした。`;
  }

  let inputPart = "===入力数===\n";
  let orderPart = "===発注数===\n";

  for (const r of userRows) {
    const item = (r[2] || "").padEnd(4, "　");
    inputPart += `${item}：${r[3] || 0}\n`;
    orderPart += `${item}：${r[4] || 0}\n`;
  }

  return `${date}\n${inputPart}${orderPart}===========`;
}


// ===== 状態定数 =====
const STATE = {
  通常: '通常',
  入力確認中: '入力確認中',
  入力中: '入力中',
  入力上書き確認中: '入力上書き確認中',
  登録確認中: '登録確認中',
  訂正確認中: '訂正確認中',
  訂正選択中: '訂正選択中',
  訂正入力中: '訂正入力中',
  訂正確認入力中: '訂正確認入力中',
  訂正種類選択中: '訂正種類選択中',   // 入力 or 発注
  発注訂正確認中: '発注訂正確認中',   // 発注訂正開始の yes/no
  発注訂正選択中: '発注訂正選択中',   // 材料選択
  発注訂正入力中: '発注訂正入力中',   // 数値入力
  発注訂正確認入力中: '発注訂正確認入力中', // yes/no 確認

};

// ===== メイン処理（ディスパッチ版） =====
async function handleMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text.trim();
  const state = await getUserState(userId);

  // ログ記録
  const timestamp = getJSTDateTimeString();
  try {
    await appendSheetValues("ログ!A:D", [[userId, timestamp, state, text]]);
    console.log(`📝 Log saved: ${userId}, ${timestamp}, ${state}, ${text}`);
  } catch (err) {
    console.error("⚠ ログ記録エラー:", err);
  }
  console.log(`🗣 ${userId} (${state}) → ${text}`);

  // 共通キャンセル
  if (text === "キャンセル") {
    await clearTempData(userId);
    await setUserState(userId, STATE.通常);
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "入力を中止しました。",
    });
    return;
  }

  // 状態ディスパッチ
  const handler = stateHandlers[state] || stateHandlers[STATE.通常];
  await handler({ text, userId, replyToken: event.replyToken });
}

// ===== 入力開始 =====
async function handleInputStart(userId, replyToken) {
  const date = getTargetDateString();

  // そのユーザー・日付の既存行を確認
  const rows = await getSheetValues("発注記録!A:F");
  const exists = rows.some(r => r[0] === date);

  if (exists) {
    await setUserState(userId, STATE.入力上書き確認中);
    return client.replyMessage(replyToken, {
      type: "text",
      text: `${date}は既に入力されていますが、再度入力して上書きしますか？（はい／いいえ）`,
    });
  }

  await setUserState(userId, STATE.入力確認中);
  await client.replyMessage(replyToken, {
    type: "text",
    text: `${date}日の入力を始めますか？（はい／いいえ）`,
  });
}


// ===== 訂正開始 =====
async function handleCorrectionStart(userId, replyToken) {
  const now = getJSTDate();
  const targetDate = getTargetDateString(); // 11時前なら前日、以降なら当日
  let note = "";

  if (now.getHours() < 11) {
    note = "\n※昨日分の入力と発注の訂正です。";
  } else {
    note = `\n※${targetDate}分の入力と発注の訂正です。`;
  }

  await setUserState(userId, STATE.訂正種類選択中);
  await client.replyMessage(replyToken, {
    type: "text",
    text: `入力数と発注数どちらを訂正しますか？（入力／発注）${note}`,
  });
}



// ===== 状態別ハンドラ一覧 =====
const stateHandlers = {
  // --- 通常 ---
  async [STATE.通常]({ text, userId, replyToken }) {
    if (text === "入力") return handleInputStart(userId, replyToken);
    if (text === "訂正") return handleCorrectionStart(userId, replyToken);
    if (text === "確認") return handleConfirmRequest(userId, replyToken);

    return client.replyMessage(replyToken, {
      type: "text",
      text: "「入力」「訂正」「確認」のいずれかを送信してください。\n発注だけ変更した際も「訂正」から登録してください。",
    });
  },

  // --- 入力確認中 ---
  async [STATE.入力確認中]({ text, userId, replyToken }) {
    if (text === "はい") {
      await setUserState(userId, STATE.入力中);
      return client.replyMessage(replyToken, {
        type: "text",
        text: "キャベツの残数を数字で入力してください。",
      });
    }
    if (text === "いいえ") {
      await setUserState(userId, STATE.通常);
      return client.replyMessage(replyToken, {
        type: "text",
        text: "入力を中止しました。",
      });
    }
    return client.replyMessage(replyToken, {
      type: "text",
      text: "「はい」または「いいえ」と送信してください。",
    });
  },

  async [STATE.入力上書き確認中]({ text, userId, replyToken }) {
  const date = getTargetDateString();
  if (text === "はい") {
    const allRows = await getSheetValues("発注記録!A:G");
    const beforeRows = allRows.filter(r => r[0] === date);

  try {
    await clearSheetValues("'一時'!A:G");
    if (beforeRows.length > 0) {
      const endRow = beforeRows.length;
      await updateSheetValues(`'一時'!A1:G${endRow}`, beforeRows.map(r => [...r]));
    }
  } catch (e) {
    console.warn("一時シートへのバックアップでエラー（存在しない？）:", e.message);
  }

  await clearTempData(userId);
  await deleteUserRecordsForDate(userId, date);
  await setUserState(userId, STATE.入力中);
  return client.replyMessage(replyToken, {
    type: "text",
    text: `${date}の既存データを削除しました。\nキャベツの残数を数字で入力してください。`,
  });
}

  if (text === "いいえ") {
    await setUserState(userId, STATE.通常);
    return client.replyMessage(replyToken, {
      type: "text",
      text: "入力を中止しました。",
    });
  }
  return client.replyMessage(replyToken, {
    type: "text",
    text: "「はい」または「いいえ」と送信してください。",
  });
},

  // --- 入力中（数字受け取り） ---
  async [STATE.入力中]({ text, userId, replyToken }) {
    if (isNaN(text)) {
      return client.replyMessage(replyToken, {
        type: "text",
        text: "数字のみで送信してください。\n入力をやめる場合は「キャンセル」と送信してください。",
      });
    }
    return handleInputFlow(userId, Number(text), replyToken);
  },

  // --- 登録確認中（3商品入力完了後） ---
  async [STATE.登録確認中]({ text, userId, replyToken }) {
    if (text === "はい") return finalizeRecord(userId, replyToken);
    if (text === "いいえ") {
      await clearTempData(userId);
      await setUserState(userId, STATE.通常);
      return client.replyMessage(replyToken, {
        type: "text",
        text: "入力を中止しました。",
      });
    }
    return client.replyMessage(replyToken, {
      type: "text",
      text: "「はい」または「いいえ」と送信してください。",
    });
  },

  // --- 訂正種類選択中 ---
async [STATE.訂正種類選択中]({ text, userId, replyToken }) {
  if (text === "入力") {
    // 入力訂正ルートへ
    const date = getTargetDateString();
    const ok = await isInputCompleteForToday(userId);
    if (!ok) {
      await setUserState(userId, STATE.通常);
      return client.replyMessage(replyToken, {
        type: "text",
        text: `${date}の入力が完了していません。まず「入力」から3商品を登録してください。`,
      });
    }
    await setUserState(userId, STATE.訂正確認中);
    return client.replyMessage(replyToken, {
      type: "text",
      text: `${date}日の入力を訂正しますか？（はい／いいえ）`,
    });
  }

  if (text === "発注") {
    // 発注訂正ルートへ
    const date = getTargetDateString();
    const rows = await getSheetValues("発注記録!A:F");
    const exists = rows.some(r => r[0] === date);
    if (!exists) {
      await setUserState(userId, STATE.通常);
      return client.replyMessage(replyToken, {
        type: "text",
        text: `${date}の発注記録はまだありません。`,
      });
    }
    await setUserState(userId, STATE.発注訂正確認中);
    return client.replyMessage(replyToken, {
      type: "text",
      text: `${date}の発注数を訂正しますか？（はい／いいえ）`,
    });
  }

  return client.replyMessage(replyToken, {
    type: "text",
    text: "「入力」または「発注」と送信してください。",
  });
},


  // --- 訂正確認中（訂正に進むか） ---
  async [STATE.訂正確認中]({ text, userId, replyToken }) {
    if (text === "はい") {
      await setUserState(userId, STATE.訂正選択中);
      return client.replyMessage(replyToken, {
        type: "text",
        text: "訂正する材料を選んでください。（キャベツ／プリン／カレー）",
      });
    }
    if (text === "いいえ") {
      await setUserState(userId, STATE.通常);
      return client.replyMessage(replyToken, {
        type: "text",
        text: "訂正を中止しました。",
      });
    }
    return client.replyMessage(replyToken, {
      type: "text",
      text: "「はい」または「いいえ」と送信してください。",
    });
  },

  // --- 訂正選択中（材料選択） ---
  async [STATE.訂正選択中]({ text, userId, replyToken }) {
    if (["キャベツ", "プリン", "カレー"].includes(text)) {
      await recordTempData(userId, text);
      await setUserState(userId, STATE.訂正入力中);
      return client.replyMessage(replyToken, {
        type: "text",
        text: `${text}の残数を数字で入力してください。`,
      });
    }
    return client.replyMessage(replyToken, {
      type: "text",
      text: "「キャベツ」「プリン」「カレー」のいずれかを送信してください。\n訂正をやめる場合は「キャンセル」と送信してください。",
    });
  },

  // --- 訂正入力中（残数入力） ---
  async [STATE.訂正入力中]({ text, userId, replyToken }) {
    if (isNaN(text)) {
      return client.replyMessage(replyToken, {
        type: "text",
        text: "数字のみで送信してください。\n訂正をやめる場合は「キャンセル」と送信してください。",
      });
    }
    const product = await getTempData(userId);
    await recordTempData(userId, product, Number(text));
    await setUserState(userId, STATE.訂正確認入力中);

    return client.replyMessage(replyToken, {
      type: "text",
      text: `${product}の残数を${text}に訂正します。よろしいですか？（はい／いいえ）`,
    });
  },

// --- 訂正確認入力中（確定 or やり直し） ---
async [STATE.訂正確認入力中]({ text, userId, replyToken }) {
  const product = await getTempData(userId);

  if (text === "はい") {
  await updateRecord(product, userId);     // 発注記録の更新

  // ここで新しい発注数を取得して返信文に含める
  const date = getTargetDateString();
  const rows = await getSheetValues("発注記録!A:F");
  const row = rows.find(r => r[0] === date && r[2] === product);
  const newOrder = row ? row[4] || 0 : 0;

  await clearTempData(userId);
  await setUserState(userId, STATE.通常);

  return client.replyMessage(replyToken, {
    type: "text",
    text: `${product}の残数を訂正しました。\n新しい発注数は${newOrder}です。`,
  });
}

  if (text === "いいえ") {
    // ※この場合はまだ続けるため、入力中シートは消さない
    await setUserState(userId, STATE.訂正選択中);
    return client.replyMessage(replyToken, {
      type: "text",
      text: "訂正をやり直します。訂正する材料を選んでください。（キャベツ／プリン／カレー）",
    });
  }

  // ✅ その他（不正な入力）
  return client.replyMessage(replyToken, {
    type: "text",
    text: "「はい」または「いいえ」と送信してください。",
  });
},

  // --- 発注訂正確認中 ---
async [STATE.発注訂正確認中]({ text, userId, replyToken }) {
  if (text === "はい") {
    await setUserState(userId, STATE.発注訂正選択中);
    return client.replyMessage(replyToken, {
      type: "text",
      text: "訂正する材料を選んでください。（キャベツ／プリン／カレー）",
    });
  }
  if (text === "いいえ") {
    await setUserState(userId, STATE.通常);
    return client.replyMessage(replyToken, {
      type: "text",
      text: "訂正を中止しました。",
    });
  }
  return client.replyMessage(replyToken, {
    type: "text",
    text: "「はい」または「いいえ」と送信してください。",
  });
},

// --- 発注訂正選択中 ---
async [STATE.発注訂正選択中]({ text, userId, replyToken }) {
  if (["キャベツ", "プリン", "カレー"].includes(text)) {
    const date = getTargetDateString();
    const rows = await getSheetValues("発注記録!A:F");
    const row = rows.find(r => r[0] === date && r[2] === text);
    const current = row ? row[4] || 0 : 0;
    await recordTempData(userId, text);
    await setUserState(userId, STATE.発注訂正入力中);
    return client.replyMessage(replyToken, {
      type: "text",
      text: `${text}の現在の発注数は${current}です。\n訂正する数を入力してください。`,
    });
  }
  return client.replyMessage(replyToken, {
    type: "text",
    text: "「キャベツ」「プリン」「カレー」のいずれかを送信してください。",
  });
},

// --- 発注訂正入力中 ---
async [STATE.発注訂正入力中]({ text, userId, replyToken }) {
  if (isNaN(text)) {
    return client.replyMessage(replyToken, {
      type: "text",
      text: "数字のみで送信してください。",
    });
  }
  const product = await getTempData(userId);
  await recordTempData(userId, product, Number(text));
  await setUserState(userId, STATE.発注訂正確認入力中);
  return client.replyMessage(replyToken, {
    type: "text",
    text: `${product}の発注数を${text}に訂正します。よろしいですか？（はい／いいえ）`,
  });
},

// --- 発注訂正確認入力中 ---
async [STATE.発注訂正確認入力中]({ text, userId, replyToken }) {
  const product = await getTempData(userId);
  if (text === "はい") {
    await updateOrderQuantity(product, userId);
    await clearTempData(userId);
    await setUserState(userId, STATE.通常);
    return client.replyMessage(replyToken, {
      type: "text",
      text: `${product}の発注数を訂正しました。`,
    });
  }
  if (text === "いいえ") {
    await setUserState(userId, STATE.発注訂正選択中);
    return client.replyMessage(replyToken, {
      type: "text",
      text: "訂正をやり直します。訂正する材料を選んでください。（キャベツ／プリン／カレー）",
    });
  }
  return client.replyMessage(replyToken, {
    type: "text",
    text: "「はい」または「いいえ」と送信してください。",
  });
},

};  


// --- 入力フロー（3商品の順番入力） ---
async function handleInputFlow(userId, quantity, replyToken) {
  const date = getTargetDateString();
  const rows = await getSheetValues("入力中!A:D");
  const todayRows = rows.filter(r => r[0] === userId && r[1] === date);

  const all = ["キャベツ", "プリン", "カレー"];
  const done = todayRows.map(r => r[2]);
  const remaining = all.filter(item => !done.includes(item));

  // 今入力すべき商品を取得
  const currentProduct = remaining.length > 0 ? remaining[0] : null;

  if (!currentProduct) {
    // 全部入力済み
    await setUserState(userId, STATE.登録確認中);
    return client.replyMessage(replyToken, {
      type: "text",
      text: "３つすべての入力が完了しました。登録しますか？（はい／いいえ）",
    });
  }

  // 現在の商品を記録
  await recordTempData(userId, currentProduct, quantity);

  // 残りリストを再計算
  const updatedRows = await getSheetValues("入力中!A:D");
  const updatedTodayRows = updatedRows.filter(r => r[0] === userId && r[1] === date);
  const doneNow = updatedTodayRows.map(r => r[2]);
  const nextRemaining = all.filter(item => !doneNow.includes(item));

  if (nextRemaining.length === 0) {
    await setUserState(userId, STATE.登録確認中);
    return client.replyMessage(replyToken, {
      type: "text",
      text: "３つすべての入力が完了しました。登録しますか？（はい／いいえ）",
    });
  }

  await client.replyMessage(replyToken, {
    type: "text",
    text: `${nextRemaining[0]}の残数を数字で入力してください。`,
  });
}

// --- 記録の訂正（発注記録のD列を上書き） ---
async function updateRecord(product, userId) {
  const date = getTargetDateString();
  const rows = await getSheetValues("発注記録!A:F");
  const idx = rows.findIndex(r => r[0] === date && r[2] === product);
  if (idx === -1) {
    console.log("⚠ 該当行が見つかりません:", date, product, userId);
    return;
  }

  const tempRows = await getSheetValues("入力中!A:D");
  const last = tempRows.reverse().find(r => r[0] === userId && r[2] === product);
  const newQty = last ? Number(last[3]) : null;
  if (newQty === null) {
    console.log("⚠ 新しい数量が見つかりません");
    return;
  }

  rows[idx][3] = newQty;
  await updateSheetValues(`発注記録!D${idx + 1}`, [[newQty]]);

  console.log(`✅ ${product} の残数を ${newQty} に訂正しました`);
}

// --- 発注数の訂正（発注記録のE列を上書き） ---
async function updateOrderQuantity(product, userId) {
  const date = getTargetDateString();
  const rows = await getSheetValues("発注記録!A:F");
  const idx = rows.findIndex(r => r[0] === date && r[2] === product);
  if (idx === -1) {
    console.log("⚠ 該当行が見つかりません:", date, product, userId);
    return;
  }

  const tempRows = await getSheetValues("入力中!A:D");
  const last = tempRows.reverse().find(r => r[0] === userId && r[2] === product);
  const newQty = last ? Number(last[3]) : null;
  if (newQty === null) {
    console.log("⚠ 新しい発注数が見つかりません");
    return;
  }

  rows[idx][4] = newQty;
  await updateSheetValues(`発注記録!E${idx + 1}`, [[rows[idx][4]]]);
  console.log(`✅ ${product} の発注数を ${newQty} に訂正しました`);
}


// --- 今日の3商品がすべて入力済みか判定 ---
async function isInputCompleteForToday(userId) {
  const date = getTargetDateString(); // "2025/10/20"
  const rows = await getSheetValues("発注記録!A:F");

  const todayRows = rows.filter(r => {
    const sheetDate = typeof r[0] === 'string'
      ? r[0]
      : new Date(r[0]).toISOString().slice(0, 10).replace(/-/g, '/'); // "YYYY/MM/DD" に統一

    return sheetDate === date && r[5] === userId;
  });

  const items = ["キャベツ", "プリン", "カレー"];
  return items.every(item => todayRows.some(r => r[2] === item));
}

// ===== 対象日取得（午前11時前は前日） =====
function getTargetDateString() {
  const now = getJSTDate();
  if (now.getHours() < 11) {
    now.setDate(now.getDate() - 1);
  }
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

// ===== 確認機能 =====
async function handleConfirmRequest(userId, replyToken) {
  const confirmText = await generateConfirmText(userId);

  return client.replyMessage(replyToken, {
    type: "text",
    text: confirmText,
  });
}

// ===== 一時データ操作 =====
async function recordTempData(userId, product, quantity) {
  const date = getTargetDateString();
  await appendSheetValues("入力中!A:D", [
    [userId, date, product, quantity ??  ""],
  ]);
}

async function getTempData(userId) {
  const rows = await getSheetValues("入力中!A:D");
  const today = getTargetDateString();
  const userRows = rows.filter(r => r[0] === userId && r[1] === today);
  return userRows.length > 0 ? userRows[userRows.length - 1][2] : null;
}

// ===== 状態管理 =====
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

// ===== 仮データ削除 =====
async function clearTempData(userId) {
  const rows = await getSheetValues("入力中!A:D");
  const remain = rows.filter(r => r[0] !== userId);
  await clearSheetValues("入力中!A:D");
  if (remain.length > 0) {
    await updateSheetValues("入力中!A:D", remain.map(r => [...r]));
  }
}

// --- 特定ユーザー・日付の行を削除 ---
async function deleteUserRecordsForDate(userId, date) {
  const rows = await getSheetValues("発注記録!A:G");
  const remain = rows.filter(r => r[0] !== date);

  await clearSheetValues("発注記録!A:G");
  if (remain.length > 0) {
    await updateSheetValues("発注記録!A:G", remain.map(r => [...r]));
  }
  console.log(`🗑 ${date} の ${userId} の記録を削除しました`);
}

async function finalizeRecord(userId, replyToken) {
  const date = getTargetDateString();
  try {
    // ===== 再入力で上書きする前の発注数チェック =====
  const beforeRows = (await getSheetValues("'一時'!A:G")) || [];

    // 「E列」が数値で、関数ではない行を抽出（= 手入力で上書きされた発注数）
    const restoredList = beforeRows
      .filter(r => r[0] === date && r[4] && !String(r[4]).startsWith('='))
      .map(r => `${r[2]}：${r[4]} → 関数に戻しました`);

      let restoredText = "";
      if (restoredList.length > 0) {
      restoredText = `（以下の発注数を元に戻しました）\n${restoredList.join("\n")}\n\n`;
    }

    const tempRows = await getSheetValues("入力中!A:D");
    const todayRows = tempRows.filter(r => r[0] === userId && r[1] === date);

    if (todayRows.length < 3) {
      await client.replyMessage(replyToken, { type: "text", text: "3商品の入力が完了していません。" });
      return;
    }

    const mainRows = await getSheetValues("発注記録!A:G");
    let rowNumber = mainRows.length + 1;

    for (const [uid, _d, product, qty] of todayRows) {
      const formulaB = `=IF(A${rowNumber}="","",TEXT(A${rowNumber},"ddd"))`;
      const formulaE = `=IF(
        $A${rowNumber}="",
        "",
        IF(
          INDEX('発注条件'!$C:$C,
            MATCH(1,('発注条件'!$A:$A=$C${rowNumber})*('発注条件'!$B:$B=$B${rowNumber}),0)
          )="×",
          "0",
          MAX(
            0,
            INDEX('発注条件'!$D:$D,
              MATCH(1,('発注条件'!$A:$A=$C${rowNumber})*('発注条件'!$B:$B=$G${rowNumber}),0)
            )
            - $D${rowNumber}
            + INDEX('発注条件'!$G:$G,
              MATCH(1,('発注条件'!$A:$A=$C${rowNumber})*('発注条件'!$B:$B=$B${rowNumber}),0)
            )
            - IF(
                $C${rowNumber}="キャベツ",
                INDEX($E:$E,ROW()-3)+INDEX($E:$E,ROW()-6),
                INDEX($E:$E,ROW()-3)
              )
          )
        )
      )`;
      const formulaG = `=IF(F${rowNumber}="","",IF($C${rowNumber}="キャベツ",TEXT($A${rowNumber}+3,"ddd"),TEXT($A${rowNumber}+2,"ddd")))`;

      const rowData = [
        date,        // A
        formulaB,   // B
        product,    // C
        qty,        // D
        formulaE,   // E
        uid,        // F
        formulaG    // G
      ];

      await updateSheetValues(`発注記録!A${rowNumber}:G${rowNumber}`, [rowData]);
      rowNumber++;
    }

    const summary = todayRows.map(([, , product, qty]) => `${product}：${qty}個`).join("\n");
    await clearTempData(userId);
    await setUserState(userId, STATE.通常);
    const confirmText = await generateConfirmText(userId);
    await client.replyMessage(replyToken, {
      type: "text",
      text: `${restoredText}本日の発注内容を登録しました。\n\n${summary}\n\n${confirmText}`,
    });
  } catch (err) {
    console.error("❌ finalizeRecord エラー:", err);
    await client.replyMessage(replyToken, { type: "text", text: "登録中にエラーが発生しました。" });
  }

  await clearSheetValues("'一時'!A:G");
}

// ===== サーバー起動 =====
app.get("/", (req, res) => res.send("LINE Webhook server is running."));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));










