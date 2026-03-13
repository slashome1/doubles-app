const crypto = require("crypto");

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

function verifyPin(pin, stored) {
  if (!stored) return false;
  if (!stored.startsWith('scrypt:')) return String(pin) === String(stored);
  const [, salt, expected] = stored.split(':');
  const actual = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

module.exports = { hashPin, verifyPin };
