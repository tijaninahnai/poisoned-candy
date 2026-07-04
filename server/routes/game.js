const express = require('express');
const router = express.Router();
const GameSession = require('../models/GameSession');
const Candy = require('../models/Candy');

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function generateField() {
  const cols = 5;
  const rows = 4;
  const positions = [];
  const colStep = 100 / (cols + 1);
  const rowStep = 100 / (rows + 1);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const jitterX = (Math.random() - 0.5) * 4;
      const jitterY = (Math.random() - 0.5) * 4;
      positions.push({
        x: Math.round((colStep * (c + 1) + jitterX) * 10) / 10,
        y: Math.round((rowStep * (r + 1) + jitterY) * 10) / 10,
        rotation: Math.floor(Math.random() * 360)
      });
    }
  }
  return positions;
}

router.get('/next-date', async (req, res) => {
  try {
    const lastCandy = await Candy.findOne({ scheduledDate: { $ne: null } }).sort({ scheduledDate: -1 });
    const baseDate = lastCandy ? new Date(lastCandy.scheduledDate) : new Date();
    baseDate.setDate(baseDate.getDate() + 1);
    res.json({ nextDate: baseDate.toISOString().split('T')[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/queue', async (req, res) => {
  try {
    const candies = await Candy.find().sort({ queuePosition: 1 });
    res.json(candies);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/today', async (req, res) => {
  try {
    const candy = await Candy.findOne({ status: 'active' });
    if (!candy) return res.status(404).json({ error: 'No active candy today' });
    res.json(candy);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/create', async (req, res) => {
  try {
    const { playerName } = req.body;
    if (!playerName) return res.status(400).json({ error: 'Player name is required' });

    const candy = await Candy.findOne({ status: 'active' });
    if (!candy) return res.status(404).json({ error: 'No active candy today' });

    let roomCode;
    let exists = true;
    while (exists) {
      roomCode = generateRoomCode();
      exists = await GameSession.findOne({ roomCode });
    }

    const field = generateField();

    const session = new GameSession({
      roomCode, candy: candy._id, field,
      poisonedCandies: [], readyPlayers: [],
      gamePhase: 'setup', isSolo: false,
      players: [{ name: playerName, socketId: null, result: 'pending' }],
      status: 'waiting'
    });

    await session.save();
    res.json({ success: true, roomCode, field, candy: { name: candy.name, imageUrl: candy.imageUrl, colorPalette: candy.colorPalette } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/solo', async (req, res) => {
  try {
    const { playerName } = req.body;
    if (!playerName) return res.status(400).json({ error: 'Player name is required' });

    const candy = await Candy.findOne({ status: 'active' });
    if (!candy) return res.status(404).json({ error: 'No active candy today' });

    let roomCode;
    let exists = true;
    while (exists) {
      roomCode = generateRoomCode();
      exists = await GameSession.findOne({ roomCode });
    }

    const field = generateField();
    const pcPoisonIndex = Math.floor(Math.random() * field.length);

    const session = new GameSession({
      roomCode, candy: candy._id, field,
      poisonedCandies: [{ playerIndex: 1, candyIndex: pcPoisonIndex }],
      readyPlayers: [1], gamePhase: 'setup', isSolo: true,
      players: [
        { name: playerName, socketId: null, result: 'pending' },
        { name: 'CPU', socketId: 'cpu', result: 'pending' }
      ],
      status: 'in_progress'
    });

    await session.save();
    res.json({ success: true, roomCode, isSolo: true, field, candy: { name: candy.name, imageUrl: candy.imageUrl, colorPalette: candy.colorPalette } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:roomCode', async (req, res) => {
  try {
    const session = await GameSession.findOne({ roomCode: req.params.roomCode }).populate('candy');
    if (!session) return res.status(404).json({ error: 'Room not found' });
    res.json({
      roomCode: session.roomCode,
      status: session.status,
      gamePhase: session.gamePhase,
      isSolo: session.isSolo,
      field: session.field,
      players: session.players.map(p => ({ name: p.name, socketId: p.socketId })),
      candy: { name: session.candy.name, imageUrl: session.candy.imageUrl, colorPalette: session.candy.colorPalette }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/join', async (req, res) => {
  try {
    const { roomCode, playerName } = req.body;
    if (!roomCode || !playerName) return res.status(400).json({ error: 'Room code and player name required' });

    const session = await GameSession.findOne({ roomCode: roomCode.toUpperCase() }).populate('candy');
    if (!session) return res.status(404).json({ error: 'Room not found' });
    if (session.players.length >= 2) return res.status(400).json({ error: 'Room is full' });
    if (session.status !== 'waiting') return res.status(400).json({ error: 'Game already started' });

    session.players.push({ name: playerName, socketId: null, result: 'pending' });
    session.status = 'in_progress';
    await session.save();

    res.json({ success: true, roomCode: session.roomCode, field: session.field, candy: { name: session.candy.name, imageUrl: session.candy.imageUrl, colorPalette: session.candy.colorPalette } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
