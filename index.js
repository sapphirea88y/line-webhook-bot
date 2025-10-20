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

// ✅ 発注記録シートに「今日分の3商品すべて」があり、かつ残数 or 発注数が空じゃない（または "-"）なら「入力済み」と判定
async function isInputCompleteForToday(userId) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const sheet = "発注記録";
  const date = getJSTDateString(); // "YYYY/MM/DD"

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheet}!A:F`,
  });
  const rows = res.data.values || [];

  // 今日 & このユーザーの行を取得
  const todayRows = rows.filter((r) => r[0] === date && r[5] === userId);

  // 確認すべき商品
  const items = ["キャベツ", "プリン", "カレー"];

  // 各商品について「残数 or 発注数のどちらかが入力されている（または"-"）」ならOK
  return items.every((item) => {
    const row = todayRows.find((r) => r[2] === item);
    if (!row) return false; // 商品そのものがない

    const qty = row[3];     // D列：残数
    const order = row[4];   // E列：発注数

    // 発注不可日 "-" も「入力済み」と見なす
    return (qty !== "" && qty !== undefined) || (order !== "" && order !== undefined);
  });
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

// ===== finalizeRecord: 発注記録に転記 + 発注数を返信 =====
async function finalizeRecord(userId, replyToken) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tempSheet = "入力中";
  const mainSheet = "発注記録";
  const date = getJSTDateString();

  try {
    // --- 入力中データ（今日+ユーザー）抽出 ---
    const tempRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tempSheet}!A:D`,
    });
    const tempRows = tempRes.data.values || [];
    const todayRows = tempRows.filter(r => r[0] === userId && r[1] === date);
    if (todayRows.length < 3) {
      await client.replyMessage(replyToken, {
        type: "text",
        text: "3商品の入力が完了していません。",
      });
      return;
    }

    // --- 発注記録シートの次の行番号（rowNumber）取得 ---
    const mainRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${mainSheet}!A:G`,
    });
    const mainRows = mainRes.data.values || [];
    let rowNumber = mainRows.length + 1;
    const startRow = rowNumber; // ← 後で読み返すときの開始位置に使う

    // --- 1商品ずつA～G列を書き込む（B/E/Gは関数） ---
    for (const [uid, d, product, qty] of todayRows) {
      // B列（曜日）例: =TEXT(A9,"ddd")
      const formulaB = `=IF(A${rowNumber}="","",TEXT(A${rowNumber},"ddd"))`;

      // E列（発注数）→ あなたが指定した式を rowNumber に対応させる
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
                INDEX($E:$E, ROW()-3)
              + INDEX($E:$E, ROW()-6),
                INDEX($E:$E, ROW()-3)
              )
            )
        )`;

      // G列（納品予定・曜日表示）
      const formulaG = `=IF(F${rowNumber}="","",IF($C${rowNumber}="キャベツ",TEXT($A${rowNumber}+3,"ddd"),TEXT($A${rowNumber}+2,"ddd")))`;

      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${mainSheet}!A${rowNumber}:G${rowNumber}`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[
            d,        // A: 日付
            formulaB, // B: 曜日（式）
            product,  // C: 商品名
            qty,      // D: 残数
            formulaE, // E: 発注数（式）
            uid,      // F: 登録者
            formulaG  // G: 納品予定（式）
          ]]
        }
      });
      rowNumber++;
    }

    // --- 計算結果を読み返してLINEに伝える ---
    const endRow = rowNumber - 1; // 今書き終えた最後の行
    const resultRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${mainSheet}!A${startRow}:G${endRow}`
    });
    const results = resultRes.data.values || [];
    const summary = results.map(r => `${r[2]}：${r[4]}個`).join("\n");

    // --- 入力中を消し、状態リセット ---
    await clearTempData(userId);
    await setUserState(userId, "通常");

    // --- LINE返信 ---
    await client.replyMessage(replyToken, {
      type: "text",
      text: `本日の発注内容を登録しました。\n\n${summary}`
    });

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



