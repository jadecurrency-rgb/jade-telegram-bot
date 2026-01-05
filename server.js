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
const CHANNEL_ID = process.env.CHANNEL_ID; // e.g. -1001234567890

// Reliable BSC RPCs
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

const CONTRACT_ADDRESS = "0xD987b9869292B77655cde5A4Ab2EBA64C4659D03";

const ABI = [
  "function getProjects() view returns (string[20], string[20], address[20], uint256[20])",
  "function currentRound() view returns (uint256)"
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

async function updateLeaderboard() {
  if (!contract) {
    console.log("[WARN] Contract not initialized");
    return;
  }

  try {
    console.log("[UPDATE] Fetching leaderboard...");

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

    let text = `*Jade1 Live Leaderboard* — Round #4\n`;
    text += `Total Votes: *${Number(ethers.formatUnits(totalVotes, 18)).toFixed(0)} JADE*\n\n`;

    if (entries.length === 0 || totalVotes === 0n) {
      text += `⚠️ Round 4 just started — votes are accumulating!\nStake JADE & vote on https://jade1.io\n\n`;
    }

    entries.forEach((p, i) => {
      text += `${i + 1}. *${p.name} (${p.symbol})* — ${p.votes.toFixed(4)} JADE\n`;
    });

    text += `\nUpdated: ${new Date().toUTCString()}\nhttps://jade1.io`;

    if (!pinnedMessageId) {
      const data = await sendMessage(text);
      if (data.ok) {
        pinnedMessageId = data.result.message_id;
        console.log(`[NEW] Leaderboard sent - PIN message ID: ${pinnedMessageId}`);
      }
    } else {
      const edited = await editMessage(pinnedMessageId, text);
      if (!edited) {
        console.log("[FALLBACK] Edit failed → sending new message");
        const data = await sendMessage(text);
        if (data.ok) {
          pinnedMessageId = data.result.message_id;
          console.log(`[NEW FALLBACK] Leaderboard sent - PIN ID: ${pinnedMessageId}`);
        }
      } else {
        console.log("[SUCCESS] Leaderboard updated");
      }
    }
  } catch (err) {
    console.error("[ERROR] Leaderboard failed:", err.message);
  }
}

// Update every minute
setInterval(updateLeaderboard, 60_000);
updateLeaderboard(); // run immediately

// Optional: new vote notification webhook
app.post('/vote-webhook', async (req, res) => {
  try {
    const { wallet, amount, projectName, projectSymbol } = req.body;
    const short = wallet.slice(0,6) + '...' + wallet.slice(-4);

    const msg = `
🗳 *New Vote!*

Wallet: \`${short}\`
Power: *${parseFloat(amount).toFixed(4)} JADE*
Project: *${projectName} (${projectSymbol})*
Round: #4

https://jade1.io`.trim();

    await sendMessage(msg);
    res.json({ success: true });
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err);
    res.status(500).json({ error: 'failed' });
  }
});

app.get('/', (req, res) => res.send('Jade Bot — Round #4 Leaderboard Active'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bot running on port ${PORT}`);
});
