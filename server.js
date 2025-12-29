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
const CHAT_IDS = [process.env.CHANNEL_ID, process.env.GROUP_ID].filter(Boolean);

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
  console.error("Ethers failed:", err.message);
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
    console.error(`Send failed to ${chatId}:`, err);
  }
}

async function broadcastVote(message) {
  for (const chatId of CHAT_IDS) await sendToTelegram(chatId, message);
}

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

https://jade1.io`.trim();

    await broadcastVote(message);
    res.json({ success: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: 'failed' });
  }
});

// Live leaderboard with dynamic rankings
async function updateLeaderboard() {
  if (!votingContract) return console.log("No contract - skip");

  try {
    const displayRound = "3"; // Force to match website
    console.log(`[Leaderboard] Fetching live data for Round #${displayRound}`);

    const projects = await votingContract.getProjects();
    const [names, symbols, , votesRaw] = projects;

    const entries = [];
    let totalVotes = 0n;

    for (let i = 0; i < 20; i++) {
      const name = names[i]?.trim();
      const symbol = symbols[i]?.trim();
      if (name) {
        const votesBig = votesRaw[i] || 0n;
        const votes = Number(ethers.formatUnits(votesBig, 18));
        totalVotes += votesBig;
        entries.push({ name, symbol, votes });
      }
    }

    // Sort for live ranking changes
    entries.sort((a, b) => b.votes - a.votes);

    let text = `*Jade1 Live Leaderboard* — Round #${displayRound}\n`;
    text += `Total Votes: *${Number(ethers.formatUnits(totalVotes, 18)).toFixed(0)} JADE*\n\n`;

    if (totalVotes === 0n) {
      text += `⚠️ Round 3 started — votes reset to 0\nStake JADE & vote on jade1.io\nRankings update live as votes come in!\n\n`;
    }

    entries.forEach((p, i) => {
      text += `${i + 1}. *${p.name} (${p.symbol})* — ${p.votes.toFixed(4)} JADE\n`;
    });

    text += `\nUpdated: ${new Date().toUTCString()}\nhttps://jade1.io`;

    const chat = process.env.CHANNEL_ID;
    if (!chat) return;

    if (!pinnedMessageId) {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, parse_mode: 'Markdown', disable_web_page_preview: true })
      });
      const data = await res.json();
      if (data.ok) {
        pinnedMessageId = data.result.message_id;
        console.log(`Sent new leaderboard - ID: ${pinnedMessageId} (pin it)`);
      }
    } else {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, message_id: pinnedMessageId, text, parse_mode: 'Markdown' })
      });
      console.log("Leaderboard updated");
    }
  } catch (err) {
    console.error("Leaderboard error:", err.message);
  }
}

setInterval(updateLeaderboard, 60000);
updateLeaderboard();

app.get('/', (req, res) => res.send('Bot running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Port ${PORT}`));
