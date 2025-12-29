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

  provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org/");
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

// Leaderboard update - Forced Round 3 + zero-vote handling (new round reset)
async function updateLeaderboard() {
  if (!votingContract) {
    console.log("Voting contract not available - skipping update");
    return;
  }

  try {
    // Force Round 3 to match jade1.io (website shows Round 3 active)
    const displayRound = "3";
    console.log(`[Leaderboard] Forcing display to Round #${displayRound} (jade1.io is on Round 3)`);

    // Fetch current projects from contract
    const projects = await votingContract.getProjects();
    const [names, symbols, , votesRaw] = projects;

    // Collect valid projects
    const entries = [];
    let totalVotes = 0n; // Use BigInt for precision

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

    // Sort by votes descending
    entries.sort((a, b) => b.votes - a.votes);

    // Build leaderboard text
    let text = `*Jade1 Live Leaderboard* — Round #${displayRound}\n`;
    text += `Total Votes: *${Number(ethers.formatUnits(totalVotes, 18)).toFixed(0)} JADE*\n\n`;

    // Zero votes warning (very common right after round start/reset)
    if (entries.every(p => p.votes === 0)) {
      text += `⚠️ Round 3 just started — votes reset to zero!\nStake JADE & vote on https://jade1.io\nVotes will appear as community participates.\n\n`;
    }

    for (let i = 0; i < Math.min(entries.length, 20); i++) {
      const p = entries[i];
      text += `${i + 1}. *${p.name} (${p.symbol})* — ${p.votes.toFixed(4)} JADE\n`;
    }

    text += `\nUpdated: ${new Date().toUTCString()}\nhttps://jade1.io`;

    const leaderboardChat = process.env.CHANNEL_ID;
    if (!leaderboardChat) {
      console.log("CHANNEL_ID not set - cannot update leaderboard");
      return;
    }

    if (!pinnedMessageId) {
      // Send new pinned message
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          chat_id: leaderboardChat, 
          text, 
          parse_mode: 'Markdown',
          disable_web_page_preview: true 
        })
      });
      const data = await res.json();
      if (data.ok) {
        pinnedMessageId = data.result.message_id;
        console.log(`Initial leaderboard sent & should be pinned. ID: ${pinnedMessageId}`);
      } else {
        console.error("Failed to send leaderboard:", data.description);
      }
    } else {
      // Edit existing pinned message
      const editRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          chat_id: leaderboardChat, 
          message_id: pinnedMessageId, 
          text, 
          parse_mode: 'Markdown' 
        })
      });
      const editData = await editRes.json();
      if (editData.ok) {
        console.log("Leaderboard edited successfully");
      } else {
        console.error("Edit failed:", editData.description);
      }
    }
  } catch (err) {
    console.error("Leaderboard update error:", err.message);
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
