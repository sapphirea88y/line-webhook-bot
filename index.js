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

// ===== JST日付関数 =====
function getJSTDateString() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, "0");
  const d = String(jst.getDate()).padStart(2, "0");
  return `${y}/${m}/${d}`; // ← スラッシュ区切り
}

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

// ===== メイン処理 =====
async function handleMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text.trim();
  const state = await getUserState(userId);

  console.log(`🗣 ${userId} (${state}) → ${text}`);

  // === 共通キャンセル ===
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

  // === 登録確認中 ===
if (state === "登録確認中") {
  if (text === "はい") {
    await finalizeRecord(userId, event.replyToken); // 登録処理を呼ぶ
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

  // === 訂正入力中 ===
  if (state === "訂正入力中") {
    if (isNaN(text)) {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "数字のみで送信してください。\n訂正をやめる場合は「キャンセル」と送信してください。",
      });
      return;
    }
    const temp = await getTempData(userId);
    await recordTempData(userId, temp, Number(text)); // 仮保存
    await setUserState(userId, "訂正確認入力中");
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `${temp}の残数を${text}に訂正します。よろしいですか？（はい／いいえ）`,
    });
    return;
  }

  // === 訂正確認入力中 ===
  if (state === "訂正確認入力中") {
    const temp = await getTempData(userId);
    if (text === "はい") {
      await updateRecord(temp, userId);
      await setUserState(userId, "通常");
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: `${temp}の残数を訂正しました。`,
      });
      return;
    }
    if (text === "いいえ") {
      await setUserState(userId, "訂正選択中");
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "訂正をやり直します。訂正する材料を選んでください。（キャベツ／プリン／カレー）",
      });
      return;
    }
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "「はい」または「いいえ」と送信してください。",
    });
    return;
  }
}

// ===== 入力開始 =====
async function handleInputStart(userId, replyToken) {
  const date = getJSTDateString();
  await setUserState(userId, "入力確認中");
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
    await setUserState(userId, "通常"); // 念のため戻す（通常状態）
    await client.replyMessage(replyToken, {
      type: "text",
      text: `${date}の入力が完了していません。まず「入力」から3商品を登録してください。`,
    });
    return;
  }

  // ここまで来たら訂正フローへ入る
  await setUserState(userId, "訂正確認中");
  await client.replyMessage(replyToken, {
    type: "text",
    text: `${date}日の入力を訂正しますか？（はい／いいえ）`,
  });
}

// ===== 入力中フロー =====
async function handleInputFlow(userId, quantity, replyToken) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tempSheet = "入力中";
  const date = getJSTDateString();

  // 現在のユーザーの入力状況を取得
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tempSheet}!A:D`,
  });
  const rows = res.data.values || [];
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
    await setUserState(userId, "登録確認中");
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
    await setUserState(userId, "登録確認中");
    return;
  }

  // 次の商品を質問
  await client.replyMessage(replyToken, {
    type: "text",
    text: `${nextRemaining[0]}の残数を数字で入力してください。`,
  });
}

// ===== 発注記録 上書き（発注数はスプシ側で計算） =====
async function updateRecord(product, userId) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const sheet = "発注記録";
  const date = getJSTDateString();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheet}!A:F`,
  });

  const rows = res.data.values || [];
  const idx = rows.findIndex((r) => r[0] === date && r[2] === product && r[5] === userId);
  if (idx === -1) {
    console.log("⚠ 該当行が見つかりません:", date, product, userId);
    return;
  }

  const tempRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "入力中!A:D",
  });
  const tempRows = tempRes.data.values || [];
  const last = tempRows.reverse().find((r) => r[0] === userId && r[2] === product);
  const newQty = last ? Number(last[3]) : null;
  if (newQty === null) {
    console.log("⚠ 新しい数量が見つかりません");
    return;
  }

  rows[idx][3] = newQty; // D列（残数）のみ上書き

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheet}!A${idx + 1}:F${idx + 1}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [rows[idx]] },
  });

  console.log(`✅ ${product} の残数を ${newQty} に訂正`);
}

// 当日の入力が3商品そろっているか確認（発注記録を参照）
async function isInputCompleteForToday(userId) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const sheet = "発注記録";
  const date = getJSTDateString(); // ← これが "YYYY/MM/DD" になる

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheet}!A:F`,
  });
  const rows = res.data.values || [];

  // 今日かつこのユーザーの行のみ抽出
  const todayRows = rows.filter(r => r[0] === date && r[5] === userId);

  // 3品（キャベツ/プリン/カレー）が全部あるか
  const required = ["キャベツ", "プリン", "カレー"];
  return required.every(p => todayRows.some(r => r[2] === p));
}

// ===== 一時データ操作 =====
async function recordTempData(userId, product, quantity) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const sheet = "入力中";
  const date = getJSTDateString();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheet}!A:D`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[userId, date, product, quantity || ""]] },
  });
}

async function getTempData(userId) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const sheet = "入力中";
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheet}!A:D`,
  });
  const rows = res.data.values || [];
  const today = getJSTDateString();
  const userRows = rows.filter((r) => r[0] === userId && r[1] === today);
  return userRows.length > 0 ? userRows[userRows.length - 1][2] : null;
}

// ===== 状態管理 =====
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

// ===== 仮データ削除 =====
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

// ===== finalizeRecord()（方法②：関数を上行からコピーする方式）=====
async function finalizeRecord(userId, replyToken) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tempSheet = "入力中";
  const mainSheet = "発注記録";
  const date = getJSTDateString(); // 例: "2025/10/19"

  try {
    // --- ① 入力中シートから今日分を取得 ---
    const tempRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tempSheet}!A:D`,
    });
    const tempRows = tempRes.data.values || [];
    const todayRows = tempRows.filter(r => r[0] === userId && r[1] === date);

    if (todayRows.length < 3) {
      await client.replyMessage(replyToken, {
        type: "text",
        text: "3商品の入力がまだ完了していません。",
      });
      return;
    }

    // --- ② 発注記録の現在行数を取得（追加開始位置を把握）---
    const mainRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${mainSheet}!A:A`,
    });
    const existingRowCount = (mainRes.data.values || []).length; // 現在の最終行番号

    // --- ③ A,C,D,F列（値が入る部分）だけ append ---
    let writeRow = existingRowCount + 1; // 1行目はヘッダと仮定
    const appendedRows = [];

    for (const r of todayRows) {
      const [u, d, product, qty] = r;
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${mainSheet}!A:F`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[date, "", product, qty, "", userId]], // B,E,Gはここでは空
        },
      });
      appendedRows.push(writeRow);
      writeRow++;
    }

    // --- ④ 追加した行に「ひとつ上の行」のB,E,G列の式をコピー ---
    const formulaRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${mainSheet}!A:G`,
    });
    const allRows = formulaRes.data.values || [];

    for (const rowNum of appendedRows) {
      if (rowNum > 2) {
        const prevB = allRows[rowNum - 2][1] || "";
        const prevE = allRows[rowNum - 2][4] || "";
        const prevG = allRows[rowNum - 2][6] || "";

        if (prevB || prevE || prevG) {
          await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${mainSheet}!B${rowNum}:G${rowNum}`,
            valueInputOption: "USER_ENTERED",
            requestBody: {
              values: [[
                prevB ? `=${prevB}` : "",
                "",
                "",
                "",
                prevE ? `=${prevE}` : "",
                prevG ? `=${prevG}` : ""
              ]],
            },
          });
        }
      }
    }

    // --- ⑤ 入力中シート削除 + 状態解除 ---
    await clearTempData(userId);
    await setUserState(userId, "通常");

    // --- ⑥ LINE通知（発注数はまだ未反映なので商品名のみ出すことも可能）---
    await client.replyMessage(replyToken, {
      type: "text",
      text: "本日の入力データを発注記録に登録しました（発注数・納品日はシート上で計算されます）。",
    });

    console.log("✅ finalizeRecord 完了（オートフィル方式）");

  } catch (err) {
    console.error("❌ finalizeRecord エラー:", err);
    await client.replyMessage(replyToken, {
      type: "text",
      text: "登録中にエラーが発生しました。",
    });
  }
}

// ===== サーバー起動 =====
app.get("/", (req, res) => res.send("LINE Webhook server is running."));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));








