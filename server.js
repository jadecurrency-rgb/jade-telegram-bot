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

// Reliable BSC RPCs - prioritized faster/official ones first
const RPC_URLS = [
  "https://bsc-dataseed.binance.org/",       // Official - usually fastest
  "https://bsc-dataseed1.defibit.io/",
  "https://bsc-dataseed1.ninicoin.io/",
  "https://bsc-dataseed2.binance.org/",
  "https://rpc.ankr.com/bsc",
  "https://bsc-rpc.publicnode.com",
  "https://bscrpc.com",
  "https://bsc.publicnode.com"
];

const CONTRACT_ADDRESS = "0x9AccD1f82330ADE9E3Eb9fAb9c069ab98D5bB42a";

const ABI = [
  "function getProjects() view returns (string[20], string[20], address[20], uint256[20])",
  "function currentRound() view returns (uint256)"
];

let provider = null;
let contract = null;
let currentRound = 5; // fallback if cannot read

async function selectBestProvider() {
  let best = { url: null, round: 0n, provider: null, contract: null };

  for (const url of RPC_URLS) {
    try {
      const tempProvider = new ethers.JsonRpcProvider(url);
      // Quick connectivity check
      await tempProvider.getBlockNumber();

      const tempContract = new ethers.Contract(CONTRACT_ADDRESS, ABI, tempProvider);

      // Fetch currentRound - this is the key to detect latest state
      const roundBig = await tempContract.currentRound();
      const roundNum = Number(roundBig);

      console.log(`[RPC CHECK] ${url} → currentRound: #${roundNum}`);

      if (roundNum > best.round) {
        best = { url, round: roundNum, provider: tempProvider, contract: tempContract };
      }
    } catch (e) {
      console.warn(`[RPC SKIP] ${url}: ${e.message}`);
    }
  }

  if (best.provider) {
    provider = best.provider;
    contract = best.contract;
    currentRound = Number(best.round);
    console.log(`[SUCCESS] Selected best RPC: ${best.url} with Round #${currentRound}`);
  } else {
    console.error("[CRITICAL] No working RPC found - using fallback");
    // Fallback to first RPC
    provider = new ethers.JsonRpcProvider(RPC_URLS[0]);
    contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);
  }

  // Final fallback attempt to read round
  try {
    const roundBig = await contract.currentRound();
    currentRound = Number(roundBig);
    console.log(`[FINAL] Current round confirmed: #${currentRound}`);
  } catch (e) {
    console.warn("[WARN] Could not confirm currentRound - using fallback #5");
  }
}

// Run provider selection on startup
selectBestProvider();

let pinnedMessageId = null; // Will force new message below

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
    console.log("[WARN] Contract not ready");
    return;
  }

  // Re-select best provider every hour (in case of RPC lag resolution)
  // Remove or adjust if not needed
  // if (Date.now() % (60*60*1000) < 60000) await selectBestProvider();

  try {
    console.log("[UPDATE] Fetching latest leaderboard...");

    const [names, symbols, , votesRaw] = await contract.getProjects();

    console.log("[DEBUG] Raw project names:", names.map(n => n?.trim()).filter(Boolean));

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

    let text = `*Jade1 Live Leaderboard* — Round #${currentRound}\n`;
    text += `Total Votes: *${Number(ethers.formatUnits(totalVotes, 18)).toFixed(0)} JADE*\n\n`;

    if (entries.length === 0 || totalVotes === 0n) {
      text += `⚠️ Round ${currentRound} just started — votes are accumulating!\nStake JADE & vote on https://jade1.io\n\n`;
    }

    entries.forEach((p, i) => {
      text += `${i + 1}. *${p.name} (${p.symbol})* — ${p.votes.toFixed(4)} JADE\n`;
    });

    text += `\nUpdated: ${new Date().toUTCString()}\nhttps://jade1.io`;

    // Force new message on first few runs or if no pin (to override any old pinned)
    const data = await sendMessage(text);
    if (data.ok) {
      pinnedMessageId = data.result.message_id;
      console.log(`[NEW/REFRESH] Leaderboard sent - PIN ID: ${pinnedMessageId}`);
    }

    // After first send, switch to edit mode for subsequent updates
    // Comment the above force-send and uncomment below if you want normal edit after first
    /*
    if (!pinnedMessageId) {
      const data = await sendMessage(text);
      if (data.ok) pinnedMessageId = data.result.message_id;
    } else {
      const edited = await editMessage(pinnedMessageId, text);
      if (!edited) {
        const data = await sendMessage(text);
        if (data.ok) pinnedMessageId = data.result.message_id;
      }
    }
    */
  } catch (err) {
    console.error("[ERROR] Fetch failed:", err.message);
  }
}

setInterval(updateLeaderboard, 60_000);
updateLeaderboard(); // immediate

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
