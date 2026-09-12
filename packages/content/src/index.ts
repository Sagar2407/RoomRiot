/**
 * @roomriot/content — reviewed prompt bank for the six launch games.
 *
 * This is a starter bank sized for the Phase-1 slice, not the full launch corpus
 * (blueprint §11 proposes ~240 reviewed items). Every item carries the metadata a
 * real editorial pipeline needs: id, version, game type, locale, maturity, tags,
 * author, and review state. Answers/sources live here on the server side and must
 * never ship to the browser (blueprint §8) — the game server only sends revealed
 * information through projections.
 */
import type { ContentItem } from '@roomriot/game-core';
import type { GameType } from '@roomriot/contracts';

function item(
  id: string,
  gameType: GameType,
  data: unknown,
  tags: string[] = [],
): ContentItem {
  return {
    id,
    version: 1,
    gameType,
    locale: 'en-US',
    maturity: 'everyone',
    tags,
    author: 'roomriot-editorial',
    reviewState: 'published',
    data,
  };
}

const opt = (labels: string[]) =>
  labels.map((label, i) => ({ id: `o${i + 1}`, label }));

// --------------------------------------------------------------------------
// Majority Report — question + options (forecast the most popular pick).
// --------------------------------------------------------------------------
const majorityReport: ContentItem[] = [
  item('mr-001', 'majority_report', {
    question: 'Which useless power would improve your life most?',
    options: opt(['Talk to houseplants', 'Always find matching socks', 'Summon perfect toast', 'Instantly parallel park']),
  }),
  item('mr-002', 'majority_report', {
    question: 'The group trip is doomed. What ruins it first?',
    options: opt(['A "shortcut"', 'The shared playlist', 'One ambitious itinerary', 'The 5am wake-up']),
  }),
  item('mr-003', 'majority_report', {
    question: 'Best snack to bring to a party?',
    options: opt(['Chips & dip', 'Mystery casserole', 'Fancy cheese', 'A single grape, presented well']),
  }),
  item('mr-004', 'majority_report', {
    question: 'Which house chore is secretly the worst?',
    options: opt(['Folding fitted sheets', 'Emptying the dishwasher', 'Taking out recycling', 'Replacing the bin bag']),
  }),
  item('mr-005', 'majority_report', {
    question: 'If our friend group started a band, what genre are we?',
    options: opt(['Chaotic jazz', 'Overproduced pop', 'One very long guitar solo', 'Suspiciously good sea shanties']),
  }),
  item('mr-006', 'majority_report', {
    question: 'Pick the most defensible pizza topping.',
    options: opt(['Pepperoni', 'Mushroom', 'Pineapple', 'Extra cheese, no notes']),
  }),
  item('mr-007', 'majority_report', {
    question: 'The office coffee machine gains sentience. What does it want?',
    options: opt(['A raise', 'Revenge', 'A day off', 'To be left alone']),
  }),
  item('mr-008', 'majority_report', {
    question: 'Which is the superior weekend?',
    options: opt(['Big loud plans', 'Total hermit mode', 'One good outing', 'Improvised and unplanned']),
  }),
];

// --------------------------------------------------------------------------
// Bluff Bureau — a surprising true answer players must find among decoys.
// --------------------------------------------------------------------------
const bluffBureau: ContentItem[] = [
  item('bb-001', 'bluff_bureau', {
    question: 'A "murmuration" is the collective noun for a group of which animals?',
    answer: 'Starlings',
    source: 'Common English collective nouns',
  }),
  item('bb-002', 'bluff_bureau', {
    question: 'What was bubble wrap originally invented to be?',
    answer: 'Textured wallpaper',
    source: 'Widely documented product history',
  }),
  item('bb-003', 'bluff_bureau', {
    question: 'The dot over a lowercase "i" or "j" has a name. What is it?',
    answer: 'A tittle',
    source: 'Typography terminology',
  }),
  item('bb-004', 'bluff_bureau', {
    question: 'What is a group of flamingos called?',
    answer: 'A flamboyance',
    source: 'Common English collective nouns',
  }),
  item('bb-005', 'bluff_bureau', {
    question: 'Honey found in ancient tombs was still edible because honey is essentially what?',
    answer: 'Non-perishable',
    source: 'Food science — low moisture, high acidity',
  }),
  item('bb-006', 'bluff_bureau', {
    question: 'What do you call the plastic or metal tip at the end of a shoelace?',
    answer: 'An aglet',
    source: 'Apparel terminology',
  }),
];

// --------------------------------------------------------------------------
// Caption Court — an original text scenario to caption.
// --------------------------------------------------------------------------
const captionCourt: ContentItem[] = [
  item('cc-001', 'caption_court', { scenario: 'A robot discovers the office coffee budget.' }),
  item('cc-002', 'caption_court', { scenario: 'Two pigeons are clearly planning something on the windowsill.' }),
  item('cc-003', 'caption_court', { scenario: 'A cat sits in the exact centre of a brand-new puzzle.' }),
  item('cc-004', 'caption_court', { scenario: 'The GPS confidently says "you have arrived" in the middle of a lake.' }),
  item('cc-005', 'caption_court', { scenario: 'A toddler negotiates bedtime like a seasoned diplomat.' }),
  item('cc-006', 'caption_court', { scenario: 'The last slice of cake is left alone at the party, glowing faintly.' }),
];

// --------------------------------------------------------------------------
// Link Up — a four-option question; match your assigned partner's pick.
// --------------------------------------------------------------------------
const linkUp: ContentItem[] = [
  item('lu-001', 'link_up', {
    question: 'Our disastrous food truck should sell:',
    options: opt(['Moon noodles', 'Tiny lasagna', 'Suspicious soup', 'Emotional-support fries']),
  }),
  item('lu-002', 'link_up', {
    question: 'Our team mascot is definitely a:',
    options: opt(['Dramatic goose', 'Caffeinated squirrel', 'Wise old cat', 'Confused but confident dog']),
  }),
  item('lu-003', 'link_up', {
    question: 'The group vacation house needs one of these most:',
    options: opt(['A hot tub', 'A great kitchen', 'A ridiculous view', 'Fast, reliable wifi']),
  }),
  item('lu-004', 'link_up', {
    question: 'Best way to settle a friendly argument:',
    options: opt(['Rock paper scissors', 'A quick vote', 'Loudest person wins', 'Pretend it never happened']),
  }),
  item('lu-005', 'link_up', {
    question: 'Our superhero team’s weakness is clearly:',
    options: opt(['Mondays', 'Group chats', 'Assembling furniture', 'Deciding where to eat']),
  }),
  item('lu-006', 'link_up', {
    question: 'The one item to grab from a burning (fictional) house:',
    options: opt(['The photo albums', 'The good speaker', 'The houseplant', 'The snacks']),
  }),
];

// --------------------------------------------------------------------------
// Alibi Club — category + true location + four location choices (incl. truth).
// --------------------------------------------------------------------------
const alibiClub: ContentItem[] = [
  item('ac-001', 'alibi_club', {
    category: 'A place people visit',
    location: 'Aquarium',
    options: ['Aquarium', 'Museum', 'Zoo', 'Botanical garden'],
  }),
  item('ac-002', 'alibi_club', {
    category: 'A place people visit',
    location: 'Airport',
    options: ['Airport', 'Train station', 'Bus depot', 'Ferry terminal'],
  }),
  item('ac-003', 'alibi_club', {
    category: 'A place people visit',
    location: 'Gym',
    options: ['Gym', 'Swimming pool', 'Rock-climbing wall', 'Yoga studio'],
  }),
  item('ac-004', 'alibi_club', {
    category: 'A place people visit',
    location: 'Cinema',
    options: ['Cinema', 'Theatre', 'Concert hall', 'Comedy club'],
  }),
  item('ac-005', 'alibi_club', {
    category: 'A place people visit',
    location: 'Farmers market',
    options: ['Farmers market', 'Supermarket', 'Shopping mall', 'Bakery'],
  }),
  item('ac-006', 'alibi_club', {
    category: 'A place people visit',
    location: 'Library',
    options: ['Library', 'Bookshop', 'University campus', 'Study café'],
  }),
];

// --------------------------------------------------------------------------
// Close Call — text puzzle with a known positive answer and counting rule.
// --------------------------------------------------------------------------
const closeCall: ContentItem[] = [
  item('cl-001', 'close_call', {
    prompt: 'A standard six-sided die is rolled 30 times. If it landed on an even number exactly half the time, how many even results were there?',
    answer: 15,
    rangeMax: 30,
    countingRule: 'Half of 30.',
  }),
  item('cl-002', 'close_call', {
    prompt: 'A dozen eggs, minus the three that cracked, times two cartons. How many usable eggs?',
    answer: 18,
    rangeMax: 48,
    countingRule: '(12 − 3) × 2.',
  }),
  item('cl-003', 'close_call', {
    prompt: 'There are 4 tables with 6 chairs each, plus 5 spare chairs against the wall. How many chairs total?',
    answer: 29,
    rangeMax: 60,
    countingRule: '(4 × 6) + 5.',
  }),
  item('cl-004', 'close_call', {
    prompt: 'A playlist has 9 songs that average 4 minutes each. Roughly how many minutes long is it?',
    answer: 36,
    rangeMax: 90,
    countingRule: '9 × 4.',
  }),
  item('cl-005', 'close_call', {
    prompt: 'A week of daily 20-minute walks — how many total minutes of walking?',
    answer: 140,
    rangeMax: 300,
    countingRule: '7 × 20.',
  }),
  item('cl-006', 'close_call', {
    prompt: 'A pizza is cut into 8 slices. Three friends each eat 2 slices. How many slices remain?',
    answer: 2,
    rangeMax: 8,
    countingRule: '8 − (3 × 2).',
  }),
];

export const contentBank: ContentItem[] = [
  ...majorityReport,
  ...bluffBureau,
  ...captionCourt,
  ...linkUp,
  ...alibiClub,
  ...closeCall,
];

export function getContentFor(gameType: GameType): ContentItem[] {
  return contentBank.filter((c) => c.gameType === gameType);
}

/**
 * The practice room (blueprint §3): a 45-second solo Majority Report round with
 * fictional players, for someone evaluating the app alone.
 */
export const practicePrompt = majorityReport[0]!;
