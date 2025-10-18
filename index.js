require("dotenv").config();
const express = require("express");
const { Client, middleware } = require("@line/bot-sdk");
const { google } = require("googleapis");

// LINE設定
const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const app = express();
const client = new Client(config);

// Google Sheets設定
const sheetsAuth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth: sheetsAuth });

// Webhook
app.post("/webhook", middleware(config), async (req, res) => {
  const events = req.body.events;
  for (const event of events) {
    if (event.type === "message" && event.message.type === "text") {
      await handleMessage(event);
    }
  }
  res.sendStatus(200);
});

async function handleMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text.trim();

  if (text === "発注") {
    await client.replyMessage(event.replyToken, { type: "text", text: "どの商品ですか？（キャベツ／プリン／カレー）" });
  }

  else if (["キャベツ", "プリン", "カレー"].includes(text)) {
    // 商品名が送られた → 次は残数を聞く
    await client.replyMessage(event.replyToken, { type: "text", text: `${text}ですね。残りは何個ですか？` });
    // 商品名だけ一旦仮記録
    await recordTempData(userId, text);
  }

  else if (!isNaN(text)) {
    // 数値が送られた → 直近の「入力中商品」に数量を仮記録
    const rows = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "入力中!A:E",
    });
    const all = rows.data.values || [];
    const now = new Date().toLocaleDateString("ja-JP");
    const lastRow = all.reverse().find(r => r[0] === userId && r[1] === now && r[3] === "");

    if (lastRow) {
      // 数を追記
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: `入力中!A${all.length - all.indexOf(lastRow)}:E${all.length - all.indexOf(lastRow)}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[lastRow[0], lastRow[1], lastRow[2], Number(text), "入力済"]] },
      });
      console.log(`✅ ${lastRow[2]} の数量更新: ${text}`);
    }

    // 入力が３つそろったかチェック
    if (await checkCompleteInput(userId)) {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "３つの商品すべて入力されました。\n登録しますか？（はい／いいえ）",
      });
    } else {
      await client.replyMessage(event.replyToken, { type: "text", text: "次の商品を入力してください。" });
    }
  }

  else if (text === "はい") {
    // 確定登録処理（ステップ3で作る）
    await finalizeRecord(userId, event.replyToken);
  }

  else {
    await client.replyMessage(event.replyToken, { type: "text", text: "「発注」と送ると始まります。" });
  }
}


// 仮記録（入力中シートに書き込み）
async function recordTempData(userId, product, quantity) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tempSheet = "入力中";
  const now = new Date();
  const date = now.toLocaleDateString("ja-JP");

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tempSheet}!A:E`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[userId, date, product, quantity || "", "入力中"]],
    },
  });

  console.log(`📝 仮記録: ${userId} - ${product}: ${quantity || "(未入力)"}`);
}

// Googleスプレッドシートに書き込み・読み込み
async function recordToSheet({ product, quantity }) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const sheetName = "発注記録";
  const now = new Date();
  const date = now.toLocaleDateString("ja-JP");

  try {
    if (product && !quantity) {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A:D`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[date, product, "", ""]] },
      });
      console.log("✅ 商品登録完了:", product);
      return "OK";
    }

    if (quantity) {
      const orderAmount = Math.max(0, 10 - quantity);

      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A:D`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[date, "", quantity, orderAmount]] },
      });

      console.log("✅ 数量登録完了:", quantity, "→ 発注数:", orderAmount);
      return orderAmount;
    }
  } catch (error) {
    console.error("❌ Sheetsエラー:", error.message);
    console.error(error.stack);
    return "エラー";
  }
}

async function finalizeRecord(userId, replyToken) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tempSheet = "入力中";
  const mainSheet = "発注記録";

  const now = new Date();
  const date = now.toLocaleDateString("ja-JP");
  const day = now.toLocaleDateString("ja-JP", { weekday: "short" }); // 土とか日とか

  try {
    // 仮記録シートからデータ取得
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tempSheet}!A:E`,
    });

    const rows = res.data.values || [];
    const todayInputs = rows.filter(r => r[0] === userId && r[1] === date);

    if (todayInputs.length < 3) {
      await client.replyMessage(replyToken, { type: "text", text: "まだ３商品の入力が完了していません。" });
      return;
    }

    // 発注計算（仮で単純な式。あとでスプシ側に置き換えてもOK）
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

    console.log(`✅ ${userId} の入力データを確定登録`);
    await client.replyMessage(replyToken, {
      type: "text",
      text: "本日の発注データを登録しました。お疲れさまです。",
    });

  } catch (err) {
    console.error("❌ finalizeRecord エラー:", err.message);
    await client.replyMessage(replyToken, { type: "text", text: "登録時にエラーが発生しました。" });
  }
}

app.get("/", (req, res) => res.send("LINE Webhook server is running."));

// Render用ポート設定
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

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

