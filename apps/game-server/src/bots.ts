/**
 * Fictional players. They power the blueprint §3 practice round (a solo host with
 * a full table) and double as an end-to-end harness that can complete a whole
 * night unattended. Bots run server-side, so they may read the private projection
 * — they are not a client and never receive secrets over the wire.
 */
import type { GamePublicView, GamePrivateView, GameType } from '@roomriot/contracts';
import { rankValue } from '@roomriot/game-core';

export interface BotMove {
  type: string;
  payload: unknown;
}

export function isBot(guestId: string): boolean {
  return guestId.startsWith('bot:');
}

const DECOYS = ['A small mammal', 'The number forty', 'A type of cloud', 'An old French word', 'Something blue', 'A kind of knot'];
const CAPTIONS = ['This is fine.', 'Absolutely feral behaviour.', 'Living the dream, honestly.', 'No thoughts, only vibes.', 'A bold strategy.', 'Iconic, if you ask me.'];
const CLUES = ['I usually go there on weekends.', 'It can get pretty loud.', 'You often need tickets.', 'Great place for a photo.', 'I always lose track of time here.', 'Bring comfortable shoes.'];

function rand<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/** Returns the move(s) a bot should make in the current phase, or [] to wait. */
export function botActionFor(
  gameType: GameType,
  pub: GamePublicView,
  priv: GamePrivateView,
  selfId: string,
  _members: Map<string, unknown>,
): BotMove | null {
  const moves = botMoves(gameType, pub, priv, selfId);
  return moves[0] ?? null;
}

export function botMoves(gameType: GameType, pub: GamePublicView, priv: GamePrivateView, selfId: string): BotMove[] {
  const options = pub.options ?? [];
  switch (gameType) {
    case 'majority_report': {
      if (pub.phaseKind !== 'choosing' || options.length === 0) return [];
      return [{ type: 'submit_round', payload: { answer: rand(options).id, forecast: rand(options).id } }];
    }
    case 'bluff_bureau': {
      if (pub.phaseKind === 'writing') return [{ type: 'submit_decoy', payload: { text: rand(DECOYS) } }];
      if (pub.phaseKind === 'voting') {
        const ownId = (priv.secret as { ownOptionId?: string } | undefined)?.ownOptionId;
        const pick = options.filter((o) => o.id !== ownId);
        if (pick.length === 0) return [];
        return [{ type: 'submit_vote', payload: { optionId: rand(pick).id } }];
      }
      return [];
    }
    case 'caption_court': {
      if (pub.phaseKind === 'writing') return [{ type: 'submit_caption', payload: { text: rand(CAPTIONS) } }];
      if (pub.phaseKind === 'voting') {
        const ownId = (priv.secret as { ownOptionId?: string } | undefined)?.ownOptionId;
        const pick = options.filter((o) => o.id !== ownId);
        if (pick.length === 0) return [];
        return [{ type: 'submit_vote', payload: { optionId: rand(pick).id } }];
      }
      return [];
    }
    case 'link_up': {
      if (pub.phaseKind !== 'choosing' || options.length === 0) return [];
      return [{ type: 'submit_choice', payload: { optionId: rand(options).id } }];
    }
    case 'alibi_club': {
      if (pub.phaseKind === 'clue') return [{ type: 'submit_clue', payload: { text: rand(CLUES) } }];
      if (pub.phaseKind === 'accuse') {
        const targets = options.filter((o) => o.id !== selfId);
        const out: BotMove[] = [];
        if (targets.length > 0) out.push({ type: 'submit_accusation', payload: { targetMemberId: rand(targets).id } });
        const secret = priv.secret as { role?: string; locationOptions?: string[] } | undefined;
        if (secret?.role === 'outsider' && secret.locationOptions?.length) {
          out.push({ type: 'submit_outsider_guess', payload: { location: rand(secret.locationOptions) } });
        }
        return out;
      }
      return [];
    }
    case 'close_call': {
      if (pub.phaseKind !== 'estimate') return [];
      const rangeMax = (pub.prompt as { rangeMax?: number } | undefined)?.rangeMax ?? 20;
      return [{ type: 'submit_estimate', payload: { value: Math.floor(Math.random() * (rangeMax + 1)) } }];
    }
    case 'snakes_and_ladders': {
      // runBots only reaches the active seat (awaitingInput); it simply rolls.
      if (pub.phaseKind !== 'rolling') return [];
      return [{ type: 'roll', payload: {} }];
    }
    case 'judgement': {
      const secret = priv.secret as { hand?: string[]; legalBids?: number[]; legalCards?: string[] } | undefined;
      const trump = (pub.prompt as { trump?: string } | undefined)?.trump;
      if (pub.phaseKind === 'bidding' && secret?.legalBids?.length) {
        // Estimate tricks from aces + trumps, then snap to the nearest legal bid.
        const hand = secret.hand ?? [];
        const est = hand.filter((c) => c[0] === 'A' || c[1] === trump).length;
        const bid = secret.legalBids.reduce((best, v) => (Math.abs(v - est) < Math.abs(best - est) ? v : best), secret.legalBids[0]!);
        return [{ type: 'bid', payload: { bid } }];
      }
      if (pub.phaseKind === 'playing' && secret?.legalCards?.length) {
        // Transparent heuristic: shed the lowest legal card.
        const card = [...secret.legalCards].sort((a, b) => rankValue(a) - rankValue(b))[0]!;
        return [{ type: 'play_card', payload: { card } }];
      }
      return [];
    }
    default:
      return [];
  }
}
