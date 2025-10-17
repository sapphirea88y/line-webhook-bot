require("dotenv").config();
const express = require("express");
const { Client, middleware } = require("@line/bot-sdk");

const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();
const client = new Client(config);

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
  const text = event.message.text.trim();

  if (text === "発注") {
    await client.replyMessage(event.replyToken, { type: "text", text: "どの商品ですか？" });
  } else if (["A商品", "B商品", "C商品"].includes(text)) {
    await client.replyMessage(event.replyToken, { type: "text", text: `${text}ですね。残りは何個ですか？` });
  } else if (!isNaN(text)) {
    await client.replyMessage(event.replyToken, { type: "text", text: `了解。発注数を計算します…` });
  } else {
    await client.replyMessage(event.replyToken, { type: "text", text: "「発注」と送ると始まります。" });
  }
}

app.get("/", (req, res) => res.send("LINE Webhook server is running."));
app.listen(3000, () => console.log("Server running"));
