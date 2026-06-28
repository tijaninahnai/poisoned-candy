const mongoose = require('mongoose');

const gameSessionSchema = new mongoose.Schema({
  roomCode: {
    type: String,
    required: true,
    unique: true
  },
  candy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Candy',
    required: true
  },
  fieldSize: {
    type: Number,
    default: 30
  },
  field: {
    type: [
      {
        x: Number,
        y: Number,
        rotation: Number
      }
    ],
    default: []
  },
  poisonedIndex: {
    type: Number,
    required: true,
    select: false
  },
  players: {
    type: [
      {
        socketId: String,
        name: String,
        hasPicked: { type: Boolean, default: false },
        pickedIndex: { type: Number, default: null },
        result: { type: String, enum: ['pending', 'won', 'lost'], default: 'pending' }
      }
    ],
    default: []
  },
  status: {
    type: String,
    enum: ['waiting', 'in_progress', 'finished'],
    default: 'waiting'
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 86400
  }
});

module.exports = mongoose.model('GameSession', gameSessionSchema);
