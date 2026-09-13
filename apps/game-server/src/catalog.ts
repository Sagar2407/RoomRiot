/**
 * Public game catalog (plan §11.3, §12). Lists what the deployment has actually
 * enabled, so the host UI can offer newly-shipped games only where they're turned
 * on. Classics stay absent until ROOM_RIOT_ENABLE_CLASSICS / ROOM_RIOT_ENABLED_GAMES
 * turns them on — a deployed-but-unfinished game is never advertised.
 */
import { getGameModule } from '@roomriot/game-core';
import { PARTY_GAMES, type GameType } from '@roomriot/contracts';
import { config } from './config.js';

export interface CatalogEntry {
  id: GameType;
  title: string;
  family: string;
  minPlayers: number;
  maxPlayers: number;
  interactionMode: 'simultaneous' | 'sequential';
}

export function catalog(): { classics: CatalogEntry[]; enabledGames: GameType[] } {
  const enabled = config.enabledGames as GameType[];
  const entry = (id: GameType): CatalogEntry => {
    const mod = getGameModule(id);
    return {
      id,
      title: mod.manifest.title,
      family: mod.manifest.family,
      minPlayers: mod.manifest.minPlayers,
      maxPlayers: mod.manifest.maxPlayers,
      interactionMode: mod.interactionMode ?? 'simultaneous',
    };
  };
  const classics = enabled.filter((g) => !(PARTY_GAMES as GameType[]).includes(g)).map(entry);
  return { classics, enabledGames: enabled };
}
