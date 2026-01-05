const express = require('express');
const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_IDS = [process.env.CHANNEL_ID, process.env.GROUP_ID].filter(Boolean);

// Most reliable/fast-syncing free BSC RPCs in early 2026 (publicnode & ankr sync newest state quickest)
const RPC_URLS = [
  "https://bsc-rpc.publicnode.com",
  "https://bsc.publicnode.com",
  "https://rpc.ankr.com/bsc",
  "https://bscrpc.com",
  "https://bsc-dataseed.binance.org/",
  "https://bsc-dataseed1.defibit.io",
  "https://bsc-dataseed1.ninicoin.io",
  "https://bsc-dataseed2.binance.org/",
  "https://bsc-dataseed3.binance.org/",
  "https://bsc-dataseed4.binance.org/"
];

const ethers = require('ethers');

let pinnedMessageId = null;

async function sendToTelegram(chatId, text, parse_mode = "Markdown") {
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode, disable_web_page_preview: true })
    });
    const data = await response.json();
    console.log(`[TELEGRAM] Sent: ${JSON.stringify(data)}`);
    return data;
  } catch (err) {
    console.error(`[ERROR] Send failed: ${err.message}`);
    return null;
  }
}

async function broadcastVote(message) {
  for (const chatId of CHAT_IDS) if (chatId) await sendToTelegram(chatId, message);
}

app.post('/vote-webhook', async (req, res) => {
  try {
    const { wallet, amount, projectName, projectSymbol } = req.body;
    const shortWallet = wallet.slice(0,6) + '...' + wallet.slice(-4);
    const message = `
🗳 *New Vote Detected!*

Wallet: \`${shortWallet}\`
Power: *${parseFloat(amount).toFixed(4)} JADE*
Project: *${projectName} (${projectSymbol})*
Round: #4

https://jade1.io
    `.trim();
    await broadcastVote(message);
    res.json({ success: true });
  } catch (err) {
    console.error("[ERROR] Webhook:", err.message);
    res.status(500).json({ error: 'failed' });
  }
});

async function updateLeaderboard() {
  let freshProjects = null;
  let usedRPC = "none";

  for (const url of RPC_URLS) {
    try {
      console.log(`[RPC TRY] ${url}`);
      const provider = new ethers.JsonRpcProvider(url);
      const block = await provider.getBlockNumber();
      console.log(`[RPC] ${url} - block ${block}`);

      const contract = new ethers.Contract(
        "0xD987b9869292B77655cde5A4Ab2EBA64C4659D03",
        ["function getProjects() view returns (string[20], string[20], address[20], uint256[20])"],
        provider
      );

      const projects = await contract.getProjects();
      const [names, symbols, , votesRaw] = projects;

      let total = 0n;
      for (const v of votesRaw) total += v || 0n;
      const formattedTotal = Number(ethers.formatUnits(total, 18));

      const firstName = names[0]?.trim() || "";

      console.log(`[DATA from ${url}] Total votes ~${formattedTotal.toFixed(4)} | First name in array: "${firstName}"`);

      // Strict fresh Round 4 check: first name must be "DOYR" (as set in setProjects) + total votes very low (<10 JADE currently)
      if (firstName === "DOYR" && formattedTotal < 10) {
        freshProjects = projects;
        usedRPC = url;
        console.log(`[FRESH FOUND] Confirmed Round 4 data from ${url}`);
        break;
      } else {
        console.warn(`[STALE] ${url} shows old data (first name "${firstName}", total ${formattedTotal}) - skipping`);
      }
    } catch (e) {
      console.warn(`[FAIL] ${url}: ${e.message}`);
    }
  }

  if (!freshProjects) {
    console.error("[CRITICAL] No fresh Round 4 data found on any RPC - skipping update (retrying in 60s). Check if setProjects tx is confirmed.");
    // Optional: send alert message to channel if persistent
    return;
  }

  console.log(`[SUCCESS] Using fresh Round 4 data from ${usedRPC}`);

  const [names, symbols, , votesRaw] = freshProjects;

  const entries = [];
  let totalVotes = 0n;
  for (let i = 0; i < 20; i++) {
    const name = names[i]?.trim() || "";
    if (name) {
      const votesBig = votesRaw[i] || 0n;
      const votes = Number(ethers.formatUnits(votesBig, 18));
      totalVotes += votesBig;
      entries.push({ name, symbol: symbols[i]?.trim() || '???', votes });
    }
  }

  entries.sort((a, b) => b.votes - a.votes);

  let text = `*Jade1 Live Leaderboard* — Round #4\n`;
  text += `Total Votes: *${Number(ethers.formatUnits(totalVotes, 18)).toFixed(0)} JADE*\n\n`;
  text += `⚠️ Round 4 is live — votes accumulating now!\nStake JADE & vote: https://jade1.io\n\n`;

  entries.forEach((p, i) => {
    text += `${i + 1}. *${p.name} (${p.symbol})* — ${p.votes.toFixed(4)} JADE\n`;
  });

  text += `\nUpdated: ${new Date().toUTCString()}\nhttps://jade1.io`;

  const chat = process.env.CHANNEL_ID;
  if (!chat) return;

  if (!pinnedMessageId) {
    const data = await sendToTelegram(chat, text);
    if (data?.ok) {
      pinnedMessageId = data.result.message_id;
      console.log(`[NEW] Fresh leaderboard sent - PIN THIS MESSAGE ID: ${pinnedMessageId}`);
    }
  } else {
    const edit = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, message_id: pinnedMessageId, text, parse_mode: 'Markdown' })
    });
    const editData = await edit.json();
    if (!editData.ok) {
      console.warn("[EDIT FAILED] - fallback to new message");
      const data = await sendToTelegram(chat, text);
      if (data?.ok) {
        pinnedMessageId = data.result.message_id;
        console.log(`[FALLBACK NEW] Sent - PIN THIS ID: ${pinnedMessageId}`);
      }
    } else {
      console.log("[UPDATED] Leaderboard edited");
    }
  }
}

setInterval(updateLeaderboard, 60000);
updateLeaderboard();

app.get('/', (req, res) => res.send('Jade Bot - Round #4 Live with Strict Fresh Data Check'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Running on port ${PORT}`));
