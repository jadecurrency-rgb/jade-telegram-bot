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

  // Try primary RPC, fallback to another for freshness
  const rpcUrl = "https://bsc-dataseed.binance.org/";
  const fallbackRpc = "https://bsc-dataseed1.binance.org/";
  provider = new ethers.JsonRpcProvider(rpcUrl);
  console.log(`Using RPC: ${rpcUrl}`);

  votingContract = new ethers.Contract(
    "0x8613481dBe0162ceA781f545B59901f76226954a",
    [
      "function getProjects() view returns (string[20] names, string[20] symbols, address[20] addrs, uint256[20] votes)",
      "function currentRound() view returns (uint256)"
    ],
    provider
  );

  console.log("Ethers v6 loaded — leaderboard enabled");
} catch (err) {
  console.error("Ethers init failed:", err.message);
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
    console.error(`Send failed to ${chatId}:`, err.message);
  }
}

async function broadcastVote(message) {
  for (const chatId of CHAT_IDS) await sendToTelegram(chatId, message);
}

app.post('/vote-webhook', async (req, res) => {
  // ... (keep as is)
});

// Debug leaderboard
async function updateLeaderboard() {
  if (!votingContract) {
    console.log("[DEBUG] Contract not ready");
    return;
  }

  try {
    console.log("[DEBUG] Fetching contract data...");

    const projects = await votingContract.getProjects();
    const [names, symbols, , votesRaw] = projects;

    // Debug: first 5 names + total count
    const first5 = names.slice(0, 5).map(n => n.trim() || 'EMPTY').join(", ");
    console.log(`[DEBUG] Fetched first 5 names: ${first5}`);
    console.log(`[DEBUG] Names array length: ${names.length}`);
    console.log(`[DEBUG] Sample votes (first): ${Number(votesRaw[0] || 0n)}`);

    const entries = [];
    let totalVotes = 0n;

    for (let i = 0; i < 20; i++) {
      const name = names[i]?.trim();
      if (name) {
        const votes = Number(ethers.formatUnits(votesRaw[i] || 0n, 18));
        totalVotes += votesRaw[i] || 0n;
        entries.push({ name, symbol: symbols[i]?.trim() || '???', votes });
      }
    }

    console.log(`[DEBUG] Valid entries count: ${entries.length}`);

    entries.sort((a, b) => b.votes - a.votes);

    let text = `*Jade1 Live Leaderboard* — Round #3\n`;
    text += `Total Votes: *${Number(ethers.formatUnits(totalVotes, 18)).toFixed(0)} JADE*\n\n`;

    if (entries.length === 0) {
      text += `[DEBUG] No projects loaded - contract may be empty or RPC lag\n`;
    } else if (totalVotes === 0n) {
      text += `⚠️ Round 3 - votes reset\n`;
    }

    entries.forEach((p, i) => {
      text += `${i + 1}. *${p.name} (${p.symbol})* — ${p.votes.toFixed(4)} JADE\n`;
    });

    text += `\nUpdated: ${new Date().toUTCString()}\nhttps://jade1.io`;

    const chat = process.env.CHANNEL_ID;
    if (!chat) return console.log("[DEBUG] No CHANNEL_ID");

    if (!pinnedMessageId) {
      const data = await sendToTelegram(chat, text);
      if (data?.ok) {
        pinnedMessageId = data.result.message_id;
        console.log(`[DEBUG] New message ID: ${pinnedMessageId}`);
      }
    } else {
      const editResponse = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, message_id: pinnedMessageId, text, parse_mode: 'Markdown' })
      });
      const editData = await editResponse.json();
      console.log(`[DEBUG] Edit response: ${JSON.stringify(editData)}`);
      if (editData.ok) console.log("[DEBUG] Edit success");
    }
  } catch (err) {
    console.error("[DEBUG] Fetch/update error:", err.message);
  }
}

setInterval(updateLeaderboard, 60000);
updateLeaderboard();

app.get('/', (req, res) => res.send('Bot running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Running on ${PORT}`));
