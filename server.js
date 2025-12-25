// Safe leaderboard update - FORCED to Round 2
async function updateLeaderboard() {
  if (!votingContract) return;

  try {
    // Force Round 2
    const round = "2";

    // Directly call getProjects() — no need for Promise.all anymore
    const projects = await votingContract.getProjects();

    // Skip unused address array with comma
    const [names, symbols, , votesRaw] = projects;

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
