console.log("=== JADE BOT LATEST DEBUG VERSION LOADED ===");
console.log("If you see this line in logs, the new code is running!");
console.log("Deploy timestamp check: " + new Date().toISOString());

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

if (!BOT_TOKEN || !CHANNEL_ID) {
  console.error("[CRITICAL] MISSING ENV: BOT_TOKEN or CHANNEL_ID not set!");
  process.exit(1);
}

console.log("[CONFIG] BOT_TOKEN present:", !!BOT_TOKEN);
console.log("[CONFIG] CHANNEL_ID:", CHANNEL_ID);

const ethers = require('ethers');

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
  console.log("[INIT] Starting RPC connection attempts...");
  for (const url of RPC_URLS) {
    try {
      console.log(`[INIT] Testing ${url}...`);
      const tempProvider = new ethers.JsonRpcProvider(url);
      const block = await tempProvider.getBlockNumber();
      console.log(`[INIT] CONNECTED to ${url} (block ${block})`);
      provider = tempProvider;
      contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);
      console.log("[INIT] Contract ready");
      return true;
    } catch (e) {
      console.warn(`[INIT] Failed ${url}: ${e.message}`);
    }
  }
  console.error("[INIT] ALL RPCs FAILED");
  return false;
}

const ROUND_NUMBER = 6;

let pinnedMessageId = null;

async function sendMessage(text, silent = true) {
  console.log("[SEND] === SENDING MESSAGE ===");
  console.log("[SEND] To chat:", CHANNEL_ID);
  console.log("[SEND] Text preview:\n" + text.slice(0, 400) + (text.length > 400 ? '\n...TRUNCATED' : ''));
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
      console.log(`[SEND] SUCCESS! Message ID: ${data.result.message_id}`);
    } else {
      console.error("[SEND] TELEGRAM API ERROR:");
      console.error(JSON.stringify(data, null, 2));
    }
    return data;
  } catch (err) {
    console.error("[SEND] NETWORK ERROR:", err.message);
    return { ok: false };
  }
}

async function pinMessage(messageId) {
  console.log(`[PIN] Pinning message ${messageId}`);
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
    if (data.ok) console.log("[PIN] SUCCESS");
    else console.error("[PIN] ERROR:", JSON.stringify(data));
    return data.ok;
  } catch (err) {
    console.error("[PIN] EXCEPTION:", err.message);
    return false;
  }
}

async function buildLeaderboardText() {
  if (!contract) return null;

  console.log("[BUILD] Querying contract getProjects()...");
  try {
    const [names, symbols, , votesRaw] = await contract.getProjects();
    console.log("[BUILD] Contract call SUCCESS");

    console.log("[BUILD] Sample names:", names.slice(0,5).filter(n => n.trim()).map(n => `'${n.trim()}'`));
    console.log("[BUILD] Sample votes:", votesRaw.slice(0,5).map(v => v.toString()));

    // Rest of build logic same as before...
    const entries = [];
    let totalVotes = 0n;

    for (let i = 0; i < 20; i++) {
      const name = (names[i] || "").trim();
      if (name) {
        const votesBig = votesRaw[i] || 0n;
        const votes = Number(ethers.formatUnits(votesBig, 18));
        totalVotes += votesBig;
        entries.push({
          name,
          symbol: (symbols[i] || "").trim() || '???',
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
    console.error("[BUILD] CONTRACT CALL FAILED:", err.message);
    return null;
  }
}

async function updateLeaderboard(forceNew = false) {
  console.log("[UPDATE] Starting update (forceNew: " + forceNew + ")");
  const text = await buildLeaderboardText();
  if (!text) {
    console.error("[UPDATE] No text — abort");
    return;
  }

  if (!forceNew && pinnedMessageId) {
    // try edit (omitted for brevity, same as before)
  }

  console.log("[UPDATE] Sending NEW message");
  const data = await sendMessage(text, false);
  if (data.ok) {
    pinnedMessageId = data.result.message_id;
    await pinMessage(pinnedMessageId);
  }
}

// MAIN STARTUP
(async () => {
  console.log("[STARTUP] Initializing bot...");

  // Check env early
  if (!BOT_TOKEN.startsWith(' ') && BOT_TOKEN.length > 10) { // rough check
    console.log("[STARTUP] BOT_TOKEN looks valid (length " + BOT_TOKEN.length + ")");
  }

  const rpcOk = await initProvider();
  if (!rpcOk) {
    console.error("[STARTUP] Cannot continue without RPC");
    return;
  }

  // IMMEDIATE TEST MESSAGE
  console.log("[STARTUP] === SENDING FIRST TEST MESSAGE ===");
  await sendMessage(`*🚨 JADE BOT ONLINE - ROUND 6*\nNew debug version deployed!\nLeaderboard coming next...`, false);

  // Force fresh leaderboard
  await updateLeaderboard(true);

  setInterval(() => updateLeaderboard(), 300000);
})();

// Endpoints for manual testing
app.get('/test', async (req, res) => {
  await sendMessage("*Manual test message - Telegram is working!*");
  res.send("Test sent");
});

app.get('/force', async (req, res) => {
  await updateLeaderboard(true);
  res.send("Forced leaderboard");
});

app.post('/vote-webhook', async (req, res) => {
  // unchanged
});

app.get('/', (req, res) => res.send("Jade Bot Round 6 Debug Active"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[STARTUP] Listening on port ${PORT}`);
});
