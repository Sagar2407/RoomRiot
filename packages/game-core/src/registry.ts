import type { GameType } from '@roomriot/contracts';
import type { GameModule } from './types.js';
import { majorityReport } from './games/majorityReport.js';
import { bluffBureau } from './games/bluffBureau.js';
import { captionCourt } from './games/captionCourt.js';
import { linkUp } from './games/linkUp.js';
import { alibiClub } from './games/alibiClub.js';
import { closeCall } from './games/closeCall.js';
import { snakesAndLadders } from './games/snakesAndLadders.js';
import { judgement } from './games/judgement.js';
import { teenPatti } from './games/teenPatti.js';
import { ludo } from './games/ludo.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const modules: Record<GameType, GameModule<any>> = {
  majority_report: majorityReport,
  bluff_bureau: bluffBureau,
  caption_court: captionCourt,
  link_up: linkUp,
  alibi_club: alibiClub,
  close_call: closeCall,
  snakes_and_ladders: snakesAndLadders,
  judgement,
  teen_patti: teenPatti,
  ludo,
};

export function getGameModule(type: GameType): GameModule {
  const m = modules[type];
  if (!m) throw new Error(`Unknown game type: ${type}`);
  return m as GameModule;
}

export function allManifests() {
  return (Object.keys(modules) as GameType[]).map((t) => modules[t].manifest);
}
