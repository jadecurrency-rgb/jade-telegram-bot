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
const CHAT_IDS = [
  process.env.CHANNEL_ID,
  process.env.GROUP_ID
].filter(Boolean);

// === MANUAL ROUND OVERRIDE - FORCE ROUND 2 ===
const MANUAL_ROUND_OVERRIDE = "2";   // Remove or set to null when you want on-chain value again
// =============================================

let ethers, provider, votingContract;
try {
  ethers = require('ethers');

  provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org/");
  votingContract = new ethers.Contract(
    "0x1144eCa36680aE3fA7a2146b67F0db81A38ac403",
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

// Vote webhook — instant notifications (already working!)
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
Round: #${round}

https://jade1.io
    `.trim();

    await broadcastVote(message);
    res.json({ success: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: 'failed' });
  }
});

// Safe leaderboard update with MANUAL ROUND OVERRIDE
async function updateLeaderboard() {
  if (!votingContract) return;

  try {
    let round;
    
    if (MANUAL_ROUND_OVERRIDE) {
      round = MANUAL_ROUND_OVERRIDE;
    } else {
      const roundBig = await votingContract.currentRound();
      round = roundBig.toString();
    }

    const [, projects] = await Promise.all([
      // roundBig already handled above
      votingContract.getProjects()
    ]);

    const [names, symbols, _, votesRaw] = projects;

    // Collect all valid projects
    const entries = [];
    let totalVotes = 0;
    for (let i = 0; i < 20; i++) {
      if (names[i]?.trim()) {
        const votes = Number(ethers.formatUnits(votesRaw[i] || 0n, 18));
        totalVotes += votes;
        entries.push({
          name: names[i],
          symbol: symbols[i],
          votes: votes
        });
      }
    }

    // Sort by votes descending
    entries.sort((a, b) => b.votes - a.votes);

    // Build formatted leaderboard
    let text = `*Jade1 Live Leaderboard* — Round #${round}\n`;
    text += `Total Votes: *${totalVotes.toFixed(0)} JADE*\n\n`;

    for (let i = 0; i < Math.min(entries.length, 20); i++) {
      const p = entries[i];
      text += `${i + 1}. *${p.name} (${p.symbol})* — ${p.votes.toFixed(4)} JADE\n`;
    }

    text += `\nUpdated: ${new Date().toUTCString()}\nhttps://jade1.io`;

    const leaderboardChat = process.env.CHANNEL_ID;
    if (!leaderboardChat) return;

    if (!pinnedMessageId) {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: leaderboardChat, text, parse_mode: 'Markdown' })
      });
      const data = await res.json();
      if (data.ok) {
        pinnedMessageId = data.result.message_id;
        console.log("Leaderboard sent! PIN THIS MESSAGE → ID:", pinnedMessageId);
      }
    } else {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: leaderboardChat, message_id: pinnedMessageId, text, parse_mode: 'Markdown' })
      });
    }
  } catch (err) {
    console.error("Leaderboard failed (safe):", err.message);
  }
}

// Update every 60 seconds
setInterval(updateLeaderboard, 60000);
updateLeaderboard(); // Run once on startup

app.get('/', (req, res) => res.send('Jade Bot + Live Leaderboard Running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on port ' + PORT);
});
