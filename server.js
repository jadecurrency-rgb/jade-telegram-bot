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

let ethers, provider, votingContract;
try {
  ethers = require('ethers');

  // Fresher RPC endpoint
  const rpcUrl = "https://bsc-dataseed1.binance.org/";
  provider = new ethers.JsonRpcProvider(rpcUrl);
  console.log(`[INFO] Using RPC: ${rpcUrl}`);

  votingContract = new ethers.Contract(
    "0x8613481dBe0162ceA781f545B59901f76226954a",
    [
      "function getProjects() view returns (string[20], string[20], address[20], uint256[20])",
      "function currentRound() view returns (uint256)"
    ],
    provider
  );

  console.log("[INFO] Ethers v6 loaded — leaderboard enabled");
} catch (err) {
  console.error("[ERROR] Ethers initialization failed:", err.message);
}

let pinnedMessageId = null;

async function sendToTelegram(chatId, text, parse_mode = "Markdown") {
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode, disable_web_page_preview: true })
    });
    const data = await response.json();
    console.log(`[DEBUG] Send to Telegram response: ${JSON.stringify(data)}`);
    return data;
  } catch (err) {
    console.error(`[ERROR] Send failed to ${chatId}:`, err.message);
  }
}

async function broadcastVote(message) {
  for (const chatId of CHAT_IDS) await sendToTelegram(chatId, message);
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
    console.error("[ERROR] Webhook error:", err);
    res.status(500).json({ error: 'failed' });
  }
});

// Main leaderboard function with heavy debugging
async function updateLeaderboard() {
  if (!votingContract) {
    console.log("[DEBUG] Voting contract not available - skipping update");
    return;
  }

  try {
    console.log("[DEBUG] Starting leaderboard update for Round #3");

    const projects = await votingContract.getProjects();
    const [names, symbols, addresses, votesRaw] = projects;

    // Debug: Show what we actually received from contract
    console.log("[DEBUG] Raw names array length:", names.length);
    const first5Names = names.slice(0, 5).map(n => n?.trim() || '[EMPTY]').join(", ");
    console.log("[DEBUG] Fetched first 5 project names:", first5Names);
    console.log("[DEBUG] First project symbol:", symbols[0]?.trim() || '[EMPTY]');
    console.log("[DEBUG] First project address:", addresses[0] || '[EMPTY]');
    console.log("[DEBUG] First project raw votes:", votesRaw[0]?.toString() || '0');

    const entries = [];
    let totalVotes = 0n;

    for (let i = 0; i < 20; i++) {
      const name = names[i]?.trim();
      if (name && name.length > 0) {
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

    console.log("[DEBUG] Total valid projects extracted:", entries.length);

    // Sort for live ranking changes (will update when votes > 0)
    entries.sort((a, b) => b.votes - a.votes);

    let text = `*Jade1 Live Leaderboard* — Round #3\n`;
    text += `Total Votes: *${Number(ethers.formatUnits(totalVotes, 18)).toFixed(0)} JADE*\n\n`;

    if (entries.length === 0 || totalVotes === 0n) {
      text += `⚠️ Round 3 active — votes reset to zero!\nStake JADE & vote on https://jade1.io\nRankings update live as votes accumulate.\n\n`;
    }

    if (entries.length === 0) {
      text += `[DEBUG] No projects loaded from contract - possible RPC lag or update pending\n`;
    } else {
      entries.forEach((p, i) => {
        text += `${i + 1}. *${p.name} (${p.symbol})* — ${p.votes.toFixed(4)} JADE\n`;
      });
    }

    text += `\nUpdated: ${new Date().toUTCString()}\nhttps://jade1.io`;

    const leaderboardChat = process.env.CHANNEL_ID;
    if (!leaderboardChat) {
      console.log("[DEBUG] CHANNEL_ID not set - cannot update");
      return;
    }

    if (!pinnedMessageId) {
      const data = await sendToTelegram(leaderboardChat, text);
      if (data?.ok) {
        pinnedMessageId = data.result.message_id;
        console.log(`[DEBUG] New leaderboard sent - Message ID: ${pinnedMessageId} (pin manually)`);
      }
    } else {
      const editResponse = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: leaderboardChat, message_id: pinnedMessageId, text, parse_mode: 'Markdown' })
      });
      const editData = await editResponse.json();
      console.log(`[DEBUG] Edit response: ${JSON.stringify(editData)}`);
      if (editData.ok) {
        console.log("[DEBUG] Leaderboard successfully updated");
      } else {
        console.error("[ERROR] Edit failed:", editData.description || editData);
      }
    }
  } catch (err) {
    console.error("[ERROR] Leaderboard update failed:", err.message);
  }
}

// Update every 60 seconds + initial run
setInterval(updateLeaderboard, 60000);
updateLeaderboard();

app.get('/', (req, res) => res.send('Jade Bot + Live Leaderboard Running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
