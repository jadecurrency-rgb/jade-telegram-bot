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
const CHANNEL_ID = process.env.CHANNEL_ID; // MUST be like -1001234567890 for supergroups/channels

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
      console.log("[INIT] Contract instance created successfully");
      return true;
    } catch (e) {
      console.warn(`[INIT] Failed ${url}: ${e.message}`);
    }
  }

  console.error("[INIT] CRITICAL: All RPCs failed");
  return false;
}

const ROUND_NUMBER = 6;

let pinnedMessageId = null;

async function sendMessage(text, silent = true) {
  console.log("[SEND] === Attempting to send message ===");
  console.log("[SEND] Chat ID:", CHANNEL_ID);
  console.log("[SEND] Message preview (first 300 chars):\n", text.slice(0, 300) + (text.length > 300 ? '...\n[TRUNCATED]' : ''));
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHANNEL_ID,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        disable_notification: silent
      })
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`[SEND] SUCCESS: Message sent — ID: ${data.result.message_id}`);
    } else {
      console.error(`[SEND] TELEGRAM ERROR: ${JSON.stringify(data)}`);
    }
    return data;
  } catch (err) {
    console.error("[SEND] NETWORK EXCEPTION:", err.message);
    console.error("[SEND] Full error:", err);
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
      console.error(`[EDIT] TELEGRAM ERROR: ${JSON.stringify(data)}`);
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
      console.log("[PIN] SUCCESS");
    } else {
      console.error(`[PIN] TELEGRAM ERROR: ${JSON.stringify(data)}`);
    }
    return data.ok;
  } catch (err) {
    console.error("[PIN] EXCEPTION:", err.message);
    return false;
  }
}

async function buildLeaderboardText() {
  if (!contract) {
    console.error("[BUILD] Contract not ready");
    return null;
  }

  console.log("[BUILD] Calling getProjects()...");
  try {
    const [names, symbols, addresses, votesRaw] = await contract.getProjects();
    console.log("[BUILD] getProjects() succeeded");

    // Extra debug: log first few raw values
    console.log("[BUILD] First 5 names:", names.slice(0,5).map(n => `'${n}'`));
    console.log("[BUILD] First 5 symbols:", symbols.slice(0,5).map(s => `'${s}'`));
    console.log("[BUILD] First 5 votes (raw):", votesRaw.slice(0,5).map(v => v.toString()));

    const entries = [];
    let totalVotes = 0n;

    for (let i = 0; i < 20; i++) {
      let name = (names[i] || "").trim();
      if (name !== "") {
        const votesBig = votesRaw[i] || 0n;
        const votes = Number(ethers.formatUnits(votesBig, 18));
        totalVotes += votesBig;

        entries.push({
          index: i,
          name,
          symbol: (symbols[i] || "").trim() || '???',
          votes
        });
      }
    }

    console.log(`[BUILD] Found ${entries.length} non-empty projects`);

    entries.sort((a, b) => b.votes - a.votes);

    let text = `*Jade1 Live Leaderboard* — Round #${ROUND_NUMBER}\n`;
    text += `Total Votes: *${Number(ethers.formatUnits(totalVotes, 18)).toFixed(0)} JADE*\n\n`;

    if (entries.length === 0 || totalVotes === 0n) {
      console.log("[BUILD] Triggering 'just started' fallback");
      text += `⚠️ Round ${ROUND_NUMBER} just started — votes are accumulating!\nHold JADE & vote on https://jade1.io\n\n`;
      // Add placeholder or note
      text += `Projects are loading or being finalized...\n`;
    }

    entries.forEach((p, rank) => {
      text += `${rank + 1}. *${p.name} (${p.symbol})* — ${p.votes.toFixed(4)} JADE\n`;
    });

    text += `\nUpdated: ${new Date().toUTCString()}\nhttps://jade1.io`;

    console.log("[BUILD] Leaderboard text ready");
    return text;
  } catch (err) {
    console.error("[BUILD] getProjects() FAILED:", err.message);
    console.error("[BUILD] Full error object:", err);
    return null;
  }
}

async function updateLeaderboard(forceNew = false) {
  console.log("[UPDATE] === Starting leaderboard update (forceNew: " + forceNew + ") ===");
  const text = await buildLeaderboardText();
  if (!text) {
    console.error("[UPDATE] No text built — aborting");
    return;
  }

  if (!forceNew && pinnedMessageId) {
    console.log(`[UPDATE] Trying to edit pinned message ${pinnedMessageId}`);
    const edited = await editMessage(pinnedMessageId, text);
    if (edited) {
      console.log("[UPDATE] Edited successfully");
      return;
    }
    console.log("[UPDATE] Edit failed — will send new");
  }

  console.log("[UPDATE] Sending NEW leaderboard message");
  const data = await sendMessage(text, false); // loud notification for new pin
  if (data.ok) {
    pinnedMessageId = data.result.message_id;
    console.log(`[UPDATE] New message sent — pinning ${pinnedMessageId}`);
    await pinMessage(pinnedMessageId);
  } else {
    console.error("[UPDATE] Send failed — cannot pin");
  }
  console.log("[UPDATE] === Update complete ===\n");
}

// Startup with test message + force new leaderboard
(async () => {
  console.log("[STARTUP] Bot starting up...");
  const providerOk = await initProvider();
  if (!providerOk) {
    console.error("[STARTUP] Cannot proceed without RPC");
    return;
  }

  // TEST MESSAGE — this will confirm if Telegram works at all
  console.log("[STARTUP] Sending startup test message...");
  await sendMessage(`*🤖 Jade Bot Restarted*\nRound #${ROUND_NUMBER} Leaderboard Active\nhttps://jade1.io`, false);

  // Force a fresh leaderboard (ignores any old pinned ID)
  await updateLeaderboard(true);

  // Periodic updates every 5 min
  setInterval(() => {
    console.log("[INTERVAL] Periodic update triggered");
    updateLeaderboard();
  }, 300000);
})();

// Manual endpoints
app.get('/force-update', async (req, res) => {
  console.log("[MANUAL] Force update requested");
  await updateLeaderboard(true);
  res.send('Forced new leaderboard — check logs/channel');
});

app.get('/test-send', async (req, res) => {
  console.log("[MANUAL] Test send requested");
  await sendMessage("*Test Message from Jade Bot*\nIf you see this, Telegram config is working!");
  res.send('Test message sent');
});

// Webhook unchanged (but added log)
app.post('/vote-webhook', async (req, res) => {
  console.log("[WEBHOOK] Received:", req.body);
  try {
    // ... same as before
    const { wallet, amount, projectName, projectSymbol } = req.body;
    const short = wallet.slice(0,6) + '...' + wallet.slice(-4);

    const msg = `
🗳 *New Vote!*

Wallet: \`${short}\`
Power: *${parseFloat(amount).toFixed(4)} JADE*
Project: *${projectName} (${projectSymbol})*
Round: #${ROUND_NUMBER}

https://jade1.io`.trim();

    await sendMessage(msg, false);
    await updateLeaderboard();

    res.json({ success: true });
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err);
    res.status(500).json({ error: 'failed' });
  }
});

app.get('/', (req, res) => res.send(`Jade Bot — Round #${ROUND_NUMBER} Live`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[STARTUP] Server listening on port ${PORT}`);
});
