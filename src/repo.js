const { db } = require('./db');
const { verifyPin, hashPin } = require('./auth');

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

function logAudit(action, detail = '', roundId = null, actorUsername = 'system') {
  db.prepare('INSERT INTO audit_log (round_id, actor_username, action, detail) VALUES (?, ?, ?, ?)')
    .run(roundId, actorUsername, action, detail);
}

function getAuditLog(limit = 100, roundId = null) {
  if (roundId) {
    return db.prepare('SELECT * FROM audit_log WHERE round_id = ? ORDER BY id DESC LIMIT ?').all(roundId, limit);
  }
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
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
  const user = db.prepare('SELECT id, username, role, pin FROM users WHERE username = ?').get(username);
  if (!user) return null;
  if (!verifyPin(pin, user.pin)) return null;
  return { id: user.id, username: user.username, role: user.role };
}

function updateUserPin(username, pin, actorUsername = 'system') {
  if (!/^\d{4}$/.test(String(pin))) throw new Error('PIN must be exactly 4 digits.');
  const result = db.prepare('UPDATE users SET pin = ? WHERE username = ?').run(hashPin(String(pin)), username);
  if (!result.changes) throw new Error(`User not found: ${username}`);
  logAudit('user.pin.updated', `Updated PIN for ${username}`, null, actorUsername);
}

function listPlayers(query = '') {
  const q = `%${String(query || '').trim().toLowerCase()}%`;
  return db.prepare('SELECT * FROM players WHERE is_active = 1 AND LOWER(name) LIKE ? ORDER BY LOWER(name) ASC LIMIT 100').all(q);
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

function createRound(actorUsername = 'system') {
  const acePot = getAcePot();
  const result = db.prepare('INSERT INTO rounds (status, ace_pot_before, ace_pot_after) VALUES (?,?,?)').run('signup', acePot, acePot);
  logAudit('round.created', `Created round #${result.lastInsertRowid}`, result.lastInsertRowid, actorUsername);
  return getRound(result.lastInsertRowid);
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

function getRoundDisplayedAcePot(roundId) {
  const round = getRound(roundId);
  if (!round) throw new Error('Round not found.');
  const basePot = Number(round.ace_pot_before || getAcePot());
  if (round.status === 'signup') return basePot;
  const aceContribs = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN ace_paid = 1 AND dropped = 0 THEN 1 ELSE 0 END), 0) as ace_count
    FROM round_players
    WHERE round_id = ?
  `).get(roundId);
  return basePot + Number(aceContribs.ace_count || 0);
}

function addPlayerToRound(roundId, playerId, contributions, actorUsername = 'system') {
  const round = getRound(roundId);
  if (!round || round.status === 'completed') throw new Error('Round is not editable.');
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) throw new Error('Player not found');
  const existing = db.prepare('SELECT id FROM round_players WHERE round_id = ? AND player_id = ?').get(roundId, playerId);
  if (existing) throw new Error('That player is already in this round.');
  const greens = player.is_member ? 0 : 8;
  db.prepare(`INSERT INTO round_players
    (round_id, player_id, is_member, greens_fee, ctp_paid, ace_paid, payout_paid)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(roundId, playerId, player.is_member, greens, contributions.ctp ? 1 : 0, contributions.ace ? 1 : 0, contributions.payout ? 1 : 0);
  recalcRound(roundId);
  logAudit('round.player.added', `Added ${player.name}`, roundId, actorUsername);
}

function updateRoundPlayer(roundPlayerId, fields, actorUsername = 'system') {
  const current = db.prepare('SELECT round_id FROM round_players WHERE id = ?').get(roundPlayerId);
  if (!current) throw new Error('Round player not found.');
  db.prepare(`UPDATE round_players SET
    is_member = ?, greens_fee = ?, ctp_paid = ?, ace_paid = ?, payout_paid = ?, dropped = ?
    WHERE id = ?`)
    .run(fields.is_member ? 1 : 0, fields.greens_fee, fields.ctp_paid ? 1 : 0, fields.ace_paid ? 1 : 0, fields.payout_paid ? 1 : 0, fields.dropped ? 1 : 0, roundPlayerId);
  recalcRound(current.round_id);
  logAudit('round.player.updated', `Updated round_player_id ${roundPlayerId}`, current.round_id, actorUsername);
}

function removeRoundPlayer(roundPlayerId, actorUsername = 'system') {
  const row = db.prepare('SELECT round_id FROM round_players WHERE id = ?').get(roundPlayerId);
  db.prepare('DELETE FROM round_players WHERE id = ?').run(roundPlayerId);
  if (row) {
    recalcRound(row.round_id);
    logAudit('round.player.removed', `Removed round_player_id ${roundPlayerId}`, row.round_id, actorUsername);
  }
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

function setRoundCtpHole(roundId, hole, actorUsername = 'system') {
  const round = getRound(roundId);
  if (!round) throw new Error('Round not found.');
  const nextStatus = round.status === 'signup' ? 'ready' : round.status;
  db.prepare('UPDATE rounds SET ctp_hole = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hole, nextStatus, roundId);
  logAudit('round.ctp_hole.updated', `CTP hole set to ${hole}`, roundId, actorUsername);
}

function clearTeams(roundId) {
  db.prepare('DELETE FROM round_teams WHERE round_id = ?').run(roundId);
}

function resetTeams(roundId, actorUsername = 'system') {
  clearTeams(roundId);
  db.prepare("UPDATE rounds SET status = 'ready', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(roundId);
  logAudit('round.teams.reset', 'Cleared generated teams', roundId, actorUsername);
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateTeams(roundId, actorUsername = 'system') {
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
  logAudit('round.teams.randomized', 'Randomized teams', roundId, actorUsername);
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

function setManualTeams(roundId, entries, actorUsername = 'system') {
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
  logAudit('round.teams.manual', 'Applied manual teams', roundId, actorUsername);
}

function listCompletedRounds(limit = 50) {
  return db.prepare(`
    SELECT r.*, 
      (SELECT GROUP_CONCAT(p.name, ', ') FROM payouts pa JOIN players p ON p.id = pa.player_id WHERE pa.round_id = r.id AND pa.type = 'ctp') as ctp_winner_names,
      (SELECT GROUP_CONCAT(t2.team_name || ': ' || IFNULL(t2.player_names,''), '; ')
       FROM (
         SELECT t.id, t.team_name, GROUP_CONCAT(p.name, ' / ') as player_names
         FROM round_teams t
         LEFT JOIN round_team_players rtp ON rtp.team_id = t.id
         LEFT JOIN round_players rp ON rp.id = rtp.round_player_id
         LEFT JOIN players p ON p.id = rp.player_id
         WHERE t.round_id = r.id
           AND EXISTS (SELECT 1 FROM payouts pa WHERE pa.team_id = t.id AND pa.round_id = r.id AND pa.type = 'winner')
         GROUP BY t.id
       ) t2) as winning_teams
    FROM rounds r
    WHERE r.status = 'completed'
    ORDER BY r.completed_at DESC, r.id DESC
    LIMIT ?
  `).all(limit);
}

function getRoundDetail(roundId) {
  const round = getRound(roundId);
  if (!round) return null;
  const players = getRoundPlayers(roundId);
  const teams = getRoundTeams(roundId);
  const payouts = db.prepare(`
    SELECT pa.*, p.name as player_name, t.team_name
    FROM payouts pa
    LEFT JOIN players p ON p.id = pa.player_id
    LEFT JOIN round_teams t ON t.id = pa.team_id
    WHERE pa.round_id = ?
    ORDER BY pa.type ASC, pa.id ASC
  `).all(roundId);
  const acePlayers = db.prepare(`
    SELECT p.id, p.name
    FROM round_aces ra
    JOIN players p ON p.id = ra.player_id
    WHERE ra.round_id = ?
    ORDER BY p.name ASC
  `).all(roundId);
  const auditLog = getAuditLog(100, roundId);
  return { round, players, teams, payouts, acePlayers, auditLog };
}

function applyRoundPayouts(roundId, payload) {
  const round = getRound(roundId);
  if (!round) throw new Error('Round not found');
  const activePlayers = getRoundPlayers(roundId).filter((p) => !p.dropped);
  const teams = getRoundTeams(roundId);
  if (!activePlayers.length || !teams.length) throw new Error('Round is missing players or teams.');
  const aceContributors = activePlayers.filter((p) => p.ace_paid);
  const validPlayerIds = new Set(activePlayers.map((p) => p.player_id));
  const validTeamIds = new Set(teams.map((t) => t.id));
  const acePlayerIds = (payload.acePlayerIds || []).filter((id) => validPlayerIds.has(id));
  if (payload.aceResult === 'yes' && !acePlayerIds.length) throw new Error('Select at least one ace hitter.');
  if (payload.ctpPlayerId && !validPlayerIds.has(payload.ctpPlayerId)) throw new Error('Invalid CTP winner.');
  if (payload.winnerTeamId && !validTeamIds.has(payload.winnerTeamId)) throw new Error('Invalid winning team.');

  const ctpPrize = activePlayers.filter((p) => p.ctp_paid).length;
  const winnerPrize = activePlayers.filter((p) => p.payout_paid).length * 5;
  const acePotBefore = round.ace_pot_before || getAcePot();
  let acePotAfter = acePotBefore;
  let acePayoutTotal = 0;

  db.prepare('DELETE FROM round_aces WHERE round_id = ?').run(roundId);
  db.prepare('DELETE FROM payouts WHERE round_id = ?').run(roundId);

  if (payload.aceResult === 'yes') {
    const share = acePotBefore / acePlayerIds.length;
    acePayoutTotal = acePotBefore;
    acePotAfter = 0;
    acePlayerIds.forEach((playerId) => {
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
    ace_result = ?,
    ace_pot_before = ?,
    ace_pot_after = ?,
    ace_payout_total = ?,
    ctp_payout_total = ?,
    winner_payout_total = ?,
    updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`)
    .run(payload.aceResult, acePotBefore, acePotAfter, acePayoutTotal, ctpPrize, winnerPrize, roundId);

  return { acePotAfter };
}

function completeRound(roundId, payload, actorUsername = 'system') {
  const round = getRound(roundId);
  if (!round) throw new Error('Round not found');
  if (round.status !== 'teams') throw new Error('Round must have teams before completion.');
  db.transaction(() => {
    const { acePotAfter } = applyRoundPayouts(roundId, payload);
    db.prepare(`UPDATE rounds SET
      status = 'completed',
      completed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).run(roundId);
    setAcePot(acePotAfter);
    logAudit('round.completed', 'Completed round and saved payouts', roundId, actorUsername);
  })();
}

function correctCompletedRound(roundId, payload, actorUsername = 'system') {
  const round = getRound(roundId);
  if (!round || round.status !== 'completed') throw new Error('Round must already be completed.');
  db.transaction(() => {
    const { acePotAfter } = applyRoundPayouts(roundId, payload);
    const currentActive = getActiveRound();
    if (!currentActive || currentActive.id === roundId) {
      setAcePot(acePotAfter);
    }
    logAudit('round.payouts.corrected', 'Corrected completed round payouts', roundId, actorUsername);
  })();
}

function exportRoundsCsv() {
  const rows = db.prepare(`
    SELECT r.id, r.created_at, r.completed_at, r.ctp_hole, r.ace_result,
      r.ace_pot_before, r.ace_pot_after, r.ace_payout_total, r.ctp_payout_total, r.winner_payout_total,
      r.greens_total, r.ctp_total, r.payout_total,
      (SELECT COUNT(*) FROM round_players rp WHERE rp.round_id = r.id AND rp.dropped = 0) as active_players
    FROM rounds r
    ORDER BY r.id DESC
  `).all();
  const header = ['round_id','created_at','completed_at','ctp_hole','ace_result','ace_pot_before','ace_pot_after','ace_payout_total','ctp_payout_total','winner_payout_total','greens_total','ctp_total','payout_total','active_players'];
  const lines = [header.join(',')];
  for (const row of rows) lines.push(header.map((key) => JSON.stringify(row[key] ?? '')).join(','));
  return lines.join('\n');
}

function exportPayoutsCsv() {
  const rows = db.prepare(`
    SELECT pa.round_id, pa.type, pa.amount, p.name as player_name, t.team_name, pa.created_at
    FROM payouts pa
    LEFT JOIN players p ON p.id = pa.player_id
    LEFT JOIN round_teams t ON t.id = pa.team_id
    ORDER BY pa.round_id DESC, pa.id ASC
  `).all();
  const header = ['round_id','type','amount','player_name','team_name','created_at'];
  const lines = [header.join(',')];
  for (const row of rows) lines.push(header.map((key) => JSON.stringify(row[key] ?? '')).join(','));
  return lines.join('\n');
}

function getDashboard() {
  const activeRound = getActiveRound();
  const recentRounds = listCompletedRounds(8);
  const totals = db.prepare(`
    SELECT COUNT(*) as total_rounds,
      COALESCE(SUM(greens_total),0) as total_greens,
      COALESCE(SUM(ctp_payout_total),0) as total_ctp_payouts,
      COALESCE(SUM(winner_payout_total),0) as total_winner_payouts
    FROM rounds WHERE status = 'completed'
  `).get();
  const tonight = db.prepare(`
    SELECT COUNT(*) as rounds_today,
      COALESCE(SUM(greens_total),0) as greens_today
    FROM rounds WHERE date(created_at, 'localtime') = date('now', 'localtime')
  `).get();
  const recentPlayers = db.prepare(`SELECT name FROM players WHERE is_active = 1 ORDER BY id DESC LIMIT 10`).all().map((r) => r.name);
  return { activeRound, recentRounds, totals, tonight, recentPlayers, acePot: getAcePot() };
}

function getStats() {
  const totals = db.prepare(`
    SELECT
      COUNT(*) as total_rounds,
      COALESCE(SUM(greens_total), 0) as total_greens,
      COALESCE(SUM(ctp_total), 0) as total_ctp,
      COALESCE(SUM(payout_total), 0) as total_payout,
      COALESCE(SUM(ace_payout_total), 0) as total_ace_payout,
      COALESCE(SUM(CASE WHEN greens_total > 0 THEN 1 ELSE 0 END), 0) as guest_rounds
    FROM rounds
    WHERE status = 'completed'
  `).get();

  const memberCounts = db.prepare(`
    SELECT
      SUM(CASE WHEN is_member = 1 THEN 1 ELSE 0 END) as member_entries,
      SUM(CASE WHEN is_member = 0 THEN 1 ELSE 0 END) as non_member_entries
    FROM round_players rp
    JOIN rounds r ON r.id = rp.round_id
    WHERE r.status = 'completed'
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
    LEFT JOIN rounds r ON r.id = rp.round_id AND r.status = 'completed'
    LEFT JOIN payouts pa ON pa.player_id = p.id
    GROUP BY p.id
    ORDER BY rounds_played DESC, LOWER(p.name) ASC
  `).all();

  const payoutHistory = db.prepare(`SELECT type, COALESCE(SUM(amount),0) as total FROM payouts GROUP BY type`).all();
  return { totals, memberCounts, playerStats, payoutHistory, acePot: getAcePot() };
}

function cancelRound(roundId, actorUsername = 'system') {
  db.prepare('DELETE FROM rounds WHERE id = ? AND status != ?').run(roundId, 'completed');
  logAudit('round.canceled', `Canceled unfinished round #${roundId}`, roundId, actorUsername);
}

module.exports = {
  getSetting, setSetting, getEligibleCtpHoles, setEligibleCtpHoles, getAcePot, setAcePot,
  getUsers, findUserByCredentials, updateUserPin, listPlayers, createPlayer, getOrCreatePlayer,
  getActiveRound, getRound, createRound, getRoundPlayers, getRoundDisplayedAcePot, addPlayerToRound,
  updateRoundPlayer, removeRoundPlayer, recalcRound, setRoundStatus, setRoundCtpHole,
  generateTeams, getRoundTeams, setManualTeams, completeRound, correctCompletedRound,
  getStats, cancelRound, listCompletedRounds, getRoundDetail, resetTeams,
  exportRoundsCsv, exportPayoutsCsv, getDashboard, getAuditLog, logAudit
};
