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
  console.log("[INIT] Starting provider initialization...");
  for (const url of RPC_URLS) {
    try {
      console.log(`[INIT] Trying RPC: ${url}`);
      const tempProvider = new ethers.JsonRpcProvider(url);
      const blockNumber = await tempProvider.getBlockNumber();
      console.log(`[INIT] Success with ${url} — current block: ${blockNumber}`);
      provider = tempProvider;
      contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);
      console.log("[INIT] Contract instance created");
      return true;
    } catch (e) {
      console.warn(`[INIT] Failed ${url}: ${e.message}`);
    }
  }

  console.error("[INIT] CRITICAL: All RPCs failed — no connection possible");
  return false;
}

const ROUND_NUMBER = 6;

let pinnedMessageId = null;

async function sendMessage(text) {
  console.log("[SEND] Attempting to send message...");
  console.log("[SEND] Message preview (first 200 chars):\n", text.slice(0, 200) + (text.length > 200 ? '...' : ''));
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
    if (data.ok) {
      console.log(`[SEND] SUCCESS: Message sent — ID: ${data.result.message_id}`);
    } else {
      console.error(`[SEND] FAILED: ${JSON.stringify(data)}`);
    }
    return data;
  } catch (err) {
    console.error("[SEND] EXCEPTION:", err.message);
    return { ok: false };
  }
}

async function editMessage(messageId, text) {
  console.log(`[EDIT] Attempting to edit message ID: ${messageId}`);
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
      console.log("[EDIT] SUCCESS");
    } else {
      console.error(`[EDIT] FAILED: ${JSON.stringify(data)}`);
    }
    return data.ok;
  } catch (err) {
    console.error("[EDIT] EXCEPTION:", err.message);
    return false;
  }
}

async function pinMessage(messageId) {
  console.log(`[PIN] Attempting to pin message ID: ${messageId}`);
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
      console.log("[PIN] SUCCESS (old pin replaced if any)");
    } else {
      console.error(`[PIN] FAILED: ${JSON.stringify(data)}`);
    }
    return data.ok;
  } catch (err) {
    console.error("[PIN] EXCEPTION:", err.message);
    return false;
  }
}

async function buildLeaderboardText() {
  if (!contract) {
    console.error("[BUILD] Contract not initialized — cannot query");
    return null;
  }

  console.log("[BUILD] Querying getProjects() on-chain...");
  try {
    const [names, symbols, addresses, votesRaw] = await contract.getProjects();

    // DEBUG: Raw data
    console.log("[BUILD] Raw names:", names);
    console.log("[BUILD] Raw symbols:", symbols);
    console.log("[BUILD] Raw addresses:", addresses.map(a => a.toLowerCase()));
    console.log("[BUILD] Raw votes (wei):", votesRaw.map(v => v.toString()));

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

    console.log(`[BUILD] Parsed ${entries.length} projects`);
    entries.sort((a, b) => b.votes - a.votes);

    let text = `*Jade1 Live Leaderboard* — Round #${ROUND_NUMBER}\n`;
    text += `Total Votes: *${Number(ethers.formatUnits(totalVotes, 18)).toFixed(0)} JADE*\n\n`;

    if (entries.length === 0 || totalVotes === 0n) {
      console.log("[BUILD] No entries or zero votes — using 'just started' fallback");
      text += `⚠️ Round ${ROUND_NUMBER} just started — votes are accumulating!\nHold JADE & vote on https://jade1.io\n\n`;
    }

    entries.forEach((p, i) => {
      text += `${i + 1}. *${p.name} (${p.symbol})* — ${p.votes.toFixed(4)} JADE\n`;
    });

    text += `\nUpdated: ${new Date().toUTCString()}\nhttps://jade1.io`;

    console.log("[BUILD] Leaderboard text built successfully");
    return text;
  } catch (err) {
    console.error("[BUILD] EXCEPTION during contract call:", err.message);
    console.error("[BUILD] Full error:", err);
    return null;
  }
}

async function updateLeaderboard() {
  console.log("[UPDATE] === Starting leaderboard update ===");
  const text = await buildLeaderboardText();
  if (!text) {
    console.error("[UPDATE] Failed to build text — aborting update");
    return;
  }

  if (pinnedMessageId) {
    console.log(`[UPDATE] Attempting to edit existing pinned message ID: ${pinnedMessageId}`);
    const edited = await editMessage(pinnedMessageId, text);
    if (edited) {
      console.log("[UPDATE] SUCCESS: Edited existing message");
      return;
    }
    console.log("[UPDATE] Edit failed — falling back to new message");
    pinnedMessageId = null;
  }

  console.log("[UPDATE] Sending new leaderboard message...");
  const data = await sendMessage(text);
  if (data.ok) {
    pinnedMessageId = data.result.message_id;
    console.log(`[UPDATE] New message sent — now pinning ID: ${pinnedMessageId}`);
    await pinMessage(pinnedMessageId);
  } else {
    console.error("[UPDATE] Failed to send new message — no pin attempted");
  }
  console.log("[UPDATE] === Leaderboard update complete ===\n");
}

// === Initialization with full debug ===
(async () => {
  console.log("[STARTUP] Bot starting...");
  const providerOk = await initProvider();
  if (providerOk) {
    console.log("[STARTUP] Provider ready — triggering initial leaderboard");
    await updateLeaderboard();

    // Periodic updates
    setInterval(async () => {
      console.log("[INTERVAL] Triggering periodic update...");
      await updateLeaderboard();
    }, 300000); // 5 minutes
  } else {
    console.error("[STARTUP] Provider failed — bot cannot function until restart with working RPCs");
  }
})();

// Manual force endpoint
app.get('/force-update', async (req, res) => {
  console.log("[MANUAL] Force update requested via endpoint");
  await updateLeaderboard();
  res.send('Force update triggered — check logs and Telegram channel');
});

// Webhook
app.post('/vote-webhook', async (req, res) => {
  console.log("[WEBHOOK] Vote webhook hit:", req.body);
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
  console.log(`[STARTUP] Server listening on port ${PORT}`);
});
