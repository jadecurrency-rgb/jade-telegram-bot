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

// Prioritized reliable/fast RPCs first (Ankr and publicnode are best for fresh state)
const RPC_URLS = [
  "https://rpc.ankr.com/bsc",
  "https://bsc.publicnode.com",
  "https://bsc-dataseed.binance.org/",
  "https://bsc-dataseed2.binance.org/",
  "https://bsc-dataseed3.binance.org/"
];

let ethers, provider, votingContract;

try {
  ethers = require('ethers');

  for (const url of RPC_URLS) {
    try {
      const tempProvider = new ethers.JsonRpcProvider(url);
      const block = await tempProvider.getBlockNumber();
      provider = tempProvider;
      console.log(`[SUCCESS] Connected to RPC: ${url} | Current block: ${block}`);
      break;
    } catch (e) {
      console.warn(`[SKIP] RPC failed: ${url} → ${e.message}`);
    }
  }

  if (!provider) {
    throw new Error("All RPC endpoints failed.");
  }

  // Log initial block for debug
  const initBlock = await provider.getBlockNumber();
  console.log(`[INFO] Initial block number: ${initBlock}`);

  votingContract = new ethers.Contract(
    "0xD987b9869292B77655cde5A4Ab2EBA64C4659D03",
    [
      "function getProjects() view returns (string[20], string[20], address[20], uint256[20])",
      "function currentRound() view returns (uint256)"
    ],
    provider
  );

  console.log("[INFO] Contract initialized");
} catch (err) {
  console.error("[CRITICAL] Initialization failed:", err.message);
}

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
    console.log(`[TELEGRAM] Send to ${chatId}: ${JSON.stringify(data)}`);
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
  if (!votingContract || !provider) {
    console.log("[WARNING] Contract/provider unavailable");
    return;
  }

  try {
    const block = await provider.getBlockNumber();
    console.log(`[DEBUG] Update start | Current block: ${block}`);

    const contractRound = await votingContract.currentRound();
    console.log(`[DEBUG] Contract currentRound: ${contractRound}`);

    const projects = await votingContract.getProjects();
    const [names, symbols, addresses, votesRaw] = projects;

    console.log("[DEBUG] Raw names:", names);
    console.log("[DEBUG] Raw symbols:", symbols);
    console.log("[DEBUG] Raw votes (formatted):", votesRaw.map(v => Number(ethers.formatUnits(v, 18)).toFixed(4)));

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
      text += `⚠️ Round 4 just started — votes are still at zero!\nStake JADE & vote: https://jade1.io\nRankings update live.\n\n`;
    } else {
      entries.forEach((p, i) => {
        text += `${i + 1}. *${p.name} (${p.symbol})* — ${p.votes.toFixed(4)} JADE\n`;
      });
    }

    text += `\nUpdated: ${new Date().toUTCString()}\nhttps://jade1.io`;

    const leaderboardChat = process.env.CHANNEL_ID;
    if (!leaderboardChat) return;

    if (!pinnedMessageId) {
      const data = await sendToTelegram(leaderboardChat, text);
      if (data?.ok) {
        pinnedMessageId = data.result.message_id;
        console.log(`[INFO] New leaderboard sent — ID: ${pinnedMessageId}`);
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
          console.log(`[INFO] Fallback new sent — ID: ${pinnedMessageId}`);
        }
      } else {
        console.log("[SUCCESS] Leaderboard updated");
      }
    }
  } catch (err) {
    console.error("[ERROR] Update failed:", err.message);
  }
}

setInterval(updateLeaderboard, 60000);
updateLeaderboard();

app.get('/', (req, res) => res.send('Jade Bot Running - Round 4 Debug Version'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
