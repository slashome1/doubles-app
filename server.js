const path = require('path');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const { initDb, dbPath } = require('./src/db');
const repo = require('./src/repo');
const { currency } = require('./src/utils');

initDb();
const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: process.env.DATA_DIR || path.join(__dirname, 'data') }),
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 12 }
}));

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.currency = currency;
  res.locals.flash = req.session.flash;
  delete req.session.flash;
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'admin') return res.status(403).render('error', { message: 'Admin access only.' });
  next();
}
function setFlash(req, message) { req.session.flash = message; }
function back(req, fallback = '/') { return req.get('referer') || fallback; }
function parseAceIds(value) {
  return Array.isArray(value) ? value.map(Number) : value ? [Number(value)] : [];
}

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const dashboard = repo.getDashboard();
  if (dashboard.activeRound) return res.redirect(`/rounds/${dashboard.activeRound.id}`);
  res.render('home', dashboard);
});

app.get('/login', (req, res) => res.render('login', { users: repo.getUsers() }));
app.post('/login', (req, res) => {
  const { username, pin } = req.body;
  const user = repo.findUserByCredentials(username, pin);
  if (!user) {
    setFlash(req, 'Wrong username or PIN.');
    return res.redirect('/login');
  }
  req.session.user = user;
  const activeRound = repo.getActiveRound();
  if (activeRound) return res.redirect(`/rounds/${activeRound.id}`);
  res.redirect('/');
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.post('/rounds', requireAuth, (req, res) => {
  if (req.session.user.role === 'admin') {
    setFlash(req, 'Admins cannot start new rounds. Use the standard user account for round operations.');
    return res.redirect('/');
  }
  const activeRound = repo.getActiveRound();
  if (activeRound) return res.redirect(`/rounds/${activeRound.id}`);
  const round = repo.createRound(req.session.user.username);
  res.redirect(`/rounds/${round.id}`);
});

app.get('/rounds/history', requireAuth, (req, res) => res.render('round-history', { rounds: repo.listCompletedRounds(100) }));
app.get('/rounds/:id/detail', requireAuth, (req, res) => {
  const detail = repo.getRoundDetail(Number(req.params.id));
  if (!detail) return res.status(404).render('error', { message: 'Round not found.' });
  res.render('round-detail', detail);
});

app.get('/rounds/:id', requireAuth, (req, res) => {
  const round = repo.getRound(Number(req.params.id));
  if (!round) return res.status(404).render('error', { message: 'Round not found.' });
  const players = repo.getRoundPlayers(round.id);
  const teams = repo.getRoundTeams(round.id);
  const playerQuery = String(req.query.player_query || '').trim();
  const view = String(req.query.view || (round.status === 'signup' ? 'signup' : 'teams')).trim();
  res.render('round', {
    round,
    players,
    teams,
    acePot: repo.getRoundDisplayedAcePot(round.id),
    allPlayers: repo.listPlayers(playerQuery),
    eligibleHoles: repo.getEligibleCtpHoles(),
    playerQuery,
    view
  });
});

app.post('/rounds/:id/players', requireAuth, (req, res) => {
  const roundId = Number(req.params.id);
  let player;
  try {
    if (req.body.player_mode === 'existing') {
      player = repo.listPlayers().find((p) => p.id === Number(req.body.player_id));
      if (!player) throw new Error('Pick an existing player.');
    } else {
      const name = (req.body.new_player_name || '').trim();
      if (!name) throw new Error('New player name is required.');
      player = repo.getOrCreatePlayer(name, req.body.is_member === 'on');
    }
    repo.addPlayerToRound(roundId, player.id, {
      ctp: req.body.ctp_paid === 'on',
      ace: req.body.ace_paid === 'on',
      payout: req.body.payout_paid === 'on'
    }, req.session.user.username);
    setFlash(req, `${player.name} added.`);
  } catch (error) {
    setFlash(req, error.message);
  }
  res.redirect(`/rounds/${roundId}`);
});

app.post('/round-players/:id/update', requireAuth, (req, res) => {
  try {
    const current = repo.getRoundPlayers(Number(req.body.round_id || 0)).find((p) => p.id === Number(req.params.id));
    repo.updateRoundPlayer(Number(req.params.id), {
      is_member: req.body.is_member === 'on',
      greens_fee: Number(req.body.greens_fee || 0),
      ctp_paid: req.body.ctp_paid === 'on',
      ace_paid: req.body.ace_paid === 'on',
      payout_paid: req.body.payout_paid === 'on',
      dropped: current ? current.dropped : false
    }, req.session.user.username);
    setFlash(req, 'Player entry updated.');
  } catch (error) {
    setFlash(req, error.message);
  }
  res.redirect(back(req));
});

app.post('/round-players/:id/drop-toggle', requireAuth, (req, res) => {
  try {
    repo.toggleDropped(Number(req.params.id), req.session.user.username);
    setFlash(req, 'Player drop status updated. Contribution money stays in the round by default.');
  } catch (error) {
    setFlash(req, error.message);
  }
  res.redirect(back(req));
});

app.post('/round-players/:id/delete', requireAdmin, (req, res) => {
  repo.removeRoundPlayer(Number(req.params.id), req.session.user.username);
  setFlash(req, 'Player removed from round.');
  res.redirect(back(req));
});

app.post('/rounds/:id/start', requireAuth, (req, res) => {
  const roundId = Number(req.params.id);
  const holes = repo.getEligibleCtpHoles();
  if (!holes.length) {
    setFlash(req, 'No eligible CTP holes set by admin yet.');
    return res.redirect(`/rounds/${roundId}`);
  }
  const hole = holes[Math.floor(Math.random() * holes.length)];
  repo.setRoundCtpHole(roundId, hole, req.session.user.username);
  setFlash(req, `CTP hole selected: ${hole}`);
  res.redirect(`/rounds/${roundId}`);
});

app.post('/rounds/:id/randomize', requireAuth, (req, res) => {
  try {
    repo.generateTeams(Number(req.params.id), req.session.user.username);
    setFlash(req, 'Teams randomized.');
  } catch (error) {
    setFlash(req, error.message);
  }
  res.redirect(`/rounds/${req.params.id}`);
});

app.post('/rounds/:id/manual-teams', requireAdmin, (req, res) => {
  const raw = (req.body.teams || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const players = repo.getRoundPlayers(Number(req.params.id)).filter((p) => !p.dropped);
  const used = new Set();
  const entries = raw.map((line, idx) => {
    const names = line.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const matched = [];
    for (const player of players) {
      if (names.includes(player.name.toLowerCase()) && !used.has(player.id)) {
        matched.push(player.id);
        used.add(player.id);
      }
    }
    return { name: `Team ${idx + 1}`, playerIds: matched };
  });
  repo.setManualTeams(Number(req.params.id), entries, req.session.user.username);
  setFlash(req, 'Teams updated manually.');
  res.redirect(`/rounds/${req.params.id}`);
});

app.post('/rounds/:id/set-ctp-hole', requireAdmin, (req, res) => {
  try {
    const hole = String(req.body.ctp_hole || '').trim();
    if (!hole) throw new Error('Pick a CTP hole.');
    repo.setRoundCtpHole(Number(req.params.id), hole, req.session.user.username);
    setFlash(req, `CTP hole set to ${hole}.`);
  } catch (error) {
    setFlash(req, error.message);
  }
  res.redirect(`/rounds/${req.params.id}`);
});

app.post('/rounds/:id/reset-teams', requireAdmin, (req, res) => {
  try {
    repo.resetTeams(Number(req.params.id), req.session.user.username);
    setFlash(req, 'Teams cleared. Round moved back to ready state.');
  } catch (error) {
    setFlash(req, error.message);
  }
  res.redirect(`/rounds/${req.params.id}`);
});

app.post('/admin/users/pins', requireAdmin, (req, res) => {
  try {
    repo.updateUserPin('admin', req.body.admin_pin, req.session.user.username);
    repo.updateUserPin('user', req.body.user_pin, req.session.user.username);
    setFlash(req, 'Admin and user PINs updated.');
  } catch (error) {
    setFlash(req, error.message);
  }
  res.redirect('/admin/settings');
});

app.post('/rounds/:id/complete', requireAuth, (req, res) => {
  const roundId = Number(req.params.id);
  try {
    repo.completeRound(roundId, {
      aceResult: req.body.ace_result,
      acePlayerIds: parseAceIds(req.body.ace_player_ids),
      ctpPlayerId: req.body.ctp_player_id ? Number(req.body.ctp_player_id) : null,
      winnerTeamId: req.body.winner_team_id ? Number(req.body.winner_team_id) : null
    }, req.session.user.username);
    setFlash(req, 'Round completed and payouts saved.');
    res.redirect('/');
  } catch (error) {
    setFlash(req, error.message);
    res.redirect(`/rounds/${roundId}`);
  }
});

app.post('/rounds/:id/correct-payouts', requireAdmin, (req, res) => {
  const roundId = Number(req.params.id);
  try {
    repo.correctCompletedRound(roundId, {
      aceResult: req.body.ace_result,
      acePlayerIds: parseAceIds(req.body.ace_player_ids),
      ctpPlayerId: req.body.ctp_player_id ? Number(req.body.ctp_player_id) : null,
      winnerTeamId: req.body.winner_team_id ? Number(req.body.winner_team_id) : null
    }, req.session.user.username);
    setFlash(req, 'Completed round payouts corrected.');
  } catch (error) {
    setFlash(req, error.message);
  }
  res.redirect(`/rounds/${roundId}/detail`);
});

app.get('/admin/export/rounds.csv', requireAdmin, (req, res) => {
  res.type('text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="doubles-rounds.csv"');
  res.send(repo.exportRoundsCsv());
});

app.get('/admin/export/payouts.csv', requireAdmin, (req, res) => {
  res.type('text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="doubles-payouts.csv"');
  res.send(repo.exportPayoutsCsv());
});

app.post('/rounds/:id/cancel', requireAdmin, (req, res) => {
  repo.cancelRound(Number(req.params.id), req.session.user.username);
  setFlash(req, 'Active round canceled.');
  res.redirect('/');
});

app.get('/admin/settings', requireAdmin, (req, res) => {
  res.render('admin-settings', { holes: repo.getEligibleCtpHoles(), acePot: repo.getAcePot(), dbPath, auditLog: repo.getAuditLog(100) });
});
app.post('/admin/settings', requireAdmin, (req, res) => {
  const holes = (req.body.holes || '').split(',').map((h) => h.trim()).filter(Boolean);
  repo.setEligibleCtpHoles(holes);
  if (req.body.ace_pot !== undefined && req.body.ace_pot !== '') repo.setAcePot(Number(req.body.ace_pot || 0));
  repo.logAudit('settings.updated', 'Updated admin settings', null, req.session.user.username);
  setFlash(req, 'Settings updated.');
  res.redirect('/admin/settings');
});

app.get('/admin/stats', requireAdmin, (req, res) => res.render('admin-stats', { stats: repo.getStats() }));

app.use((req, res) => res.status(404).render('error', { message: 'Not found.' }));
app.listen(PORT, () => console.log(`Doubles App listening on ${PORT}`));
