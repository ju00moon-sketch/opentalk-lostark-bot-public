// Keep integer numerators intact until the final division to avoid rounding drift.
export const evenShareBid = (price, partySize) => (price * 95 * (partySize - 1)) / (100 * partySize);
export const preemptBid = (price, partySize) => (price * 95 * (partySize - 1) * 10) / (100 * partySize * 11);
export const resaleCap = price => (price * 95) / 100;
