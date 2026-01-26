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

const CONTRACT_ADDRESS = "0xa089C232E8284a7A8D5Ff6Ab009DF2Fe3e12Bc12";

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
      console.log(`[INIT] Connected to RPC: ${url}`);
      return true;
    } catch (e) {
      console.warn(`[INIT] Failed ${url}: ${e.message}`);
    }
  }
  console.error("[INIT] No working RPC");
  return false;
}

const ROUND_NUMBER = 7;

let pinnedMessageId = null; // Stored in memory — resets on restart

async function sendMessage(text, options = {}) {
  const {
    silent = true, // default silent for leaderboard
    parseMode = 'Markdown'
  } = options;

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHANNEL_ID,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
        disable_notification: silent
      })
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`[SEND] Message sent (silent: ${silent}) — ID: ${data.result.message_id}`);
    } else {
      console.error(`[SEND] Telegram error: ${JSON.stringify(data)}`);
    }
    return data;
  } catch (err) {
    console.error("[SEND] Exception:", err.message);
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
    if (data.ok) {
      console.log("[EDIT] Success");
    } else {
      console.error(`[EDIT] Telegram error: ${JSON.stringify(data)}`);
    }
    return data.ok;
  } catch (err) {
    console.error("[EDIT] Exception:", err.message);
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
    if (data.ok) {
      console.log("[PIN] Success");
    } else {
      console.error(`[PIN] Pin error: ${JSON.stringify(data)}`);
    }
    return data.ok;
  } catch (err) {
    console.error("[PIN] Exception:", err.message);
    return false;
  }
}

async function buildLeaderboardText() {
  if (!contract) return null;

  try {
    const [names, symbols, , votesRaw] = await contract.getProjects();

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
    console.error("[BUILD] Error:", err.message);
    return null;
  }
}

async function updateLeaderboard() {
  console.log("[UPDATE] Running leaderboard update...");
  const text = await buildLeaderboardText();
  if (!text) return;

  // Always try to edit the pinned message first (silent)
  if (pinnedMessageId) {
    const edited = await editMessage(pinnedMessageId, text);
    if (edited) {
      console.log("[UPDATE] Pinned leaderboard edited successfully");
      return;
    }
    console.log("[UPDATE] Edit failed (maybe deleted) — sending new");
    pinnedMessageId = null; // reset
  }

  // Fallback: send new silent message and pin
  const data = await sendMessage(text, { silent: true });
  if (data.ok) {
    pinnedMessageId = data.result.message_id;
    await pinMessage(pinnedMessageId);
    console.log("[UPDATE] New silent leaderboard sent & pinned");
  }
}

// Startup: init + periodic silent updates (no loud startup message)
(async () => {
  const ok = await initProvider();
  if (ok) {
    // Initial leaderboard (silent, will send new if no pin yet)
    await updateLeaderboard();

    // Update every 5 minutes (silent edits)
    setInterval(updateLeaderboard, 300000);
  }
})();

// Webhook: LOUD vote alert + silent leaderboard update
app.post('/vote-webhook', async (req, res) => {
  console.log("[WEBHOOK] New vote received");
  try {
    const { wallet, amount, projectName, projectSymbol } = req.body;
    const short = wallet.slice(0,6) + '...' + wallet.slice(-4);

    const voteMsg = `
🗳 *New Vote!*

Wallet: \`${short}\`
Power: *${parseFloat(amount).toFixed(4)} JADE*
Project: *${projectName} (${projectSymbol})*
Round: #${ROUND_NUMBER}

https://jade1.io`.trim();

    // Loud notification for new vote
    await sendMessage(voteMsg, { silent: false });

    // Silent leaderboard update
    await updateLeaderboard();

    res.json({ success: true });
  } catch (err) {
    console.error("[WEBHOOK] Error:", err);
    res.status(500).json({ error: 'failed' });
  }
});

// Optional manual force (silent)
app.get('/force-update', async (req, res) => {
  await updateLeaderboard();
  res.send('Silent leaderboard update triggered');
});

app.get('/', (req, res) => res.send(`Jade Bot — Round #${ROUND_NUMBER} Active`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bot running on port ${PORT}`);
});
