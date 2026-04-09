export type UpgradeRarity = 'common' | 'uncommon' | 'rare' | 'epic';
export type UpgradeHook = 'on_move' | 'on_ai_tick' | 'on_collision' | 'on_floor_start';

export interface UpgradeCompatibility {
  tags: Array<'survival' | 'mobility' | 'control' | 'scoring' | 'tempo'>;
  excludes?: string[];
  requires?: string[];
  stackable?: boolean;
  draftWeight?: number;
}

export interface UpgradeEventBase {
  random: () => number;
}

export interface MoveEffectEvent extends UpgradeEventBase {
  direction: 'up' | 'down' | 'left' | 'right';
  moved: boolean;
  blocked: boolean;
  collectedTarget: boolean;
  extraSteps: number;
  bonusScore: number;
  ignoreWallsForExtraStep: boolean;
}

export interface AITickEffectEvent extends UpgradeEventBase {
  skipMove: boolean;
  bonusScore: number;
}

export interface CollisionEffectEvent extends UpgradeEventBase {
  hadShield: boolean;
  consumeShield: boolean;
  preventLoss: boolean;
  stunAiTicks: number;
}

export interface FloorStartEffectEvent extends UpgradeEventBase {
  floor: number;
  bonusShields: number;
  threatDelta: number;
  floorTargetDelta: number;
  bonusScore: number;
}

export interface UpgradeDraftSnapshot {
  floor: number;
  score: number;
  shields: number;
  threatLevel: number;
  floorTarget: number;
}

export interface GameUpgradeDefinition {
  id: string;
  name: string;
  rarity: UpgradeRarity;
  description: string;
  compatibility: UpgradeCompatibility;
  hooks: Partial<{
    on_move: (event: MoveEffectEvent) => void;
    on_ai_tick: (event: AITickEffectEvent) => void;
    on_collision: (event: CollisionEffectEvent) => void;
    on_floor_start: (event: FloorStartEffectEvent) => void;
  }>;
  isUseful?: (snapshot: UpgradeDraftSnapshot, ownedIds: Set<string>) => boolean;
}

export const RARITY_WEIGHTS: Record<UpgradeRarity, number> = {
  common: 65,
  uncommon: 24,
  rare: 9,
  epic: 2,
};

export const AI_UPGRADES: GameUpgradeDefinition[] = [
  {
    id: 'aegis_mesh',
    name: 'Aegis Mesh',
    rarity: 'common',
    description: '25% chance to preserve a shield on collision.',
    compatibility: { tags: ['survival'], draftWeight: 1.2 },
    hooks: {
      on_collision: (event) => {
        if (event.hadShield && event.consumeShield && event.random() < 0.25) {
          event.consumeShield = false;
        }
      },
    },
    isUseful: (snapshot) => snapshot.shields > 0,
  },
  {
    id: 'auto_patch',
    name: 'Auto Patch',
    rarity: 'uncommon',
    description: 'Gain +1 shield at the start of each floor.',
    compatibility: { tags: ['survival'], draftWeight: 1.05 },
    hooks: {
      on_floor_start: (event) => {
        event.bonusShields += 1;
      },
    },
  },
  {
    id: 'last_stand',
    name: 'Last Stand',
    rarity: 'rare',
    description: '20% chance to survive a collision even with no shields.',
    compatibility: { tags: ['survival', 'tempo'] },
    hooks: {
      on_collision: (event) => {
        if (!event.hadShield && event.random() < 0.2) {
          event.preventLoss = true;
        }
      },
    },
  },
  {
    id: 'dash_coils',
    name: 'Dash Coils',
    rarity: 'common',
    description: '20% chance to immediately move one extra tile.',
    compatibility: { tags: ['mobility'] },
    hooks: {
      on_move: (event) => {
        if (event.moved && event.random() < 0.2) {
          event.extraSteps += 1;
        }
      },
    },
  },
  {
    id: 'ghost_step',
    name: 'Ghost Step',
    rarity: 'uncommon',
    description: 'When blocked, 35% chance your bonus step phases through walls.',
    compatibility: { tags: ['mobility', 'control'], requires: ['dash_coils'] },
    hooks: {
      on_move: (event) => {
        if (event.blocked && event.random() < 0.35) {
          event.extraSteps += 1;
          event.ignoreWallsForExtraStep = true;
        }
      },
    },
  },
  {
    id: 'vector_thrusters',
    name: 'Vector Thrusters',
    rarity: 'rare',
    description: 'Always gain +1 extra movement step when you move.',
    compatibility: { tags: ['mobility', 'tempo'], excludes: ['dash_coils'] },
    hooks: {
      on_move: (event) => {
        if (event.moved) {
          event.extraSteps += 1;
        }
      },
    },
  },
  {
    id: 'jammer_spike',
    name: 'Jammer Spike',
    rarity: 'common',
    description: '18% chance each AI tick to cancel the hunter movement.',
    compatibility: { tags: ['control'] },
    hooks: {
      on_ai_tick: (event) => {
        if (event.random() < 0.18) {
          event.skipMove = true;
        }
      },
    },
  },
  {
    id: 'stasis_emitter',
    name: 'Stasis Emitter',
    rarity: 'uncommon',
    description: 'Collisions that consume shield also stun AI for 1 tick.',
    compatibility: { tags: ['control', 'survival'] },
    hooks: {
      on_collision: (event) => {
        if (event.hadShield && event.consumeShield) {
          event.stunAiTicks = Math.max(event.stunAiTicks, 1);
        }
      },
    },
  },
  {
    id: 'trap_routine',
    name: 'Trap Routine',
    rarity: 'rare',
    description: 'Reduce floor threat by 1 whenever a new floor begins.',
    compatibility: { tags: ['control'] },
    hooks: {
      on_floor_start: (event) => {
        event.threatDelta -= 1;
      },
    },
  },
  {
    id: 'data_miner',
    name: 'Data Miner',
    rarity: 'common',
    description: 'Collecting DATA grants +1 bonus score.',
    compatibility: { tags: ['scoring'] },
    hooks: {
      on_move: (event) => {
        if (event.collectedTarget) {
          event.bonusScore += 1;
        }
      },
    },
  },
  {
    id: 'multiplier_node',
    name: 'Multiplier Node',
    rarity: 'uncommon',
    description: 'Gain +1 score on each floor start.',
    compatibility: { tags: ['scoring', 'tempo'] },
    hooks: {
      on_floor_start: (event) => {
        event.bonusScore += 1;
      },
    },
  },
  {
    id: 'compression_suite',
    name: 'Compression Suite',
    rarity: 'rare',
    description: 'Each floor requires 1 less DATA objective (min 3).',
    compatibility: { tags: ['scoring', 'mobility'] },
    hooks: {
      on_floor_start: (event) => {
        event.floorTargetDelta -= 1;
      },
    },
    isUseful: (snapshot) => snapshot.floorTarget > 3,
  },
  {
    id: 'chrono_break',
    name: 'Chrono Break',
    rarity: 'epic',
    description: '8% chance per AI tick to cancel movement and score +1.',
    compatibility: { tags: ['control', 'scoring'], draftWeight: 0.8 },
    hooks: {
      on_ai_tick: (event) => {
        if (event.random() < 0.08) {
          event.skipMove = true;
          event.bonusScore += 1;
        }
      },
    },
  },
  {
    id: 'jackpot_protocol',
    name: 'Jackpot Protocol',
    rarity: 'epic',
    description: '20% chance to gain +3 extra score on DATA pickup.',
    compatibility: { tags: ['scoring'] },
    hooks: {
      on_move: (event) => {
        if (event.collectedTarget && event.random() < 0.2) {
          event.bonusScore += 3;
        }
      },
    },
  },
];

export const UPGRADE_MAP = new Map(AI_UPGRADES.map((upgrade) => [upgrade.id, upgrade]));
