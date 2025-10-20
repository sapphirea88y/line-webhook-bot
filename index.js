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

// "YYYY/MM/DD" 形式の文字列を返す
function getJSTDateString() {
  const jst = getJSTDate();
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, "0");
  const d = String(jst.getDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

// "YYYY-MM-DD HH:mm:ss"（ログ用）
function getJSTDateTimeString() {
  const jst = getJSTDate();
  return jst.toISOString().replace("T", " ").slice(0, 19);
}

// ===== Webhook =====
app.post("/webhook", middleware(LINE_CONFIG), async (req, res) => {
  const events = req.body.events;
  for (const event of events) {
    if (event.type === "message" && event.message.type === "text") {
      await handleMessage(event);
    }
  }
  res.sendStatus(200);
});



// ===== 状態定数 =====
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
    await client.replyMessage(event.replyToken, { type: "text", text: "入力を中止しました。" });
    return;
  }

  // 状態ディスパッチ
  const handler = stateHandlers[state] || stateHandlers[STATE.通常];
  await handler({
    text,
    userId,
    replyToken: event.replyToken,
  });
}


// ===== 入力開始 =====
async function handleInputStart(userId, replyToken) {
  const date = getJSTDateString();
  await setUserState(userId, STATE.入力確認中);
  await client.replyMessage(replyToken, {
    type: "text",
    text: `${date}日の入力を始めますか？（はい／いいえ）`,
  });
}

// ===== 訂正開始 =====
async function handleCorrectionStart(userId, replyToken) {
  const date = getJSTDateString();

  // ★追加：未入力（未確定）なら訂正に入らない
  const ok = await isInputCompleteForToday(userId);
  if (!ok) {
    await setUserState(userId, STATE.通常); // 念のため戻す（通常状態）
    await client.replyMessage(replyToken, {
      type: "text",
      text: `${date}の入力が完了していません。まず「入力」から3商品を登録してください。`,
    });
    return;
  }

  // ここまで来たら訂正フローへ入る
  await setUserState(userId, STATE.訂正確認中);
  await client.replyMessage(replyToken, {
    type: "text",
    text: `${date}日の入力を訂正しますか？（はい／いいえ）`,
  });
}
// ===== 状態別ハンドラ =====
const stateHandlers = {
  async [STATE.通常](ctx) {
    const { text, userId, replyToken } = ctx;
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

  async [STATE.入力確認中](ctx) {
    const { text, userId, replyToken } = ctx;
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

  async [STATE.入力中](ctx) {
    const { text, userId, replyToken } = ctx;
    if (isNaN(text)) {
      return client.replyMessage(replyToken, {
        type: "text",
        text: "数字のみで送信してください。\n入力をやめる場合は「キャンセル」と送信してください。",
      });
    }
    return handleInputFlow(userId, Number(text), replyToken);
  },

  async [STATE.登録確認中](ctx) {
    const { text, userId, replyToken } = ctx;
    if (text === "はい") return finalizeRecord(userId, replyToken);
    if (text === "いいえ") {
      await clearTempData(userId);
      await setUserState(userId, STATE.通常);
      return client.replyMessage(replyToken, { type: "text", text: "入力を中止しました。" });
    }
    return client.replyMessage(replyToken, { type: "text", text: "「はい」または「いいえ」と送信してください。" });
  },

  async [STATE.訂正確認中](ctx) {
    const { text, userId, replyToken } = ctx;
    if (text === "はい") {
      await setUserState(userId, STATE.訂正選択中);
      return client.replyMessage(replyToken, { type: "text", text: "訂正する材料を選んでください。（キャベツ／プリン／カレー）" });
    }
    if (text === "いいえ") {
      await setUserState(userId, STATE.通常);
      return client.replyMessage(replyToken, { type: "text", text: "訂正を中止しました。" });
    }
  },

  async [STATE.訂正選択中](ctx) {
    const { text, userId, replyToken } = ctx;
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

  async [STATE.訂正入力中](ctx) {
    const { text, userId, replyToken } = ctx;
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

  async [STATE.訂正確認入力中](ctx) {
    const { text, userId, replyToken } = ctx;
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


// ===== 入力中フロー =====
async function handleInputFlow(userId, quantity, replyToken) {
  const date = getJSTDateString();

  // 現在のユーザーの入力状況を取得
  const rows = await getSheetValues("入力中!A:D");
  const todayRows = rows.filter(r => r[0] === userId && r[1] === date);

  // 入力済みの商品名を列挙
  const done = todayRows.map(r => r[2]);
  const all = ["キャベツ", "プリン", "カレー"];

  // まだのものを抽出
  const remaining = all.filter(p => !done.includes(p));

  // 現在入力している商品
  const currentProduct = remaining.length === 0 ? null : remaining[0];
  if (!currentProduct) {
    await client.replyMessage(replyToken, {
      type: "text",
      text: "３つすべての入力が完了しました。登録しますか？（はい／いいえ）",
    });
    await setUserState(userId, STATE.登録確認中);
    return;
  }

  // 現在の商品を登録
  await recordTempData(userId, currentProduct, quantity);

  // 次に聞く商品を決定
  const nextRemaining = all.filter(p => ![...done, currentProduct].includes(p));
  if (nextRemaining.length === 0) {
    await client.replyMessage(replyToken, {
      type: "text",
      text: "３つすべての入力が完了しました。登録しますか？（はい／いいえ）",
    });
    await setUserState(userId, STATE.登録確認中);
    return;
  }

  // 次の商品を質問
  await client.replyMessage(replyToken, {
    type: "text",
    text: `${nextRemaining[0]}の残数を数字で入力してください。`,
  });
}

// ===== 発注記録 上書き =====
async function updateRecord(product, userId) {
  const date = getJSTDateString();

  // 発注記録の全データ取得
  const rows = await getSheetValues("発注記録!A:F");

  // 今日 & 商品 & ユーザーが一致する行を探す
  const idx = rows.findIndex((r) => r[0] === date && r[2] === product && r[5] === userId);
  if (idx === -1) {
    console.log("⚠ 該当行が見つかりません:", date, product, userId);
    return;
  }

  // 入力中シートから、該当商品の最新値を取得
  const tempRows = await getSheetValues("入力中!A:D");
  const last = tempRows.reverse().find((r) => r[0] === userId && r[2] === product);
  const newQty = last ? Number(last[3]) : null;
  if (newQty === null) {
    console.log("⚠ 新しい数量が見つかりません");
    return;
  }

  // D列（残数）のみ上書き
  rows[idx][3] = newQty;

  // 更新（対象行だけ更新）
  await updateSheetValues(`発注記録!A${idx + 1}:F${idx + 1}`, [rows[idx]]);

  console.log(`✅ ${product} の残数を ${newQty} に訂正`);
}


// ✅ 今日分の入力（3商品すべて）が完了しているか判定
async function isInputCompleteForToday(userId) {
  const date = getJSTDateString();
  
  // 発注記録シートの取得
  const rows = await getSheetValues("発注記録!A:F");

  // 今日 & このユーザーの行だけフィルタ
  const todayRows = rows.filter((r) => r[0] === date && r[5] === userId);

  // 必要な商品
  const items = ["キャベツ", "プリン", "カレー"];

  // 各商品が存在し、D列 or E列に値があるならOK
  return items.every((item) => {
    const row = todayRows.find((r) => r[2] === item);
    if (!row) return false;
    const qty = row[3];     // 残数
    const order = row[4];   // 発注数
    return (qty !== "" && qty !== undefined) || (order !== "" && order !== undefined);
  });
}

// ===== 一時データ操作 =====
async function recordTempData(userId, product, quantity) {
  const date = getJSTDateString();
  await appendSheetValues("入力中!A:D", [
      [userId, date, product, quantity || ""],
    ]);
}

async function getTempData(userId) {
  const rows = await getSheetValues("入力中!A:D");
  const today = getJSTDateString();
  const userRows = rows.filter((r) => r[0] === userId && r[1] === today);
  return userRows.length > 0 ? userRows[userRows.length - 1][2] : null;
}

// ===== 状態管理 =====
async function getUserState(userId) {
  const rows = await getSheetValues("状態!A:B");
  const row = rows.find((r) => r[0] === userId);
  return row ? row[1] : STATE.通常;
}

async function setUserState(userId, state) {
  const rows = await getSheetValues("状態!A:B");
  const idx = rows.findIndex((r) => r[0] === userId);
  if (idx >= 0) {
    await updateSheetValues(`状態!B${idx + 1}`, [[state]]);
  } else {
    await appendSheetValues("状態!A:B", [[userId, state]]);
  }
}

// ===== 仮データ削除 =====
async function clearTempData(userId) {
  const rows = await getSheetValues("入力中!A:D");
  const remain = rows.filter((r) => r[0] !== userId);
  await clearSheetValues("入力中!A:D");
  if (remain.length > 0) {
    await updateSheetValues("入力中!A:D", remain);
  }
}

// ===== finalizeRecord: 発注記録に転記 + 発注数を返信 =====
async function finalizeRecord(userId, replyToken) {
  const date = getJSTDateString();

  try {
    // ① 入力中データ取得
    const tempRows = await getSheetValues("入力中!A:D");
    const todayRows = tempRows.filter(r => r[0] === userId && r[1] === date);
    if (todayRows.length < 3) {
      return client.replyMessage(replyToken, { type: "text", text: "3商品の入力が完了していません。" });
    }

    // ② 書き込む開始行を取得
    const mainRows = await getSheetValues("発注記録!A:G");
    let rowNumber = mainRows.length + 1;
    const startRow = rowNumber;

    // ③ A〜G列への書き込みを共通関数で（1商品ごと）
    for (const [uid, d, product, qty] of todayRows) {
      const formulaB = `=IF(A${rowNumber}="","",TEXT(A${rowNumber},"ddd"))`;
      const formulaE = `=IF(
        $A${rowNumber} = "",
        "",
        IF(
          INDEX('発注条件'!$C:$C, MATCH(1, ('発注条件'!$A:$A = $C${rowNumber}) * ('発注条件'!$B:$B = $B${rowNumber}), 0)) = "×",
          "0",
          MAX(
            0,
            INDEX('発注条件'!$D:$D, MATCH(1, ('発注条件'!$A:$A = $C${rowNumber}) * ('発注条件'!$B:$B = $G${rowNumber}), 0))
            - $D${rowNumber}
            + INDEX('発注条件'!$G:$G, MATCH(1, ('発注条件'!$A:$A = $C${rowNumber}) * ('発注条件'!$B:$B = $B${rowNumber}), 0))
            - IF(
                $C${rowNumber} = "キャベツ",
                INDEX($E:$E, ROW()-3) + INDEX($E:$E, ROW()-6),
                INDEX($E:$E, ROW()-3)
              )
          )
        )
      )`;
      const formulaG = `=IF(F${rowNumber}="","",IF($C${rowNumber}="キャベツ",TEXT($A${rowNumber}+3,"ddd"),TEXT($A${rowNumber}+2,"ddd")))`;

      await updateSheetValues(`発注記録!A${rowNumber}:G${rowNumber}`, [[
        d, formulaB, product, qty, formulaE, uid, formulaG
      ]]);
      rowNumber++;
    }

    // ④ 書き込んだ結果を読み込み→LINEへ返信
    const endRow = rowNumber - 1;
    const results = await getSheetValues(`発注記録!A${startRow}:G${endRow}`);
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

