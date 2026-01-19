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

const CONTRACT_ADDRESS = "0x515eFeA28220556257Fb2A94aF632434F5b3B7dd";

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
      return true;
    } catch (e) {
      console.warn(`[SKIP] ${url}: ${e.message}`);
    }
  }

  console.error("[CRITICAL] No working RPC found after trying all");
  return false;
}

const ROUND_NUMBER = 6;

let pinnedMessageId = null;

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

async function editMessage(messageId, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHANNEL_ID,
        message_id: messageId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
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
    console.log(`[PIN] ${data.ok ? 'Success (old pin replaced)' : 'Failed'}`);
    return data.ok;
  } catch (err) {
    console.error("[ERROR] Pin failed:", err.message);
    return false;
  }
}

async function buildLeaderboardText() {
  if (!contract) {
    console.error("[BUILD] Contract not ready");
    return null;
  }

  try {
    const [names, symbols, , votesRaw] = await contract.getProjects();

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
      text += `⚠️ Round ${ROUND_NUMBER} just started — votes are accumulating!\nHold JADE & vote on https://jade1.io\n\n`;
    }

    entries.forEach((p, i) => {
      text += `${i + 1}. *${p.name} (${p.symbol})* — ${p.votes.toFixed(4)} JADE\n`;
    });

    text += `\nUpdated: ${new Date().toUTCString()}\nhttps://jade1.io`;

    return text;
  } catch (err) {
    console.error("[ERROR] Build leaderboard failed:", err.message);
    return null;
  }
}

async function updateLeaderboard() {
  console.log("[UPDATE] Starting leaderboard update...");
  const text = await buildLeaderboardText();
  if (!text) {
    console.error("[UPDATE] Failed to build text — skipping send");
    return;
  }

  if (pinnedMessageId) {
    const edited = await editMessage(pinnedMessageId, text);
    if (edited) {
      console.log("[SUCCESS] Leaderboard updated (edited pinned message)");
      return;
    }
    console.log("[FALLBACK] Edit failed → sending new message");
    pinnedMessageId = null; // reset so it sends new
  }

  const data = await sendMessage(text);
  if (data.ok) {
    pinnedMessageId = data.result.message_id;
    await pinMessage(pinnedMessageId);
    console.log(`[SUCCESS] New leaderboard sent & pinned (ID: ${pinnedMessageId})`);
  } else {
    console.error("[UPDATE] Failed to send new message");
  }
}

// === CRITICAL FIX: Wait for provider init before first update ===
initProvider().then(async (success) => {
  if (success) {
    console.log("[INIT] Provider connected — sending initial leaderboard");
    await updateLeaderboard();

    // Periodic updates every 5 minutes (even if no votes)
    setInterval(async () => {
      console.log("[INTERVAL] Running periodic leaderboard update...");
      await updateLeaderboard();
    }, 300000); // 5 minutes
  } else {
    console.error("[INIT] Provider failed — no updates possible until restart");
  }
});

// Optional: Manual trigger endpoint (hit /force-update in browser or curl)
app.get('/force-update', async (req, res) => {
  console.log("[MANUAL] Force update requested");
  await updateLeaderboard();
  res.send('Force update triggered — check logs/channel');
});

// Webhook remains unchanged
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
    await updateLeaderboard();

    res.json({ success: true });
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err);
    res.status(500).json({ error: 'failed' });
  }
});

app.get('/', (req, res) => res.send(`Jade Bot — Round #${ROUND_NUMBER} Active`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bot running on port ${PORT}`);
});
