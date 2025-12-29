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

// Leaderboard update - Using HARDCODED Round 3 data from jade1.io (contract not updated yet)
async function updateLeaderboard() {
  try {
    const displayRound = "3";
    console.log(`[Leaderboard] Displaying Round #${displayRound} - using jade1.io current top 20`);

    // HARDCODED from https://jade1.io (Dec 28, 2025) - all votes 0 at round start
    const entries = [
      { name: "TokenFi", symbol: "TOKEN", votes: 0 },
      { name: "雪球", symbol: "雪球", votes: 0 },
      { name: "国内真正的鲸鱼", symbol: "马屁鲸", votes: 0 },
      { name: "ARK", symbol: "ARK", votes: 0 },
      { name: "坚持很酷", symbol: "坚持很酷", votes: 0 },
      { name: "Dongtian", symbol: "DONGTIAN", votes: 0 },
      { name: "SHISA 30", symbol: "SHISA", votes: 0 },
      { name: "WebKey DAO", symbol: "wkeyDAO", votes: 0 },
      { name: "POCHITA 10", symbol: "Pochita", votes: 0 },
      { name: "Donkey", symbol: "Donkey", votes: 0 },
      { name: "PRIME", symbol: "$PRIME", votes: 0 },
      { name: "最诡异的微博账号", symbol: "拉大便", votes: 0 },
      { name: "中国时代", symbol: "中国时代", votes: 0 },
      { name: "Book Of BSC", symbol: "BOB", votes: 0 },
      { name: "STBL_Token - STBL Governance Token", symbol: "STBL", votes: 0 },
      { name: "CREPE", symbol: "CREPE", votes: 0 },
      { name: "4", symbol: "4", votes: 0 },
      { name: "WIKI CAT", symbol: "WKC", votes: 0 },
      { name: "quq", symbol: "quq", votes: 0 },
      { name: "Aster", symbol: "ASTER", votes: 0 }
    ];

    let totalVotes = 0;

    // Build leaderboard text
    let text = `*Jade1 Live Leaderboard* — Round #${displayRound}\n`;
    text += `Total Votes: *${totalVotes.toFixed(0)} JADE*\n\n`;
    text += `⚠️ Round 3 just started — votes reset to zero!\nStake JADE and vote on https://jade1.io\nLeaderboard will update as votes come in.\n\n`;

    entries.forEach((p, i) => {
      text += `${i + 1}. *${p.name} (${p.symbol})* — ${p.votes.toFixed(4)} JADE\n`;
    });

    text += `\nUpdated: ${new Date().toUTCString()}\nhttps://jade1.io`;

    const leaderboardChat = process.env.CHANNEL_ID;
    if (!leaderboardChat) {
      console.log("CHANNEL_ID not set - skipping leaderboard update");
      return;
    }

    if (!pinnedMessageId) {
      // Send new message
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
        console.log(`Initial leaderboard sent. Message ID: ${pinnedMessageId} (pin it manually if needed)`);
      } else {
        console.error("Failed to send initial leaderboard:", data.description || data);
      }
    } else {
      // Edit existing message
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
        console.log("Leaderboard updated successfully");
      } else {
        console.error("Edit failed:", editData.description || editData);
      }
    }
  } catch (err) {
    console.error("Leaderboard update failed:", err.message);
  }
}

// Update every 60 seconds + initial call
setInterval(updateLeaderboard, 60000);
updateLeaderboard(); // Run immediately

app.get('/', (req, res) => res.send('Jade Bot + Live Leaderboard Running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
