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

const RPC_URLS = [
  "https://bsc-rpc.publicnode.com",
  "https://bsc.publicnode.com",
  "https://rpc.ankr.com/bsc",
  "https://bscrpc.com",
  "https://bsc-dataseed.binance.org/"
];

const ethers = require('ethers');

let provider = null;
let contract = null;

const CONTRACT_ADDRESS = "0x9AccD1f82330ADE9E3Eb9fAb9c069ab98D5bB42a";

const ABI = [
  "function getProjects() view returns (string[20], string[20], address[20], uint256[20])",
  "function currentRound() view returns (uint256)"
];

let currentRound = 5; // fallback

async function initProvider() {
  for (const url of RPC_URLS) {
    try {
      const tempProvider = new ethers.JsonRpcProvider(url);
      await tempProvider.getBlockNumber();
      provider = tempProvider;
      contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);
      console.log(`[SUCCESS] Connected to RPC: ${url}`);
      return true;
    } catch (e) {
      console.warn(`[SKIP] ${url}: ${e.message}`);
    }
  }
  console.error("[CRITICAL] No working RPC found");
  return false;
}

await initProvider();

// Try to read currentRound once
async function fetchCurrentRound() {
  if (contract) {
    try {
      const roundBn = await contract.currentRound();
      currentRound = Number(roundBn);
      console.log(`[INFO] Detected current round from chain: #${currentRound}`);
    } catch (e) {
      console.warn("[WARN] Could not read currentRound() yet:", e.message);
    }
  }
}
fetchCurrentRound();

let pinnedMessageId = null; // Force reset - no old pin

async function sendMessage(text) {
  // same as before...
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

async function editMessage(messageId, text) {
  // same as before...
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHANNEL_ID,
        message_id: messageId,
        text,
        parse_mode: 'Markdown'
      })
    });
    const data = await res.json();
    console.log(`[EDIT] ${data.ok ? 'Success' : 'Failed'}: ${data.description || ''}`);
    return data.ok;
  } catch (err) {
    console.error("[ERROR] Edit failed:", err.message);
    return false;
  }
}

async function fetchProjectsWithRetry(maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[ATTEMPT ${attempt}] Fetching projects...`);
      const [names, symbols, , votesRaw] = await contract.getProjects();
      console.log("[DEBUG] Raw names:", names.map(n => n.trim()).filter(Boolean));
      console.log("[DEBUG] Raw symbols:", symbols.map(s => s.trim()).filter(Boolean));
      console.log("[DEBUG] Raw votes (first few):", votesRaw.slice(0,5).map(v => Number(ethers.formatUnits(v, 18))));
      return { names, symbols, votesRaw };
    } catch (err) {
      console.error(`[ERROR attempt ${attempt}] getProjects failed:`, err.message);
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, 10000)); // 10s wait
    }
  }
  throw new Error("Failed to fetch projects after retries");
}

async function updateLeaderboard() {
  if (!contract) {
    console.log("[WARN] Contract not initialized");
    return;
  }

  try {
    const { names, symbols, votesRaw } = await fetchProjectsWithRetry();

    const entries = [];
    let totalVotes = 0n;

    for (let i = 0; i < 20; i++) {
      const name = names[i]?.trim() || "";
      if (name) {
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

    let text = `*Jade1 Live Leaderboard* — Round #${currentRound}\n`;
    text += `Total Votes: *${Number(ethers.formatUnits(totalVotes, 18)).toFixed(0)} JADE*\n\n`;

    if (entries.length === 0 || totalVotes === 0n) {
      text += `⚠️ Round ${currentRound} just started — votes are accumulating!\nStake JADE & vote on https://jade1.io\n\n`;
    }

    entries.forEach((p, i) => {
      text += `${i + 1}. *${p.name} (${p.symbol})* — ${p.votes.toFixed(4)} JADE\n`;
    });

    text += `\nUpdated: ${new Date().toUTCString()}\nhttps://jade1.io`;

    // Always send NEW on startup/first update; then edit
    let data = await sendMessage(text);
    if (data.ok) {
      pinnedMessageId = data.result.message_id;
      console.log(`[NEW PIN] Leaderboard sent - new PIN ID: ${pinnedMessageId}`);
    }
  } catch (err) {
    console.error("[ERROR] Leaderboard failed:", err.message);
  }
}

// Update every minute
setInterval(updateLeaderboard, 60000);
updateLeaderboard(); // immediate

// Webhook (updated to use currentRound)
app.post('/vote-webhook', async (req, res) => {
  try {
    const { wallet, amount, projectName, projectSymbol } = req.body;
    const short = wallet.slice(0,6) + '...' + wallet.slice(-4);

    const msg = `
🗳 *New Vote!*

Wallet: \`${short}\`
Power: *${parseFloat(amount).toFixed(4)} JADE*
Project: *${projectName} (${projectSymbol})*
Round: #${currentRound}

https://jade1.io`.trim();

    await sendMessage(msg);
    res.json({ success: true });
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err);
    res.status(500).json({ error: 'failed' });
  }
});

app.get('/', (req, res) => res.send(`Jade Bot — Round #${currentRound} Leaderboard Active`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bot running on port ${PORT}`);
});
