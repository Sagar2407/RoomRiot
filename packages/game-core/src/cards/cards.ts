/**
 * A standard 52-card deck and the primitives shared by the card games
 * (Judgement now, Teen Patti next). Card IDs are compact two-char strings —
 * `<rank><suit>` — e.g. 'AS' (ace of spades), 'TD' (ten of diamonds), '2C'.
 *
 * Deck order is produced by a server-side cryptographic shuffle (see the game
 * server's randomness.ts) and kept private; the client only ever sees its own
 * hand and already-played cards.
 */
export const SUITS = ['S', 'D', 'C', 'H'] as const;
export type Suit = (typeof SUITS)[number];

/** Ranks from high to low. */
export const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'] as const;
export type Rank = (typeof RANKS)[number];

const RANK_VALUE: Record<string, number> = Object.fromEntries(RANKS.map((r, i) => [r, 14 - i]));

export const SUIT_NAME: Record<Suit, string> = { S: 'Spades', D: 'Diamonds', C: 'Clubs', H: 'Hearts' };
export const SUIT_SYMBOL: Record<Suit, string> = { S: '♠', D: '♦', C: '♣', H: '♥' };

/** All 52 card IDs, suit-major then rank high→low. */
export const FULL_DECK: string[] = SUITS.flatMap((s) => RANKS.map((r) => `${r}${s}`));

export function suitOf(card: string): Suit {
  return card[1] as Suit;
}
export function rankOf(card: string): Rank {
  return card[0] as Rank;
}
export function rankValue(card: string): number {
  return RANK_VALUE[card[0]!] ?? 0;
}

/** A stable display order for a hand: grouped by suit, then rank high→low. */
export function sortHand(cards: string[]): string[] {
  const suitOrder: Record<Suit, number> = { S: 0, H: 1, D: 2, C: 3 };
  return [...cards].sort((a, b) => {
    const bySuit = suitOrder[suitOf(a)] - suitOrder[suitOf(b)];
    return bySuit !== 0 ? bySuit : rankValue(b) - rankValue(a);
  });
}

/**
 * Which cards a player may legally play: if a lead suit is set and the player
 * holds it, they must follow suit; otherwise any card (trump included).
 */
export function legalPlays(hand: string[], leadSuit: Suit | null): string[] {
  if (!leadSuit) return [...hand];
  const following = hand.filter((c) => suitOf(c) === leadSuit);
  return following.length > 0 ? following : [...hand];
}

/**
 * The winning play of a completed/partial trick. The highest trump wins; with no
 * trump played, the highest card of the led suit wins. Off-suit non-trump cards
 * can never win.
 */
export function trickWinner(plays: Array<{ memberId: string; card: string }>, trump: Suit): { memberId: string; card: string } {
  if (plays.length === 0) throw new Error('trickWinner: empty trick');
  const leadSuit = suitOf(plays[0]!.card);
  const trumps = plays.filter((p) => suitOf(p.card) === trump);
  const pool = trumps.length > 0 ? trumps : plays.filter((p) => suitOf(p.card) === leadSuit);
  return pool.reduce((best, p) => (rankValue(p.card) > rankValue(best.card) ? p : best));
}
