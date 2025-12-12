const express = require('express');
const { ethers } = require('ethers');
const app = express();
app.use(express.json());

// CORS fix (already there, keep it)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_IDS = [
  process.env.CHANNEL_ID,   // e.g. @jade1_leaderboard
  process.env.GROUP_ID      // e.g. @jadecurrency1
].filter(Boolean);

const VOTING_CONTRACT = "0xaACd035063bb4c917E3171A5a05536A1D5a38548";
const provider = new ethers.providers.JsonRpcProvider("https://bsc-dataseed.binance.org/");
const votingContract = new ethers.Contract(VOTING_CONTRACT, [
  "function getProjects() view returns (string[20], string[20], address[20], uint256[20])",
  "function currentRound() view returns (uint256)"
], provider);

let pinnedMessageId = null; // Will store the pinned leaderboard message ID

async function sendToTelegram(chatId, text, parse_mode = "Markdown") {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode,
        disable_web_page_preview: true
      })
    });
  } catch (err) {
    console.error(`Failed to send to ${chatId}:`, err.message);
  }
}

async function broadcastVote(message) {
  for (const chatId of CHAT_IDS) {
    await sendToTelegram(chatId, message);
  }
}

// Vote webhook (instant notification)
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

// New: Leaderboard update function
async function updateLeaderboard() {
  try {
    const [roundBig, projects] = await Promise.all([
      votingContract.currentRound(),
      votingContract.getProjects()
    ]);

    const round = roundBig.toString();
    const [names, symbols, addrs, votesRaw] = projects;

    const ranked = [];
    for (let i = 0; i < 20; i++) {
      if (names[i] && addrs[i] !== ethers.constants.AddressZero) {
        ranked.push({
          rank: ranked.length + 1,
          name: names[i],
          symbol: symbols[i],
          votes: Number(ethers.utils.formatUnits(votesRaw[i], 18)).toFixed(4)
        });
      }
    }

    ranked.sort((a, b) => b.votes - a.votes);

    let leaderboardText = `*Jade1 Voting Leaderboard* (Round #${round})\n\n`;
    for (const p of ranked.slice(0, 20)) {
      leaderboardText += `${p.rank}. *${p.name} (${p.symbol})* — ${p.votes} JADE\n`;
    }
    leaderboardText += `\nUpdated: ${new Date().toUTCString()}\nhttps://jade1.io`;

    // Send/edit to your leaderboard channel only
    const leaderboardChat = process.env.CHANNEL_ID;
    if (!leaderboardChat) return;

    if (!pinnedMessageId) {
      // First time: send new message
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: leaderboardChat,
          text: leaderboardText,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        })
      });
      const data = await res.json();
      if (data.ok) {
        pinnedMessageId = data.result.message_id;
        console.log("Leaderboard message sent, ID:", pinnedMessageId);
        console.log("PIN THIS MESSAGE IN YOUR CHANNEL!");
      }
    } else {
      // Edit existing
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: leaderboardChat,
          message_id: pinnedMessageId,
          text: leaderboardText,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        })
      });
      console.log("Leaderboard updated");
    }
  } catch (err) {
    console.error("Leaderboard update failed:", err.message);
  }
}

// Run leaderboard update every 60 seconds
setInterval(updateLeaderboard, 60000);

// Initial update on startup
updateLeaderboard();

app.get('/', (req, res) => res.send('Jade Vote Bot + Leaderboard Running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on port ' + PORT);
});
