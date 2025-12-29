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

  // CHANGED RPC to a potentially fresher seed
  const primaryRpc = "https://bsc-dataseed1.binance.org/";
  provider = new ethers.JsonRpcProvider(primaryRpc);
  console.log(`Using RPC: ${primaryRpc}`);

  // Fallback if primary fails (uncomment if needed after testing)
  // provider = new ethers.FallbackProvider([
  //   new ethers.JsonRpcProvider(primaryRpc),
  //   new ethers.JsonRpcProvider("https://bsc-dataseed2.binance.org/")
  // ]);

  votingContract = new ethers.Contract(
    "0x8613481dBe0162ceA781f545B59901f76226954a",
    [
      "function getProjects() view returns (string[20], string[20], address[20], uint256[20])",
      "function currentRound() view returns (uint256)"
    ],
    provider
  );

  console.log("Ethers v6 loaded — leaderboard enabled");
} catch (err) {
  console.error("Ethers failed (leaderboard disabled):", err.message);
}

let pinnedMessageId = null;

async function sendToTelegram(chatId, text, parse_mode = "Markdown") {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode, disable_web_page_preview: true })
    });
  } catch (err) {
    console.error(`Send failed to ${chatId}:`, err.message);
  }
}

async function broadcastVote(message) {
  for (const chatId of CHAT_IDS) await sendToTelegram(chatId, message);
}

// Vote webhook — instant notifications
app.post('/vote-webhook', async (req, res) => {
  try {
    const { wallet, amount, projectName, projectSymbol, round } = req.body;
    console.log("VOTE RECEIVED →", { wallet, amount, projectName, projectSymbol, round });

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
    console.error("Webhook error:", err);
    res.status(500).json({ error: 'failed' });
  }
});

// Leaderboard update with DEBUG for fetched projects
async function updateLeaderboard() {
  if (!votingContract) {
    console.log("[DEBUG] Voting contract not available - skipping");
    return;
  }

  try {
    console.log("[DEBUG] Starting fetch for Round #3");

    const projects = await votingContract.getProjects();
    const [names, symbols, , votesRaw] = projects;

    // DEBUG: Show what the contract actually returns
    const first5Names = names.slice(0, 5).map(n => n?.trim() || '[EMPTY]').join(", ");
    console.log(`[DEBUG] Fetched first 5 project names: ${first5Names}`);
    console.log(`[DEBUG] Names array length: ${names.length}`);

    const entries = [];
    let totalVotes = 0n;

    for (let i = 0; i < 20; i++) {
      const name = names[i]?.trim();
      const symbol = symbols[i]?.trim();
      if (name && name.length > 0) {
        const votesBig = votesRaw[i] || 0n;
        const votes = Number(ethers.formatUnits(votesBig, 18));
        totalVotes += votesBig;
        entries.push({ name, symbol, votes });
      }
    }

    console.log(`[DEBUG] Valid projects extracted: ${entries.length}`);

    // Sort descending by votes → enables live ranking movement when votes >0
    entries.sort((a, b) => b.votes - a.votes);

    let text = `*Jade1 Live Leaderboard* — Round #3\n`;
    text += `Total Votes: *${Number(ethers.formatUnits(totalVotes, 18)).toFixed(0)} JADE*\n\n`;

    if (entries.length === 0 || totalVotes === 0n) {
      text += `⚠️ Round 3 active — votes reset to zero!\nStake JADE & vote on https://jade1.io\nRankings update live as votes accumulate.\n\n`;
    }

    if (entries.length === 0) {
      text += `[DEBUG] No projects found - check contract/RPC\n`;
    } else {
      entries.forEach((p, i) => {
        text += `${i + 1}. *${p.name} (${p.symbol || '???'} )* — ${p.votes.toFixed(4)} JADE\n`;
      });
    }

    text += `\nUpdated: ${new Date().toUTCString()}\nhttps://jade1.io`;

    const leaderboardChat = process.env.CHANNEL_ID;
    if (!leaderboardChat) return console.log("[DEBUG] No CHANNEL_ID set");

    if (!pinnedMessageId) {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: leaderboardChat, text, parse_mode: 'Markdown' })
      });
      const data = await res.json();
      if (data.ok) {
        pinnedMessageId = data.result.message_id;
        console.log(`[DEBUG] New leaderboard sent → ID: ${pinnedMessageId}`);
      } else {
        console.error("[DEBUG] Send failed:", data.description);
      }
    } else {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: leaderboardChat, message_id: pinnedMessageId, text, parse_mode: 'Markdown' })
      });
      console.log("[DEBUG] Leaderboard edited");
    }
  } catch (err) {
    console.error("[DEBUG] Leaderboard fetch error:", err.message);
  }
}

setInterval(updateLeaderboard, 60000);
updateLeaderboard();

app.get('/', (req, res) => res.send('Jade Bot + Debug Running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
