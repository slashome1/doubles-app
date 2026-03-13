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

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const activeRound = repo.getActiveRound();
  if (activeRound) return res.redirect(`/rounds/${activeRound.id}`);
  res.render('home', { acePot: repo.getAcePot(), activeRound: null });
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
  const activeRound = repo.getActiveRound();
  if (activeRound) return res.redirect(`/rounds/${activeRound.id}`);
  const round = repo.createRound();
  res.redirect(`/rounds/${round.id}`);
});

app.get('/rounds/:id', requireAuth, (req, res) => {
  const round = repo.getRound(Number(req.params.id));
  if (!round) return res.status(404).render('error', { message: 'Round not found.' });
  const players = repo.getRoundPlayers(round.id);
  const teams = repo.getRoundTeams(round.id);
  res.render('round', {
    round,
    players,
    teams,
    acePot: repo.getAcePot(),
    allPlayers: repo.listPlayers(),
    eligibleHoles: repo.getEligibleCtpHoles()
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
    });
    setFlash(req, `${player.name} added.`);
  } catch (error) {
    setFlash(req, error.message);
  }
  res.redirect(`/rounds/${roundId}`);
});

app.post('/round-players/:id/update', requireAuth, (req, res) => {
  repo.updateRoundPlayer(Number(req.params.id), {
    is_member: req.body.is_member === 'on',
    greens_fee: Number(req.body.greens_fee || 0),
    ctp_paid: req.body.ctp_paid === 'on',
    ace_paid: req.body.ace_paid === 'on',
    payout_paid: req.body.payout_paid === 'on',
    dropped: req.body.dropped === 'on'
  });
  setFlash(req, 'Player entry updated.');
  res.redirect('back');
});

app.post('/round-players/:id/delete', requireAdmin, (req, res) => {
  repo.removeRoundPlayer(Number(req.params.id));
  setFlash(req, 'Player removed from round.');
  res.redirect('back');
});

app.post('/rounds/:id/start', requireAuth, (req, res) => {
  const roundId = Number(req.params.id);
  const holes = repo.getEligibleCtpHoles();
  if (!holes.length) {
    setFlash(req, 'No eligible CTP holes set by admin yet.');
    return res.redirect(`/rounds/${roundId}`);
  }
  const hole = holes[Math.floor(Math.random() * holes.length)];
  repo.setRoundCtpHole(roundId, hole);
  setFlash(req, `CTP hole selected: ${hole}`);
  res.redirect(`/rounds/${roundId}`);
});

app.post('/rounds/:id/randomize', requireAuth, (req, res) => {
  try {
    repo.generateTeams(Number(req.params.id));
    setFlash(req, 'Teams randomized.');
  } catch (error) {
    setFlash(req, error.message);
  }
  res.redirect(`/rounds/${req.params.id}`);
});

app.post('/rounds/:id/manual-teams', requireAdmin, (req, res) => {
  const raw = (req.body.teams || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const players = repo.getRoundPlayers(Number(req.params.id)).filter((p) => !p.dropped);
  const entries = raw.map((line, idx) => {
    const names = line.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const matched = players.filter((p) => names.includes(p.name.toLowerCase())).map((p) => p.id);
    return { name: `Team ${idx + 1}`, playerIds: matched };
  });
  repo.setManualTeams(Number(req.params.id), entries);
  setFlash(req, 'Teams updated manually.');
  res.redirect(`/rounds/${req.params.id}`);
});

app.post('/rounds/:id/complete', requireAuth, (req, res) => {
  const roundId = Number(req.params.id);
  const acePlayerIds = Array.isArray(req.body.ace_player_ids)
    ? req.body.ace_player_ids.map(Number)
    : req.body.ace_player_ids ? [Number(req.body.ace_player_ids)] : [];
  repo.completeRound(roundId, {
    aceResult: req.body.ace_result,
    acePlayerIds,
    ctpPlayerId: req.body.ctp_player_id ? Number(req.body.ctp_player_id) : null,
    winnerTeamId: req.body.winner_team_id ? Number(req.body.winner_team_id) : null
  });
  setFlash(req, 'Round completed and payouts saved.');
  res.redirect('/');
});

app.post('/rounds/:id/cancel', requireAdmin, (req, res) => {
  repo.cancelRound(Number(req.params.id));
  setFlash(req, 'Active round canceled.');
  res.redirect('/');
});

app.get('/admin/settings', requireAdmin, (req, res) => {
  res.render('admin-settings', { holes: repo.getEligibleCtpHoles(), acePot: repo.getAcePot(), dbPath });
});
app.post('/admin/settings', requireAdmin, (req, res) => {
  const holes = (req.body.holes || '').split(',').map((h) => h.trim()).filter(Boolean);
  repo.setEligibleCtpHoles(holes);
  if (req.body.ace_pot !== undefined && req.body.ace_pot !== '') repo.setAcePot(Number(req.body.ace_pot || 0));
  setFlash(req, 'Settings updated.');
  res.redirect('/admin/settings');
});

app.get('/admin/stats', requireAdmin, (req, res) => res.render('admin-stats', { stats: repo.getStats() }));

app.use((req, res) => res.status(404).render('error', { message: 'Not found.' }));
app.listen(PORT, () => console.log(`Doubles App listening on ${PORT}`));
