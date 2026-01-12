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
const CHANNEL_ID = process.env.CHANNEL_ID;

const ethers = require('ethers');

// Reliable BSC RPCs (prioritized official/fast ones)
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
let currentRound = 5; // initial fallback

const CONTRACT_ADDRESS = "0x9AccD1f82330ADE9E3Eb9fAb9c069ab98D5bB42a"; // Your confirmed Round 5 contract

const ABI = [
  "function getProjects() view returns (string[20], string[20], address[20], uint256[20])",
  "function currentRound() view returns (uint256)"
];

async function selectBestProvider() {
  let best = { round: 0n };

  console.log("[RPC SELECTION] Checking RPCs for latest round...");

  for (const url of RPC_URLS) {
    try {
      const tempProvider = new ethers.JsonRpcProvider(url);
      await tempProvider.getBlockNumber(); // connectivity check

      const tempContract = new ethers.Contract(CONTRACT_ADDRESS, ABI, tempProvider);
      const roundBig = await tempContract.currentRound();
      const roundNum = Number(roundBig);

      console.log(`[RPC] ${url} → currentRound #${roundNum}`);

      if (roundNum > best.round) {
        best = { url, round: roundBig, provider: tempProvider, contract: tempContract };
      }
    } catch (e) {
      console.warn(`[RPC SKIP] ${url}: ${e.message}`);
    }
  }

  if (best.provider) {
    provider = best.provider;
    contract = best.contract;
    currentRound = Number(best.round);
    console.log(`[SUCCESS] Selected best RPC with currentRound #${currentRound}`);
  } else {
    console.error("[FALLBACK] No good RPC - using first");
    provider = new ethers.JsonRpcProvider(RPC_URLS[0]);
    contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);
    currentRound = 5;
  }

  // Extra confirmation fetch
  try {
    const roundBig = await contract.currentRound();
    currentRound = Number(roundBig);
    console.log(`[CONFIRMED] On-chain currentRound: #${currentRound}`);
  } catch (e) {
    console.warn("[WARN] Final round confirm failed - using fallback #5");
  }
}

// Run selection on startup + every 30 min (in case of future resets)
selectBestProvider();
setInterval(selectBestProvider, 30 * 60 * 1000);

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
    console.error("[SEND ERROR]", err.message);
    return { ok: false };
  }
}

async function updateLeaderboard() {
  if (!contract) {
    console.log("[WARN] Contract/provider not ready");
    return;
  }

  try {
    console.log("[UPDATE] Fetching fresh leaderboard data...");

    // Retry up to 3 times with delay (handles any temporary RPC lag)
    let data;
    for (let i = 0; i < 3; i++) {
      try {
        data = await contract.getProjects();
        break;
      } catch (e) {
        console.warn(`[RETRY ${i+1}] getProjects failed: ${e.message}`);
        await new Promise(r => setTimeout(r, 10000)); // 10s wait
      }
    }
    if (!data) throw new Error("Failed after retries");

    const [names, symbols, , votesRaw] = data;

    console.log("[DEBUG] Current projects from chain:", names.map(n => n?.trim()).filter(Boolean));

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

    // FORCE send new message every update (temporary to clear old Round 4 pins)
    const msgData = await sendMessage(text);
    if (msgData.ok) {
      console.log(`[FORCED NEW] Sent fresh Round #${currentRound} leaderboard`);
    }
  } catch (err) {
    console.error("[UPDATE ERROR]", err.message);
  }
}

// Update every minute
setInterval(updateLeaderboard, 60000);
updateLeaderboard(); // run immediately + with initial delay for safety

// Webhook uses dynamic round
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
app.listen(PORT, '0.0.0.0', () => console.log(`Bot running on port ${PORT}`));
