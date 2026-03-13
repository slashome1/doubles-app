function currency(amount) {
  return `$${Number(amount || 0).toFixed(2)}`;
}

module.exports = { currency };
