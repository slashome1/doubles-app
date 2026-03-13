const { db } = require('./db');

const parseJson = (value, fallback = []) => {
  try { return JSON.parse(value); } catch { return fallback; }
};

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

function getEligibleCtpHoles() {
  return parseJson(getSetting('eligible_ctp_holes', '[]'));
}

function setEligibleCtpHoles(holes) {
  setSetting('eligible_ctp_holes', JSON.stringify(holes));
}

function getAcePot() {
  return Number(getSetting('ace_pot', '0'));
}

function setAcePot(amount) {
  setSetting('ace_pot', Number(amount).toFixed(2));
}

function getUsers() {
  return db.prepare('SELECT id, username, role FROM users ORDER BY role DESC, username ASC').all();
}

function findUserByCredentials(username, pin) {
  return db.prepare('SELECT id, username, role FROM users WHERE username = ? AND pin = ?').get(username, pin);
}

function listPlayers() {
  return db.prepare('SELECT * FROM players WHERE is_active = 1 ORDER BY LOWER(name) ASC').all();
}

function createPlayer(name, isMember) {
  const result = db.prepare('INSERT INTO players (name, is_member) VALUES (?, ?)').run(name.trim(), isMember ? 1 : 0);
  return db.prepare('SELECT * FROM players WHERE id = ?').get(result.lastInsertRowid);
}

function getOrCreatePlayer(name, isMember) {
  const existing = db.prepare('SELECT * FROM players WHERE LOWER(name) = LOWER(?)').get(name.trim());
  if (existing) return existing;
  return createPlayer(name, isMember);
}

function getActiveRound() {
  return db.prepare("SELECT * FROM rounds WHERE status != 'completed' ORDER BY id DESC LIMIT 1").get();
}

function getRound(roundId) {
  return db.prepare('SELECT * FROM rounds WHERE id = ?').get(roundId);
}

function createRound() {
  const acePot = getAcePot();
  const result = db.prepare('INSERT INTO rounds (status, ace_pot_before, ace_pot_after) VALUES (?,?,?)').run('signup', acePot, acePot);
  return getRound(result.lastInsertRowid);
}

function ensureActiveRound() {
  return getActiveRound() || createRound();
}

function getRoundPlayers(roundId) {
  return db.prepare(`
    SELECT rp.*, p.name, p.id as player_id
    FROM round_players rp
    JOIN players p ON p.id = rp.player_id
    WHERE rp.round_id = ?
    ORDER BY rp.id ASC
  `).all(roundId);
}

function addPlayerToRound(roundId, playerId, contributions) {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) throw new Error('Player not found');
  const greens = player.is_member ? 0 : 8;
  db.prepare(`INSERT INTO round_players
    (round_id, player_id, is_member, greens_fee, ctp_paid, ace_paid, payout_paid)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(roundId, playerId, player.is_member, greens, contributions.ctp ? 1 : 0, contributions.ace ? 1 : 0, contributions.payout ? 1 : 0);
  recalcRound(roundId);
}

function updateRoundPlayer(roundPlayerId, fields) {
  db.prepare(`UPDATE round_players SET
    is_member = ?, greens_fee = ?, ctp_paid = ?, ace_paid = ?, payout_paid = ?, dropped = ?
    WHERE id = ?`)
    .run(fields.is_member ? 1 : 0, fields.greens_fee, fields.ctp_paid ? 1 : 0, fields.ace_paid ? 1 : 0, fields.payout_paid ? 1 : 0, fields.dropped ? 1 : 0, roundPlayerId);
  const row = db.prepare('SELECT round_id FROM round_players WHERE id = ?').get(roundPlayerId);
  if (row) recalcRound(row.round_id);
}

function removeRoundPlayer(roundPlayerId) {
  const row = db.prepare('SELECT round_id FROM round_players WHERE id = ?').get(roundPlayerId);
  db.prepare('DELETE FROM round_players WHERE id = ?').run(roundPlayerId);
  if (row) recalcRound(row.round_id);
}

function recalcRound(roundId) {
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(greens_fee), 0) as greens_total,
      COALESCE(SUM(CASE WHEN ctp_paid = 1 THEN 1 ELSE 0 END), 0) as ctp_total,
      COALESCE(SUM(CASE WHEN payout_paid = 1 THEN 5 ELSE 0 END), 0) as payout_total
    FROM round_players
    WHERE round_id = ? AND dropped = 0
  `).get(roundId);
  db.prepare(`UPDATE rounds SET greens_total = ?, ctp_total = ?, payout_total = ?, ctp_payout_total = ?, winner_payout_total = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(totals.greens_total, totals.ctp_total, totals.payout_total, totals.ctp_total, totals.payout_total, roundId);
}

function setRoundStatus(roundId, status) {
  db.prepare('UPDATE rounds SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, roundId);
}

function setRoundCtpHole(roundId, hole) {
  db.prepare('UPDATE rounds SET ctp_hole = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hole, 'ready', roundId);
}

function clearTeams(roundId) {
  db.prepare('DELETE FROM round_teams WHERE round_id = ?').run(roundId);
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateTeams(roundId) {
  clearTeams(roundId);
  const players = getRoundPlayers(roundId).filter((p) => !p.dropped);
  if (players.length < 2) throw new Error('Need at least 2 active players');
  const shuffled = shuffle(players);
  const createTeam = db.prepare('INSERT INTO round_teams (round_id, team_name, team_order, is_cali) VALUES (?, ?, ?, ?)');
  const attach = db.prepare('INSERT INTO round_team_players (team_id, round_player_id) VALUES (?, ?)');
  let teamIndex = 1;
  while (shuffled.length > 1) {
    const a = shuffled.shift();
    const b = shuffled.shift();
    const result = createTeam.run(roundId, `Team ${teamIndex}`, teamIndex, 0);
    attach.run(result.lastInsertRowid, a.id);
    attach.run(result.lastInsertRowid, b.id);
    teamIndex += 1;
  }
  if (shuffled.length === 1) {
    const a = shuffled.shift();
    const result = createTeam.run(roundId, `Cali`, teamIndex, 1);
    attach.run(result.lastInsertRowid, a.id);
  }
  setRoundStatus(roundId, 'teams');
}

function getRoundTeams(roundId) {
  return db.prepare(`
    SELECT t.id, t.team_name, t.team_order, t.is_cali,
      GROUP_CONCAT(p.name, ' / ') as player_names
    FROM round_teams t
    LEFT JOIN round_team_players rtp ON rtp.team_id = t.id
    LEFT JOIN round_players rp ON rp.id = rtp.round_player_id
    LEFT JOIN players p ON p.id = rp.player_id
    WHERE t.round_id = ?
    GROUP BY t.id
    ORDER BY t.team_order ASC, t.id ASC
  `).all(roundId);
}

function setManualTeams(roundId, entries) {
  clearTeams(roundId);
  const createTeam = db.prepare('INSERT INTO round_teams (round_id, team_name, team_order, is_cali) VALUES (?, ?, ?, ?)');
  const attach = db.prepare('INSERT INTO round_team_players (team_id, round_player_id) VALUES (?, ?)');
  entries.forEach((entry, idx) => {
    if (!entry.playerIds.length) return;
    const isCali = entry.playerIds.length === 1 ? 1 : 0;
    const result = createTeam.run(roundId, entry.name || (isCali ? 'Cali' : `Team ${idx + 1}`), idx + 1, isCali);
    entry.playerIds.forEach((roundPlayerId) => attach.run(result.lastInsertRowid, roundPlayerId));
  });
  setRoundStatus(roundId, 'teams');
}

function getStats() {
  const totals = db.prepare(`
    SELECT
      COUNT(*) as total_rounds,
      COALESCE(SUM(greens_total), 0) as total_greens,
      COALESCE(SUM(ctp_total), 0) as total_ctp,
      COALESCE(SUM(payout_total), 0) as total_payout,
      COALESCE(SUM(ace_payout_total), 0) as total_ace_payout
    FROM rounds
    WHERE status = 'completed'
  `).get();

  const playerStats = db.prepare(`
    SELECT p.name,
      COUNT(DISTINCT rp.round_id) as rounds_played,
      SUM(CASE WHEN rp.is_member = 1 THEN 1 ELSE 0 END) as member_rounds,
      SUM(CASE WHEN rp.is_member = 0 THEN 1 ELSE 0 END) as non_member_rounds,
      SUM(CASE WHEN pa.type = 'ace' THEN 1 ELSE 0 END) as ace_count,
      SUM(CASE WHEN pa.type = 'ctp' THEN 1 ELSE 0 END) as ctp_wins,
      SUM(CASE WHEN pa.type = 'winner' THEN 1 ELSE 0 END) as round_wins
    FROM players p
    LEFT JOIN round_players rp ON rp.player_id = p.id
    LEFT JOIN payouts pa ON pa.player_id = p.id
    GROUP BY p.id
    ORDER BY rounds_played DESC, LOWER(p.name) ASC
  `).all();

  const payoutHistory = db.prepare(`SELECT type, COALESCE(SUM(amount),0) as total FROM payouts GROUP BY type`).all();
  return { totals, playerStats, payoutHistory, acePot: getAcePot() };
}

function completeRound(roundId, payload) {
  const round = getRound(roundId);
  if (!round) throw new Error('Round not found');
  const activePlayers = getRoundPlayers(roundId).filter((p) => !p.dropped);
  const aceContributors = activePlayers.filter((p) => p.ace_paid);
  const ctpPrize = activePlayers.filter((p) => p.ctp_paid).length;
  const winnerPrize = activePlayers.filter((p) => p.payout_paid).length * 5;
  const acePotBefore = getAcePot();
  let acePotAfter = acePotBefore;
  let acePayoutTotal = 0;

  db.transaction(() => {
    db.prepare('DELETE FROM round_aces WHERE round_id = ?').run(roundId);
    db.prepare('DELETE FROM payouts WHERE round_id = ?').run(roundId);

    if (payload.aceResult === 'yes' && payload.acePlayerIds.length) {
      const share = acePotBefore / payload.acePlayerIds.length;
      acePayoutTotal = acePotBefore;
      acePotAfter = 0;
      payload.acePlayerIds.forEach((playerId) => {
        db.prepare('INSERT INTO round_aces (round_id, player_id) VALUES (?, ?)').run(roundId, playerId);
        db.prepare('INSERT INTO payouts (round_id, type, player_id, amount) VALUES (?, ?, ?, ?)').run(roundId, 'ace', playerId, share);
      });
    } else {
      acePotAfter = acePotBefore + aceContributors.length;
    }

    if (payload.ctpPlayerId) {
      db.prepare('INSERT INTO payouts (round_id, type, player_id, amount) VALUES (?, ?, ?, ?)').run(roundId, 'ctp', payload.ctpPlayerId, ctpPrize);
    }
    if (payload.winnerTeamId) {
      const teamPlayers = db.prepare(`
        SELECT p.id FROM round_team_players rtp
        JOIN round_players rp ON rp.id = rtp.round_player_id
        JOIN players p ON p.id = rp.player_id
        WHERE rtp.team_id = ?
      `).all(payload.winnerTeamId);
      teamPlayers.forEach((player) => {
        db.prepare('INSERT INTO payouts (round_id, type, player_id, team_id, amount) VALUES (?, ?, ?, ?, ?)')
          .run(roundId, 'winner', player.id, payload.winnerTeamId, teamPlayers.length ? winnerPrize / teamPlayers.length : 0);
      });
    }

    db.prepare(`UPDATE rounds SET
      status = 'completed',
      ace_result = ?,
      ace_pot_before = ?,
      ace_pot_after = ?,
      ace_payout_total = ?,
      ctp_payout_total = ?,
      winner_payout_total = ?,
      completed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`)
      .run(payload.aceResult, acePotBefore, acePotAfter, acePayoutTotal, ctpPrize, winnerPrize, roundId);

    setAcePot(acePotAfter);
  })();
}

function cancelRound(roundId) {
  db.prepare('DELETE FROM rounds WHERE id = ? AND status != ?').run(roundId, 'completed');
}

module.exports = {
  getSetting, setSetting, getEligibleCtpHoles, setEligibleCtpHoles, getAcePot, setAcePot,
  getUsers, findUserByCredentials, listPlayers, createPlayer, getOrCreatePlayer,
  getActiveRound, getRound, createRound, ensureActiveRound, getRoundPlayers, addPlayerToRound,
  updateRoundPlayer, removeRoundPlayer, recalcRound, setRoundStatus, setRoundCtpHole,
  generateTeams, getRoundTeams, setManualTeams, completeRound, getStats, cancelRound
};
