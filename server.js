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

// More reliable RPCs with fallback (Dec 2025 status)
const RPC_URLS = [
  "https://bsc.publicnode.com",
  "https://bsc-dataseed.binance.org/",
  "https://bsc-dataseed2.binance.org/",
  "https://bsc-dataseed3.binance.org/",
  "https://rpc.ankr.com/bsc"
];

let ethers, provider, votingContract;

try {
  ethers = require('ethers');

  // Try connecting to RPCs one by one
  for (const url of RPC_URLS) {
    try {
      const tempProvider = new ethers.JsonRpcProvider(url);
      // Quick validation
      await tempProvider.getBlockNumber();
      provider = tempProvider;
      console.log(`[SUCCESS] Connected to RPC: ${url}`);
      break;
    } catch (e) {
      console.warn(`[SKIP] RPC failed: ${url} → ${e.message}`);
    }
  }

  if (!provider) {
    throw new Error("All RPC endpoints failed. Bot cannot read blockchain data.");
  }

  votingContract = new ethers.Contract(
    "0x8613481dBe0162ceA781f545B59901f76226954a",
    [
      "function getProjects() view returns (string[20], string[20], address[20], uint256[20])",
      "function currentRound() view returns (uint256)"
    ],
    provider
  );

  console.log("[INFO] Ethers v6 loaded + contract initialized — leaderboard enabled");
} catch (err) {
  console.error("[CRITICAL] Ethers/contract initialization failed:", err.message);
  console.error(err);
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
    console.log(`[TELEGRAM] Send response for ${chatId}: ${JSON.stringify(data)}`);
    return data;
  } catch (err) {
    console.error(`[ERROR] Telegram send failed to ${chatId}:`, err.message);
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
    const { wallet, amount, projectName, projectSymbol, round } = req.body;
    console.log("[INFO] VOTE RECEIVED →", { wallet, amount, projectName, projectSymbol, round });

    const shortWallet = wallet.slice(0,6) + '...' + wallet.slice(-4);
    const message = `
🗳 *New Vote Detected!*

Wallet: \`${shortWallet}\`
Power: *${parseFloat(amount).toFixed(4)} JADE*
Project: *${projectName} (${projectSymbol})*
Round: #3

https://jade1.io
    `.trim();

    await broadcastVote(message);
    res.json({ success: true });
  } catch (err) {
    console.error("[ERROR] Webhook processing failed:", err.message);
    res.status(500).json({ error: 'failed' });
  }
});

async function updateLeaderboard() {
  if (!votingContract || !provider) {
    console.log("[WARNING] Cannot update leaderboard — contract/provider not available");
    return;
  }

  try {
    console.log("[DEBUG] Starting leaderboard update — Round #3");

    console.log("[DEBUG] Calling getProjects()...");
    const projects = await votingContract.getProjects();
    console.log("[DEBUG] getProjects() returned successfully");

    const [names, symbols, addresses, votesRaw] = projects;

    // Safety check
    if (!Array.isArray(names) || names.length === 0) {
      throw new Error("getProjects returned invalid or empty names array");
    }

    console.log("[DEBUG] Raw names array length:", names.length);
    console.log("[DEBUG] First 5 project names:", names.slice(0, 5).map(n => n?.trim() || '[EMPTY]').join(", "));
    console.log("[DEBUG] First symbol:", symbols[0]?.trim() || '[EMPTY]');
    console.log("[DEBUG] First votes raw:", votesRaw[0]?.toString() || '0');

    const entries = [];
    let totalVotes = 0n;

    for (let i = 0; i < 20; i++) {
      const name = names[i]?.trim?.() || "";
      if (name.length > 0 && name !== "") {
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

    console.log("[DEBUG] Valid projects found:", entries.length);

    entries.sort((a, b) => b.votes - a.votes);

    let text = `*Jade1 Live Leaderboard* — Round #3\n`;
    text += `Total Votes: *${Number(ethers.formatUnits(totalVotes, 18)).toFixed(0)} JADE*\n\n`;

    if (entries.length === 0 || totalVotes === 0n) {
      text += `⚠️ Round 3 active — votes reset to zero or no projects loaded yet!\nStake JADE & vote on https://jade1.io\nRankings update live as votes accumulate.\n\n`;
    }

    if (entries.length === 0) {
      text += `[INFO] No projects loaded from contract — possible round transition or RPC issue\n`;
    } else {
      entries.forEach((p, i) => {
        text += `${i + 1}. *${p.name} (${p.symbol})* — ${p.votes.toFixed(4)} JADE\n`;
      });
    }

    text += `\nUpdated: ${new Date().toUTCString()}\nhttps://jade1.io`;

    const leaderboardChat = process.env.CHANNEL_ID;
    if (!leaderboardChat) {
      console.log("[WARNING] CHANNEL_ID not set — skipping leaderboard update");
      return;
    }

    if (!pinnedMessageId) {
      const data = await sendToTelegram(leaderboardChat, text);
      if (data?.ok) {
        pinnedMessageId = data.result.message_id;
        console.log(`[INFO] New leaderboard sent — pinned message ID: ${pinnedMessageId} (pin manually if needed)`);
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
      console.log(`[DEBUG] EditMessageText response: ${JSON.stringify(editData)}`);

      if (!editData.ok) {
        console.error("[ERROR] Failed to edit pinned message:", editData.description || editData);
      } else {
        console.log("[SUCCESS] Leaderboard updated successfully");
      }
    }
  } catch (err) {
    console.error("[ERROR] Leaderboard update failed:", err.shortMessage || err.message);
    console.error(err);
  }
}

// Run immediately + every 60 seconds
setInterval(updateLeaderboard, 60000);
updateLeaderboard();

app.get('/', (req, res) => res.send('Jade Bot + Live Leaderboard Running (Dec 2025 version)'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
