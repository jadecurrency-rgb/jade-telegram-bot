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
const CHAT_IDS = [
  process.env.CHANNEL_ID,
  process.env.GROUP_ID
].filter(Boolean);

// Best free/fast BSC RPCs prioritized (2026 current reliables - publicnode & bscrpc sync fastest)
const RPC_URLS = [
  "https://bsc-rpc.publicnode.com",
  "https://bscrpc.com",
  "https://rpc.ankr.com/bsc",
  "https://bsc.publicnode.com",
  "https://bsc-dataseed.binance.org/"
];

const ethers = require('ethers');

let pinnedMessageId = null;

async function sendToTelegram(chatId, text, parse_mode = "Markdown") {
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode,
        disable_web_page_preview: true
      })
    });
    const data = await response.json();
    console.log(`[TELEGRAM] Sent to ${chatId}: ${JSON.stringify(data)}`);
    return data;
  } catch (err) {
    console.error(`[ERROR] Send failed:`, err.message);
    return null;
  }
}

async function broadcastVote(message) {
  for (const chatId of CHAT_IDS) {
    if (chatId) await sendToTelegram(chatId, message);
  }
}

app.post('/vote-webhook', async (req, res) => {
  try {
    const { wallet, amount, projectName, projectSymbol } = req.body;
    console.log("[INFO] VOTE RECEIVED →", { wallet, amount, projectName, projectSymbol });

    const shortWallet = wallet.slice(0,6) + '...' + wallet.slice(-4);
    const message = `
🗳 *New Vote Detected!*

Wallet: \`${shortWallet}\`
Power: *${parseFloat(amount).toFixed(4)} JADE*
Project: *${projectName} (${projectSymbol})*
Round: #4

https://jade1.io
    `.trim();

    await broadcastVote(message);
    res.json({ success: true });
  } catch (err) {
    console.error("[ERROR] Webhook failed:", err.message);
    res.status(500).json({ error: 'failed' });
  }
});

async function updateLeaderboard() {
  let usedRPC = null;
  let projects = null;

  // Try RPCs one by one until we get fresh data (low total votes = Round 4 fresh start)
  for (const url of RPC_URLS) {
    try {
      console.log(`[RPC TRY] Attempting ${url}`);
      const tempProvider = new ethers.JsonRpcProvider(url);
      const blockNumber = await tempProvider.getBlockNumber();
      console.log(`[RPC] ${url} - current block: ${blockNumber}`);

      const tempContract = new ethers.Contract(
        "0xD987b9869292B77655cde5A4Ab2EBA64C4659D03",
        [
          "function getProjects() view returns (string[20], string[20], address[20], uint256[20])"
        ],
        tempProvider
      );

      const tempProjects = await tempContract.getProjects();
      const [names, , , votesRaw] = tempProjects;

      let tempTotal = 0n;
      for (const v of votesRaw) tempTotal += v;

      const formattedTotal = Number(ethers.formatUnits(tempTotal, 18));

      console.log(`[RPC DATA] ${url} - Total votes: ${formattedTotal} | First name: ${names[0]?.trim() || '[EMPTY]'}`);

      // Fresh Round 4: total votes very low (< 100 JADE currently), old Round 3 had millions
      if (formattedTotal < 100) {
        projects = tempProjects;
        usedRPC = url;
        console.log(`[SUCCESS] Fresh data from ${url}`);
        break;
      } else {
        console.warn(`[STALE] ${url} shows old Round 3 data (high votes) - skipping`);
      }
    } catch (e) {
      console.warn(`[FAIL] ${url} error: ${e.message}`);
    }
  }

  if (!projects) {
    console.error("[CRITICAL] All RPCs stale or failed - using last attempt or skipping update");
    return; // Or fallback to hardcoded if needed
  }

  console.log(`[INFO] Using fresh data from RPC: ${usedRPC}`);

  const [names, symbols, , votesRaw] = projects;

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

  if (totalVotes < 1000000000000000000n) { // < ~1 JADE
    text += `⚠️ Round 4 just started — votes accumulating!\nStake JADE & vote: https://jade1.io\nRankings update live.\n\n`;
  }

  entries.forEach((p, i) => {
    text += `${i + 1}. *${p.name} (${p.symbol})* — ${p.votes.toFixed(4)} JADE\n`;
  });

  text += `\nUpdated: ${new Date().toUTCString()}\nhttps://jade1.io`;

  const leaderboardChat = process.env.CHANNEL_ID;
  if (!leaderboardChat) return;

  if (!pinnedMessageId) {
    const data = await sendToTelegram(leaderboardChat, text);
    if (data?.ok) {
      pinnedMessageId = data.result.message_id;
      console.log(`[INFO] NEW leaderboard sent - ID: ${pinnedMessageId} (PIN THIS MANUALLY)`);
    }
  } else {
    const editResponse = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: leaderboardChat,
        message_id: pinnedMessageId,
        text,
        parse_mode: 'Markdown'
      })
    });
    const editData = await editResponse.json();

    if (!editData.ok) {
      console.error("[ERROR] Edit failed:", editData.description);
      const data = await sendToTelegram(leaderboardChat, text);
      if (data?.ok) {
        pinnedMessageId = data.result.message_id;
        console.log(`[INFO] FALLBACK new sent - ID: ${pinnedMessageId} (PIN THIS)`);
      }
    } else {
      console.log("[SUCCESS] Leaderboard updated");
    }
  }
}

setInterval(updateLeaderboard, 60000);
updateLeaderboard();

app.get('/', (req, res) => res.send('Jade Bot - Round #4 with Anti-Lag RPC Logic'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
