const express = require('express');
const app = express();
app.use(express.json());

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

const ethers = require('ethers');

// Reliable BSC RPCs
const RPC_URLS = [
  "https://bsc-dataseed.binance.org/",
  "https://bsc-dataseed1.defibit.io/",
  "https://bsc-dataseed1.ninicoin.io/",
  "https://bsc-dataseed2.binance.org/",
  "https://rpc.ankr.com/bsc",
  "https://bsc-rpc.publicnode.com",
  "https://bscrpc.com",
  "https://bsc.publicnode.com"
];

let provider = null;
let contract = null;

const CONTRACT_ADDRESS = "0x9AccD1f82330ADE9E3Eb9fAb9c069ab98D5bB42a"; // ← Change to your actual new Round 5 contract if different (the one with 0 votes)

const ABI = [
  "function getProjects() view returns (string[20], string[20], address[20], uint256[20])"
];

async function initProvider() {
  for (const url of RPC_URLS) {
    try {
      const tempProvider = new ethers.JsonRpcProvider(url);
      await tempProvider.getBlockNumber();
      provider = tempProvider;
      contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);
      console.log(`[SUCCESS] Connected to RPC: ${url}`);
      break;
    } catch (e) {
      console.warn(`[SKIP] ${url}: ${e.message}`);
    }
  }

  if (!provider) {
    console.error("[CRITICAL] No working RPC found");
  }
}

initProvider();

const ROUND_NUMBER = 5; // Current round - change weekly

async function sendMessage(text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHANNEL_ID,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      })
    });
    const data = await res.json();
    console.log(`[MSG] ${data.ok ? 'Sent' : 'Failed'}: ${data.description || ''}`);
    return data;
  } catch (err) {
    console.error("[ERROR] Send failed:", err.message);
    return { ok: false };
  }
}

async function pinMessage(messageId) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/pinChatMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHANNEL_ID,
        message_id: messageId,
        disable_notification: true
      })
    });
    const data = await res.json();
    console.log(`[PIN] ${data.ok ? 'Success (old pin replaced)' : 'Failed'}: ${data.description || ''}`);
    return data.ok;
  } catch (err) {
    console.error("[ERROR] Pin failed (check bot admin rights):", err.message);
    return false;
  }
}

async function updateLeaderboard() {
  if (!contract) {
    console.log("[WARN] Contract not initialized");
    return;
  }

  try {
    console.log("[UPDATE] Fetching latest Round 5 data...");

    const [names, symbols, , votesRaw] = await contract.getProjects();

    console.log("[DEBUG] Fetched project names:", names.map(n => n?.trim()).filter(Boolean)); // ← Check Railway logs for new projects!

    const entries = [];
    let totalVotes = 0n;

    for (let i = 0; i < 20; i++) {
      const name = names[i]?.trim() || "";
      if (name && name !== "") {
        const votesBig = votesRaw[i] || 0n;
        const votes = Number(ethers.formatUnits(votesBig, 18));
        totalVotes += votesBig;

        entries.push({
          name,
          symbol: symbols[i]?.trim() || '???',
          votes
        });
      }
    }

    entries.sort((a, b) => b.votes - a.votes);

    let text = `*Jade1 Live Leaderboard* — Round #${ROUND_NUMBER}\n`;
    text += `Total Votes: *${Number(ethers.formatUnits(totalVotes, 18)).toFixed(0)} JADE*\n\n`;

    if (entries.length === 0 || totalVotes === 0n) {
      text += `⚠️ Round ${ROUND_NUMBER} just started — votes are accumulating!\nStake JADE & vote on https://jade1.io\n\n`;
    }

    entries.forEach((p, i) => {
      text += `${i + 1}. *${p.name} (${p.symbol})* — ${p.votes.toFixed(4)} JADE\n`;
    });

    text += `\nUpdated: ${new Date().toUTCString()}\nhttps://jade1.io`;

    const data = await sendMessage(text);
    if (data.ok) {
      await pinMessage(data.result.message_id);
      console.log(`[SUCCESS] New Round #5 leaderboard sent & pinned (old replaced)`);
    }
  } catch (err) {
    console.error("[ERROR] Failed:", err.message);
  }
}

setInterval(updateLeaderboard, 60_000);
updateLeaderboard();

// Webhook
app.post('/vote-webhook', async (req, res) => {
  try {
    const { wallet, amount, projectName, projectSymbol } = req.body;
    const short = wallet.slice(0,6) + '...' + wallet.slice(-4);

    const msg = `
🗳 *New Vote!*

Wallet: \`${short}\`
Power: *${parseFloat(amount).toFixed(4)} JADE*
Project: *${projectName} (${projectSymbol})*
Round: #${ROUND_NUMBER}

https://jade1.io`.trim();

    await sendMessage(msg);
    res.json({ success: true });
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err);
    res.status(500).json({ error: 'failed' });
  }
});

app.get('/', (req, res) => res.send(`Jade Bot — Round #${ROUND_NUMBER} Leaderboard Active`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bot running on port ${PORT}`);
});
