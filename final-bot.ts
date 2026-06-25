/**
 * Win the water fight by controlling the most territory, or out-soak your opponent!
 **/

// Types
enum GameStrategy {
    /** One core group holds threat while others flank — avoids symmetric split */
    ETAU = 'etau',
    /** Focus fire on finishable / exposed targets — not a blind rush */
    FOCUS = 'focus',
    /** Hold territory in cover while maintaining threat range */
    VERROU = 'verrou',
    /** One weak ally baits enemies while others shoot from cover */
    BAIT = 'bait',
    /** One group pins enemies frontally while another flanks */
    TENAILLE = 'tenaille',
    /** Fallback state: retreat while preserving zone control */
    REPLI = 'repli',
}
type Coordinates = { x: number; y: number; };

type AgentIdentity = {
    agentId: number;
    playerId: number;
}
type AgentStats = {
    shootCooldown: number;
    optimalRange: number;
    soakingPower: number;
    splashBombs: number;
}
/** Agent data provided by the input before the game loop */
type AgentMetaData = AgentIdentity & AgentStats;

enum AgentBehavior {
    /** Engage with tactical target selection (finish / exposed / in-range) */
    ATTACK = 'ATTACK',
    /** Hold cover, deny area, overwatch at optimal range — replaces generic SUPPORT */
    HOLD_COVER = 'HOLD_COVER',
    /** Zone control at optimal range without over-committing */
    OVERWATCH = 'OVERWATCH',
    /** Tactical retreat: cover + threat range + break LoS */
    RETREAT = 'RETREAT',
    /** Exploit forced exposure — flank with cover chain awareness */
    FLANK = 'FLANK',
    /** Frontal pin so teammates can flank — formation role only */
    PIN = 'PIN',
    /** React to enemy flankers threatening our backline */
    PEEL = 'PEEL',
};

/** Data expected by the Agent constructor fn */
type AgentProps = {
    agentId: number;
    coordinates: Coordinates;
    cooldown: number,
    splashBombs: number,
    wetness: number
    metaData: AgentMetaData;
};

enum AgentActionName {
    MOVE = 'MOVE',
    MESSAGE = 'MESSAGE',
    SHOOT = 'SHOOT',
    THROW = 'THROW',
    HUNKER_DOWN = 'HUNKER_DOWN'
};
type AgentAction = {
    type: {
        name: AgentActionName;
        isBattleAction: boolean;
    };
    payload?: string;
};

enum TileType {
    EMPTY = 0,
    LOW_COVER = 1,
    HIGH_COVER = 2
}
type GameMapGridTile = (Coordinates & { tileType: TileType; });
type GameMapGrid = Map<string, GameMapGridTile>;

/** Tile that is protected by one or more obstacles */
type Cover = {
    tile: GameMapGridTile;
    obstacles: CoverObstacle[];
};
/** Relationship between a cover tile and the obstacle tile that offers protection */
type CoverObstacle = {
    coverAt: Direction;
    tile: GameMapGridTile;
    protectedAgainst: Coordinates[]
}

/** Set of positions under the protection of a certain tile type */
type ProtectionZone = {
    zone: Coordinates[];
    protectionType: TileType
};

enum Direction {
    TOP = 'TOP',
    RIGHT = 'RIGHT',
    BOTTOM = 'BOTTOM',
    LEFT = 'LEFT'
}

class Game {
    private readonly myId: number;
    private readonly gameMap: GameMap;
    private readonly allAgentsData = new Map<number, AgentMetaData>;
    private aliveAgents: Agent[] = [];
    private currentStrategy: GameStrategy;
    private turnCount = 0;
    private scoreAdvantage = 0; // Approximated as controlled tiles delta — updated each turn

    /** Read input and initialize game data */
    constructor() {
        this.myId = parseInt(readline()); // Your player id (0 or 1)

        // Read all agents data
        (() => {
            const agentsDataCount: number = parseInt(readline()); // Total number of agents in the game
            for (let i = 0; i < agentsDataCount; i++) {
                var inputs: string[] = readline().split(' ');
                const agentId: number = parseInt(inputs[0]); // Unique identifier for this agent
                const playerId: number = parseInt(inputs[1]); // Player id of this agent
                const shootCooldown: number = parseInt(inputs[2]); // Number of turns between each of this agent's shots
                const optimalRange: number = parseInt(inputs[3]); // Maximum manhattan distance for greatest damage output
                const soakingPower: number = parseInt(inputs[4]); // Damage output within optimal conditions
                const splashBombs: number = parseInt(inputs[5]); // Number of splash bombs this can throw this game

                this.allAgentsData.set(agentId, {
                    playerId,
                    agentId,
                    optimalRange,
                    shootCooldown,
                    soakingPower,
                    splashBombs
                });
            }
        })();

        // Read game map data
        this.gameMap = new GameMap();

        // Pick initial strategy
        this.currentStrategy = this.selectStrategy();
        console.error(`Initial strategy: ${this.currentStrategy}`);
    }

    private get aliveAllies () {
        return this.aliveAgents.filter((agent) => agent.metaData?.playerId === this.myId);
    }

    private get aliveEnemies () {
        return this.aliveAgents.filter((agent) => agent.metaData?.playerId !== this.myId);
    }

    private get allyWithLowestStats (): Agent {
        return [...this.aliveAllies]
            .sort((a, b) => {
                // 1. Fewer bombs = less valuable
                const bombsDiff = a.splashBombs - b.splashBombs;
                if (bombsDiff !== 0) return bombsDiff;

                // 2. Lower damage output = less valuable
                const soakingDiff = a.metaData.soakingPower - b.metaData.soakingPower;
                if (soakingDiff !== 0) return soakingDiff;

                // 3. Lower range = less valuable
                const rangeDiff = a.metaData.optimalRange - b.metaData.optimalRange;
                if (rangeDiff !== 0) return rangeDiff;

                // 4. More injured = less valuable
                return b.wetness - a.wetness;
            })[0];
    }

    private get allyWithHighestStats (): Agent {
        return [...this.aliveAllies]
            .sort((a, b) => {
                const soakingDiff = b.metaData.soakingPower - a.metaData.soakingPower;
                if (soakingDiff !== 0) return soakingDiff;
                const rangeDiff = b.metaData.optimalRange - a.metaData.optimalRange;
                if (rangeDiff !== 0) return rangeDiff;
                return b.splashBombs - a.splashBombs;
            })[0];
    }

    // =============================================================================
    // STRATEGY SELECTION
    // =============================================================================

    /**
     * Pick the best strategy given current game state.
     * Called once at init and at the start of each turn.
     */
    private selectStrategy(): GameStrategy {
        const allyCount = this.aliveAllies.length;
        const enemyCount = this.aliveEnemies.length;
        const hasCoverOnMap = this.gameMap.obstaclesPercentage >= 10;
        const turnsLeft = 100 - this.turnCount;
        const enemiesHaveBombs = this.aliveEnemies.some((e) => e.splashBombs > 0);
        const alliesAverageWetness = allyCount > 0
            ? this.aliveAllies.reduce((sum, a) => sum + a.wetness, 0) / allyCount
            : 0;
        // === VERROU: hold a point lead near end of game ===
        if (this.scoreAdvantage >= 300 && turnsLeft <= 30)
            return GameStrategy.VERROU;

        // === REPLI: numerical disadvantage or allies badly hurt ===
        if (allyCount < enemyCount || alliesAverageWetness >= 60)
            return GameStrategy.REPLI;

        // === FOCUS: numerical advantage — finish exposed targets, not a blind rush ===
        if (allyCount > enemyCount)
            return GameStrategy.FOCUS;

        // === BAIT: enemies have bombs and there is cover to exploit ===
        if (enemiesHaveBombs && hasCoverOnMap)
            return GameStrategy.BAIT;

        // === TENAILLE: enemies are behind cover ===
        if (hasCoverOnMap && this.aliveEnemies.every((e) =>
            this.gameMap.isInCover(e.coordinates)
        ))
            return GameStrategy.TENAILLE;

        // === ETAU: default — core + flank (not symmetric double flank) ===
        return GameStrategy.ETAU;
    }

    /**
     * Assign agent behaviors according to the active strategy.
     * Called whenever the strategy changes.
     */
    private assignBehaviorsForStrategy(strategy: GameStrategy): void {
        const allies = this.aliveAllies;
        if (!allies.length) return;

        switch (strategy) {
            case GameStrategy.ETAU: {
                // Core group holds threat; one flanker per side max — avoid symmetric split
                const sorted = [...allies].sort((a, b) => a.coordinates.y - b.coordinates.y);
                const flankCount = Math.min(2, Math.floor(sorted.length / 2));
                sorted.forEach((ally, i) => {
                    if (i < flankCount || i >= sorted.length - flankCount) {
                        ally.behavior = AgentBehavior.FLANK;
                    } else {
                        ally.behavior = AgentBehavior.OVERWATCH;
                    }
                });
                break;
            }
            case GameStrategy.FOCUS: {
                // Focus fire: strongest engage, others overwatch from cover
                const primary = this.allyWithHighestStats;
                allies.forEach((a) => {
                    if (a.behavior === AgentBehavior.RETREAT) return;
                    a.behavior = a.agentId === primary.agentId
                        ? AgentBehavior.ATTACK
                        : AgentBehavior.OVERWATCH;
                });
                break;
            }

            case GameStrategy.VERROU:
                // Zone control in cover — still threaten, not passive
                allies.forEach((a) => {
                    if (a.behavior !== AgentBehavior.RETREAT) a.behavior = AgentBehavior.HOLD_COVER;
                });
                break;

            case GameStrategy.BAIT: {
                // Weakest ally baits, others hold cover and overwatch
                const bait = this.allyWithLowestStats;
                allies.forEach((a) => {
                    if (a.behavior === AgentBehavior.RETREAT) return;
                    a.behavior = a.agentId === bait.agentId
                        ? AgentBehavior.ATTACK
                        : AgentBehavior.HOLD_COVER;
                });
                break;
            }

            case GameStrategy.TENAILLE: {
                // Best ally pins frontally, others flank
                const pin = this.allyWithHighestStats;
                allies.forEach((a) => {
                    if (a.behavior === AgentBehavior.RETREAT) return;
                    a.behavior = a.agentId === pin.agentId
                        ? AgentBehavior.PIN
                        : AgentBehavior.FLANK;
                });
                break;
            }

            case GameStrategy.REPLI:
                // Everyone retreats or holds at max range
                allies.forEach((a) => { a.behavior = AgentBehavior.RETREAT; });
                break;
        }
    }

    /** Detect enemy flankers threatening our backline and assign PEEL if needed */
    private assignPeelIfNeeded(): void {
        const allies = this.aliveAllies.filter((a) => a.behavior !== AgentBehavior.RETREAT);
        if (allies.length < 2) return;

        const centerY = this.gameMap.getAveragePosition(allies.map((a) => a.coordinates)).y;
        const backlineAllies = allies.filter((a) => a.behavior === AgentBehavior.HOLD_COVER || a.behavior === AgentBehavior.OVERWATCH);

        for (const enemy of this.aliveEnemies) {
            const isFlankingUs = Math.abs(enemy.coordinates.y - centerY) > this.gameMap.height * 0.35;
            if (!isFlankingUs) continue;

            const threatenedAlly = backlineAllies.find((ally) =>
                this.gameMap.getManhattanDistance(ally.coordinates, enemy.coordinates) <= enemy.metaData.optimalRange * 2
            );
            if (!threatenedAlly) continue;

            // Assign nearest healthy ally to peel
            const peeler = [...allies]
                .filter((a) => a.behavior !== AgentBehavior.PIN && a.agentId !== threatenedAlly.agentId)
                .sort((a, b) => {
                    const distA = this.gameMap.getManhattanDistance(a.coordinates, enemy.coordinates);
                    const distB = this.gameMap.getManhattanDistance(b.coordinates, enemy.coordinates);
                    return distA - distB;
                })[0];

            if (peeler && peeler.wetness < 50) {
                peeler.behavior = AgentBehavior.PEEL;
            }
        }
    }

    private behaviorsAssigned = false;

    private upsertAgent(agentProps: AgentProps): void {
        const existingAgent = this.aliveAgents.find(
            (agent) => agent.agentId === agentProps.agentId
        );
        if (existingAgent) return existingAgent.update(agentProps);
        this.aliveAgents.push(new Agent(agentProps));
    }

    public readTurn() {
        const aliveAgentsCount: number = parseInt(readline()); // Total number of agents still in the game
        const aliveAgentIdsThisTurn = new Set<number>();
    
        for (let i = 0; i < aliveAgentsCount; i++) {
            var inputs: string[] = readline().split(' ');
            const agentId: number = parseInt(inputs[0]);
            aliveAgentIdsThisTurn.add(agentId);
            const x: number = parseInt(inputs[1]);
            const y: number = parseInt(inputs[2]);
            const cooldown: number = parseInt(inputs[3]); // Number of turns before this agent can shoot
            const splashBombs: number = parseInt(inputs[4]);
            const wetness: number = parseInt(inputs[5]); // Damage (0-100) this agent has taken

            const metaData = this.allAgentsData.get(agentId); // Bind agent metadata
            if (!metaData) throw new Error(`Unknown agent ${agentId}`);

            this.upsertAgent({ agentId, coordinates: { x, y }, cooldown, splashBombs, wetness, metaData });
        }
        const _myAgentCount: number = parseInt(readline()); // Number of alive agents controlled by you

        // Remove eliminated agents
        this.aliveAgents = this.aliveAgents.filter(({ agentId }) => aliveAgentIdsThisTurn.has(agentId));

        // Assign behaviors on first turn once all agents are known
        if (!this.behaviorsAssigned) {
            this.assignBehaviorsForStrategy(this.currentStrategy);
            this.behaviorsAssigned = true;
        }
    }

    public playTurn() {
        this.turnCount++;

        // === UPDATE SCORE ADVANTAGE (Voronoi approximation) ===
        this.scoreAdvantage = this.gameMap.computeVoronoiDelta(this.aliveAllies, this.aliveEnemies);

        // === INDIVIDUAL RETREAT / RECOVERY TRANSITIONS ===
        const retreatThreshold = this.computeRetreatThreshold();
        this.aliveAllies.forEach((ally) => {
            if (ally.wetness >= retreatThreshold && ally.behavior !== AgentBehavior.RETREAT) {
                ally.behavior = AgentBehavior.RETREAT;
            } else if (ally.behavior === AgentBehavior.RETREAT && ally.wetness < retreatThreshold * 0.6) {
                // Recovered enough — re-integrate into current strategy
                ally.behavior = AgentBehavior.HOLD_COVER;
            }
        });

        // === GLOBAL STRATEGY TRANSITION ===
        const newStrategy = this.selectStrategy();
        if (newStrategy !== this.currentStrategy) {
            console.error(`Strategy: ${this.currentStrategy} → ${newStrategy}`);
            this.currentStrategy = newStrategy;
            this.assignBehaviorsForStrategy(newStrategy);
        }

        // === PEEL: react to enemy flanks before acting ===
        this.assignPeelIfNeeded();

        // === BAIT: ensure there is always at least one attacker ===
        if (this.currentStrategy === GameStrategy.BAIT) {
            const hasAttacker = this.aliveAllies.some((a) => a.behavior === AgentBehavior.ATTACK);
            if (!hasAttacker) {
                const nextBait = [...this.aliveAllies]
                    .filter((a) => a.behavior !== AgentBehavior.RETREAT)
                    .sort((a, b) => a.wetness - b.wetness)[0];
                if (nextBait) nextBait.behavior = AgentBehavior.ATTACK;
            }
        }

        // === PROCESS ALLIES IN PRIORITY ORDER ===
        // Higher priority allies pick their position first, preventing lower priority
        // ones from choosing the same tile and causing mutual movement cancellation.
        // Priority: low wetness > high soakingPower > high optimalRange
        const sortedAllies = [...this.aliveAllies].sort((a, b) => {
            const wetnessDiff = a.wetness - b.wetness; // Healthier acts first
            if (wetnessDiff !== 0) return wetnessDiff;
            const soakingDiff = b.metaData.soakingPower - a.metaData.soakingPower; // More powerful acts first
            if (soakingDiff !== 0) return soakingDiff;
            return b.metaData.optimalRange - a.metaData.optimalRange;
        });

        const claimedPositions: Coordinates[] = [];

        sortedAllies.forEach((ally) => {
            const chosenPosition = ally.decideActions({
                allies: this.aliveAllies,
                enemies: this.aliveEnemies,
                gameMap: this.gameMap,
                strategy: this.currentStrategy,
                claimedPositions,
            });
            // Register the chosen destination so subsequent allies avoid it
            claimedPositions.push(chosenPosition);
        });
    }

    private computeRetreatThreshold(): number {
        if (!this.aliveEnemies.length) return 75;
        const maxEnemySoaking = Math.max(...this.aliveEnemies.map((e) => e.metaData.soakingPower));
        return Math.min(75, Math.max(40, 100 - maxEnemySoaking * 2));
    }
}

class GameMap {
    constructor() {
        var inputs: string[] = readline().split(' ');
        this.width = parseInt(inputs[0]); // Width of the game map
        this.height = parseInt(inputs[1]); // Height of the game map

        for (let i = 0; i < this.height; i++) {
            var inputs: string[] = readline().split(' ');
            for (let j = 0; j < this.width; j++) {
                const x: number = parseInt(inputs[3 * j]);// X coordinate, 0 is left edge
                const y: number = parseInt(inputs[3 * j + 1]);// Y coordinate, 0 is top edge
                const tileType: number = parseInt(inputs[3 * j + 2]);
                this.grid.set(this.getCoordinatesKey({ x, y }), {
                    x, y, tileType
                });
            }
        }

        this.buildCoverMap();
    }

    // =============================================================================
    // GEOMETRY
    // =============================================================================
    readonly width: number;
    readonly height: number;
    private readonly grid: GameMapGrid = new Map();

    private getCoordinatesKey = ({ x, y }: Coordinates): string => `${x}, ${y}`;

    private getTileAt = (coordinates: Coordinates): GameMapGridTile | undefined => this.grid.get(
        this.getCoordinatesKey(coordinates)
    );

    private getAdjacentTilesOf ({ x, y }: Coordinates): { tile: GameMapGridTile; direction: Direction }[] {
        const adjacent: { tile: GameMapGridTile | undefined; direction: Direction }[] = [
            { tile: this.getTileAt({ x: x - 1, y }), direction: Direction.LEFT },
            { tile: this.getTileAt({ x: x + 1, y }), direction: Direction.RIGHT },
            { tile: this.getTileAt({ x, y: y - 1 }), direction: Direction.TOP },
            { tile: this.getTileAt({ x, y: y + 1 }), direction: Direction.BOTTOM },
        ].filter(({ tile }) => Boolean(tile)); // getTileAt returns undefined when tile is out of bounds
        return adjacent;
    }

    public isSamePosition (posA: Coordinates, posB: Coordinates): boolean {
        return posA.x === posB.x && posA.y === posB.y;
    }

    public isInCover(position: Coordinates): boolean {
        return this.covers.some((cover) => this.isSamePosition(cover.tile, position));
    }

    /** True when agent is orthogonally adjacent to any obstacle tile */
    public isAdjacentToCover(position: Coordinates): boolean {
        return this.getAdjacentTilesOf(position).some(({ tile }) => tile.tileType !== TileType.EMPTY);
    }

    public getFurthestAvailablePosition({
        oppositeOf,
        occupiedPositions
    }: {
        oppositeOf: Coordinates;
        occupiedPositions: Coordinates[];
    }): Coordinates {
        return [...this.grid.values()]
            .filter((tile) =>
                tile.tileType === TileType.EMPTY
                && !occupiedPositions.some((position) => this.isSamePosition(position, tile))
            )
            .map((tile) => ({
                tile,
                distance: this.getManhattanDistance(oppositeOf, tile)
            }))
            .sort((a, b) => b.distance - a.distance)
            [0]?.tile;
    }

    public getManhattanDistance(a: Coordinates, b: Coordinates): number {
        return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    }

    private getChebyshevDistance(a: Coordinates, b: Coordinates): number {
        return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    }

    private getTilesWithinChebyshevDistance({
        origin,
        distance
    }: {
        origin: Coordinates,
        distance: number
    }): GameMapGridTile[] {
        return [...this.grid.values()].filter((tile) => 
            this.getChebyshevDistance(origin, tile) <= distance
        );
    }

    public getNextMoveToTargetFrom({
        origin,
        target,
        occupiedPositions
    }: {
        origin: Coordinates;
        target: Coordinates;
        occupiedPositions: Coordinates[];
    }): Coordinates {
        if (this.isSamePosition(origin, target)) return origin;

        const isWalkable = (position: Coordinates): boolean => {
            if (this.isSamePosition(position, target)) return true; // Always available even if occupied
            const tile = this.getTileAt(position);
            return (
                !!tile &&
                tile.tileType === TileType.EMPTY &&
                !occupiedPositions.some((occ) => this.isSamePosition(occ, position))
            );
        };

        const key = ({ x, y }: Coordinates) => `${x},${y}`;

        const queue: Coordinates[] = [origin];
        const visited = new Set<string>([key(origin)]);
        const cameFrom = new Map<string, Coordinates>();

        while (queue.length > 0) {
            const current = queue.shift()!;

            if (this.isSamePosition(current, target)) {
                // Go back to first step from origin
                let step = current;
                let prev = cameFrom.get(key(step));
                while (prev && !this.isSamePosition(prev, origin)) {
                    step = prev;
                    prev = cameFrom.get(key(step));
                }
                return step;
            }

            const neighbors: Coordinates[] = [
                { x: current.x - 1, y: current.y },
                { x: current.x + 1, y: current.y },
                { x: current.x,     y: current.y - 1 },
                { x: current.x,     y: current.y + 1 },
            ];

            for (const neighbor of neighbors) {
                const k = key(neighbor);
                if (!visited.has(k) && isWalkable(neighbor)) {
                    visited.add(k);
                    cameFrom.set(k, current);
                    queue.push(neighbor);
                }
            }
        }

        return origin; // No path found => stay there
    }

    public getAveragePosition(positions: Coordinates[]): Coordinates {
        const sum = positions.reduce<Coordinates>(
            (sum, position) => ({ x: sum.x + position.x, y: sum.y + position.y }),
            { x: 0, y: 0 }
        );
        return {
            x: Math.round(sum.x / positions.length),
            y: Math.round(sum.y / positions.length)
        };
    }

    public getCloserAgentTo({
        agents,
        closerTo
    }: {
        agents: Agent[];
        closerTo: Coordinates[];
    }): Agent {
        const closerToPosition = this.getAveragePosition(closerTo);
        return agents
            .map((agent) => ({
                agent,
                distanceFromOrigin: this.getManhattanDistance(agent.coordinates, closerToPosition)
            }))
            .sort((a, b) => a.distanceFromOrigin - b.distanceFromOrigin)[0].agent;
    }

    /**
     * Returns positions evenly distributed along the map's vertical axis.
     * All positions preserve the origin's x coordinate and are spaced from
     * the top to the bottom edge of the map using a "space-between" distribution.
     */
    public getVerticalSpreadPositions({
        origin,
        count
    }: {
        origin: Coordinates;
        count: number;
    }): Coordinates[] {
        if (count <= 0) return [];
        if (count === 1) return [{ x: origin.x, y: Math.floor(this.height / 2) }];

        const step = (this.height - 1) / (count - 1);
        return Array.from(
            { length: count },
            (_, index) => ({ x: origin.x, y: Math.round(index * step) })
        );
    }

    /**
     * Position at optimal range from enemies — core of zone control positioning.
     */
    public getOptimalRangePosition({
        from,
        enemies,
        occupiedPositions,
        preferCover = true,
    }: {
        from: Coordinates;
        enemies: Agent[];
        occupiedPositions: Coordinates[];
        preferCover?: boolean;
    }): Coordinates {
        if (!enemies.length) return from;

        const enemyCenter = this.getAveragePosition(enemies.map((e) => e.coordinates));
        const range = 4; // average optimal range heuristic when multiple agents

        const candidates = [...this.grid.values()]
            .filter((tile) =>
                tile.tileType === TileType.EMPTY &&
                !occupiedPositions.some((p) => this.isSamePosition(p, tile))
            )
            .map((tile) => {
                const distToEnemies = this.getManhattanDistance(tile, enemyCenter);
                const inCover = this.isInCover(tile);
                const adjacentCover = this.isAdjacentToCover(tile);
                const rangeScore = -Math.abs(distToEnemies - range);
                const coverScore = inCover ? 20 : adjacentCover ? 10 : 0;
                const distFromSelf = -this.getManhattanDistance(from, tile) * 0.3;
                return { tile, score: rangeScore + coverScore + distFromSelf };
            })
            .sort((a, b) => b.score - a.score);

        if (preferCover) {
            const coverCandidate = candidates.find((c) => this.isInCover(c.tile));
            if (coverCandidate) return coverCandidate.tile;
        }

        return candidates[0]?.tile ?? from;
    }

    /**
     * Score a tile for tactical positioning — cover, range, LoS break, zone control.
     */
    public scorePosition({
        position,
        agent,
        enemies,
        allies,
    }: {
        position: Coordinates;
        agent: Agent;
        enemies: Agent[];
        allies: Agent[];
    }): number {
        let score = 0;
        const optimalRange = agent.metaData.optimalRange;

        if (this.isInCover(position)) score += 25;
        else if (this.isAdjacentToCover(position)) score += 10;

        for (const enemy of enemies) {
            const dist = this.getManhattanDistance(position, enemy.coordinates);
            const damage = this.estimateEffectiveShotDamage({
                shooter: { ...agent, coordinates: position } as Agent,
                shooterTarget: enemy,
            });

            // Reward being at optimal range with threat
            if (dist <= optimalRange && damage > 0) score += 15;
            else if (dist <= optimalRange * 2 && damage > 0) score += 5;

            // Penalize being in enemy optimal range while exposed
            const enemyDamage = this.estimateEffectiveShotDamage({ shooter: enemy, shooterTarget: { ...agent, coordinates: position } as Agent });
            if (enemyDamage >= 15 && !this.isInCover(position)) score -= 20;
        }

        // Zone control: closer to map center is slightly better
        const centerX = this.width / 2;
        const centerY = this.height / 2;
        score -= (Math.abs(position.x - centerX) + Math.abs(position.y - centerY)) * 0.5;

        return score;
    }

    /**
     * Find best nearby tile for tactical retreat — cover + maintain threat + break LoS.
     */
    public getTacticalRetreatPosition({
        agent,
        enemies,
        occupiedPositions,
        maxDistance = 3,
    }: {
        agent: Agent;
        enemies: Agent[];
        occupiedPositions: Coordinates[];
        maxDistance?: number;
    }): Coordinates {
        const candidates = [...this.grid.values()]
            .filter((tile) =>
                this.getChebyshevDistance(agent.coordinates, tile) <= maxDistance &&
                tile.tileType === TileType.EMPTY &&
                !occupiedPositions.some((p) => this.isSamePosition(p, tile))
            )
            .map((tile) => ({
                tile,
                score: this.scorePosition({ position: tile, agent, enemies, allies: [] }),
            }))
            .sort((a, b) => b.score - a.score);

        return candidates[0]?.tile ?? agent.coordinates;
    }

    /**
     * Flank target that exploits exposed enemies — not just "go to the side".
     */
    public getFlankTarget({
        agent,
        enemies,
        allies,
        flankFromTop,
    }: {
        agent: Agent;
        enemies: Agent[];
        allies: Agent[];
        flankFromTop: boolean;
    }): Coordinates {
        const exposedEnemies = enemies.filter((e) => !this.isInCover(e.coordinates));
        const priorityTargets = exposedEnemies.length ? exposedEnemies : enemies;

        // Target the most exposed / weakest enemy on our flank side
        const flankY = flankFromTop
            ? Math.floor(this.height * 0.15)
            : Math.floor(this.height * 0.85);

        const sortedTargets = [...priorityTargets].sort((a, b) => {
            const exposedDiff = Number(!this.isInCover(a.coordinates)) - Number(!this.isInCover(b.coordinates));
            if (exposedDiff !== 0) return -exposedDiff;
            return b.wetness - a.wetness;
        });

        const targetEnemy = sortedTargets[0];
        if (!targetEnemy) return { x: Math.floor(this.width / 2), y: flankY };

        // Approach from flank side at optimal range, not point-blank
        const approachX = targetEnemy.coordinates.x;
        return { x: approachX, y: flankY };
    }

    /**
     * Compute the Voronoi tile delta: positive = allies control more tiles than enemies.
     * Agents with wetness >= 50 have their effective distance doubled (game rule).
     */
    public computeVoronoiDelta(allies: Agent[], enemies: Agent[]): number {
        let allyTiles = 0;
        let enemyTiles = 0;

        for (const tile of this.grid.values()) {
            if (tile.tileType !== TileType.EMPTY) continue;

            const minAllyDist = allies.length
                ? Math.min(...allies.map((a) => {
                    const d = this.getManhattanDistance(tile, a.coordinates);
                    return a.wetness >= 50 ? d * 2 : d;
                }))
                : Infinity;

            const minEnemyDist = enemies.length
                ? Math.min(...enemies.map((e) => {
                    const d = this.getManhattanDistance(tile, e.coordinates);
                    return e.wetness >= 50 ? d * 2 : d;
                }))
                : Infinity;

            if (minAllyDist < minEnemyDist) allyTiles++;
            else if (minEnemyDist < minAllyDist) enemyTiles++;
        }

        return allyTiles - enemyTiles;
    }

    // =============================================================================
    // COVER SYSTEM
    // =============================================================================
    private covers: Cover[] = [];

    /** Build a map of all existing covers and the total area they protect from */
    private buildCoverMap() {
        const obstacles = [...this.grid.values()].filter((tile) => tile.tileType !== TileType.EMPTY);

        const coverComponents: Cover[] = [];

        obstacles.forEach((obstacleTile) => {
            // Covers are adjacent to obstacles
            const emptyAdjacents = this.getAdjacentTilesOf(obstacleTile)
                .filter(({ tile }) => tile.tileType === TileType.EMPTY);
                
            emptyAdjacents.forEach((adjacent) => {
                coverComponents.push({
                    tile: adjacent.tile,
                    obstacles: [{
                        tile: obstacleTile,
                        coverAt: adjacent.direction,
                        protectedAgainst: this.getProtectedZoneBehindObstacle({
                            obstaclePosition: obstacleTile,
                            coverAt: adjacent.direction
                        })
                    }]
                });
            });
        });

        // Merge cover component duplicates (tiles that gain protection from multiple obstacles)
        const coversMap = coverComponents.reduce<Map<string, Cover>>(
            (covers, cover) => {
                const coordinatesKey = this.getCoordinatesKey(cover.tile);
                const duplicate = covers.get(coordinatesKey);
                if (!duplicate) {
                    covers.set(coordinatesKey, cover);
                    return covers;
                }
                covers.set(coordinatesKey, {
                    tile: cover.tile,
                    obstacles: [...duplicate.obstacles, ...cover.obstacles]
                });
                return covers;
            },
            new Map()
        );

        this.covers = [...coversMap.values()];
    }

    public get obstaclesPercentage(): number {
        const obstaclesCount = [...this.grid.values()].filter((tile) => tile.tileType !== TileType.EMPTY).length;
        return obstaclesCount / [...this.grid.values()].length * 100;
    }

    public getIdealCoverNearby({
        ally,
        occupiedPositions,
        enemies,
        maxDistance
    }: {
        ally: Agent;
        occupiedPositions: Coordinates[];
        enemies: Agent[];
        maxDistance: number
    }): Coordinates {
        const moveCandidates = [...this.grid.values()]
            .filter((tile) => this.getChebyshevDistance(ally.coordinates, tile) <= maxDistance)
            .filter((moveCandidate) => (
                !occupiedPositions.some((occupiedPosition) =>
                    this.isSamePosition(moveCandidate, occupiedPosition)
                )
                && moveCandidate.tileType === TileType.EMPTY
            ));

        return moveCandidates
            .map((moveCandidate) => ({
                moveCandidate,
                ...this.getBlockedEnemiesCountAt({ position: moveCandidate, enemies }),
                positionScore: this.scorePosition({
                    position: moveCandidate,
                    agent: ally,
                    enemies,
                    allies: [],
                }),
            }))
            .sort((a, b) => {
                const protectionDiff = (b.protectionType ?? TileType.EMPTY) - (a.protectionType ?? TileType.EMPTY);
                if (protectionDiff !== 0) return protectionDiff;
                const scoreDiff = b.positionScore - a.positionScore;
                if (scoreDiff !== 0) return scoreDiff;
                return (b.blockedEnemiesCount ?? 0) - (a.blockedEnemiesCount ?? 0);
            })
            [0]?.moveCandidate ?? ally.coordinates;
    }

    private getCoverTotalProtectionZone(cover: Cover): ProtectionZone {
        if (cover.obstacles.length === 1) return {
            zone: cover.obstacles[0].protectedAgainst,
            protectionType: cover.obstacles[0].tile.tileType
        };

        const mergedProtectionZonesMap = cover.obstacles.reduce<Map<string, Coordinates>>(
            (positionsMap, coverObstacle) => {
                coverObstacle.protectedAgainst.forEach((position) => {
                    positionsMap.set(this.getCoordinatesKey(position), position);
                });
                return positionsMap;
            }, 
            new Map()
        );

        const protectionType: TileType = cover.obstacles.reduce(
            (highest, obstacle) => Math.max(highest, obstacle.tile.tileType),
            TileType.EMPTY
        );

        return { zone: [...mergedProtectionZonesMap.values()], protectionType };
    }

    private getBlockedEnemiesCountAt({
        position,
        enemies
    }: {
        position: Coordinates;
        enemies: Agent[];
    }): { blockedEnemiesCount: number; protectionType: TileType } {
        const cover = this.covers.find((cover) => this.isSamePosition(cover.tile, position));
        if (!cover) return { blockedEnemiesCount: 0, protectionType: TileType.EMPTY };

        const protectionZone = this.getCoverTotalProtectionZone(cover);
        return {
            blockedEnemiesCount: protectionZone.zone.reduce<number>(
                (count, position) => {
                    if (enemies.some((enemy) => this.isSamePosition(enemy.coordinates, position)))
                        count++;
                    return count;
                }, 0
            ),
            protectionType: protectionZone.protectionType
        };
    }

    private getProtectedZoneBehindObstacle({
        obstaclePosition,
        coverAt
    }: {
        obstaclePosition: Coordinates;
        coverAt: Direction;
    }): GameMapGridTile[] {
        const tilesBeyondObstacle = [...this.grid.values()].filter((tile) => {
            switch (coverAt) {
                case Direction.TOP:    return tile.y > obstaclePosition.y;
                case Direction.RIGHT:  return tile.x < obstaclePosition.x;
                case Direction.BOTTOM: return tile.y < obstaclePosition.y;
                case Direction.LEFT:   return tile.x > obstaclePosition.x;
            }
        });

        const obstacleNeighbors = this.getTilesWithinChebyshevDistance({ origin: obstaclePosition, distance: 1 });

        return tilesBeyondObstacle.filter((tileBeyondObstacle) => 
            !obstacleNeighbors.some((obstacleNeighbor) => this.isSamePosition(tileBeyondObstacle, obstacleNeighbor))
        );
    }

    // =============================================================================
    // SHOOTING
    // =============================================================================
    private calculateProtectionTypeAgainstShooter({ shooter, shooterTarget }: { shooter: Agent; shooterTarget: Agent; }): TileType {
        const targetCover = this.covers.find((cover) => this.isSamePosition(cover.tile, shooterTarget.coordinates));
        if (!targetCover) return TileType.EMPTY;

        const targetProtectionZone = this.getCoverTotalProtectionZone(targetCover);
        return targetProtectionZone.zone.some((tile) => this.isSamePosition(shooter.coordinates, tile))
            ? targetProtectionZone.protectionType
            : TileType.EMPTY;
    }

    /** N.B.: the enemy can still hunker down, which seems to be unpredictable */
    public estimateEffectiveShotDamage({ shooter, shooterTarget }: { shooter: Agent; shooterTarget: Agent; }): number {
        const distanceFromShooter = this.getManhattanDistance(shooterTarget.coordinates, shooter.coordinates);
        const baseDamage = (() => {
            if (distanceFromShooter <= shooter.metaData.optimalRange) return shooter.metaData.soakingPower;
            if (distanceFromShooter <= shooter.metaData.optimalRange * 2) return shooter.metaData.soakingPower / 2;
            return 0;
        })();

        const targetCover = this.calculateProtectionTypeAgainstShooter({ shooter, shooterTarget });
        switch (targetCover) {
            case TileType.HIGH_COVER: return baseDamage * 3 / 4;
            case TileType.LOW_COVER:  return baseDamage / 2;
            default:                  return baseDamage;
        }
    }

    public canTargetBeKilledNow({ effectiveDamage, wetness }: { effectiveDamage: number; wetness: number; }): boolean {
        return wetness + effectiveDamage >= 100;
    }

    /** Score an enemy as a shoot target — finishers, exposed, zone-impact, cooldown */
    public scoreShootTarget({ shooter, enemy }: { shooter: Agent; enemy: Agent; }): number {
        const dist = this.getManhattanDistance(shooter.coordinates, enemy.coordinates);
        if (dist > shooter.metaData.optimalRange * 2) return -Infinity;

        const effectiveDamage = this.estimateEffectiveShotDamage({ shooter, shooterTarget: enemy });
        if (effectiveDamage <= 0) return -Infinity;

        let score = effectiveDamage;

        // Finisher priority
        if (this.canTargetBeKilledNow({ effectiveDamage, wetness: enemy.wetness })) score += 100;

        // Exposed targets (no cover protection from our angle)
        if (!this.isInCover(enemy.coordinates)) score += 20;
        else if (this.calculateProtectionTypeAgainstShooter({ shooter, shooterTarget: enemy }) === TileType.EMPTY) {
            score += 15; // In cover tile but no protection from us
        }

        // Wetness >= 50 doubles their distance for zone scoring — high value
        if (enemy.wetness >= 50) score += 10;

        // Enemy on cooldown can't shoot back this turn
        if (enemy.cooldown > 0) score += 8;

        // Prefer targets already damaged (focus fire)
        score += enemy.wetness * 0.3;

        // Full damage at optimal range beats half damage
        if (dist <= shooter.metaData.optimalRange) score += 5;

        return score;
    }

    /** Find the best enemy to shoot — tactical target selection */
    public getIdealShootTarget({ enemies, shooter }: { enemies: Agent[]; shooter: Agent; }): Agent {
        return enemies
            .map((enemy) => ({
                enemy,
                score: this.scoreShootTarget({ shooter, enemy }),
            }))
            .filter(({ score }) => score > -Infinity)
            .sort((a, b) => b.score - a.score)
            [0]?.enemy;
    }

    // =============================================================================
    // SPLASH BOMBS
    // =============================================================================
    private getSplashZone(origin: Coordinates): Coordinates[] {
        return this.getTilesWithinChebyshevDistance({ origin, distance: 1 });
    }

    private isBombTargetInReach({ throwerPosition, targetPosition }: { throwerPosition: Coordinates; targetPosition: Coordinates; }): boolean {
        return this.getManhattanDistance(throwerPosition, targetPosition) <= 4;
    }

    public getIdealBombTarget({
        thrower,
        allies,
        enemies,
        maxTouchedAllies,
        minTouchedEnemies
    }: {
        thrower: Agent;
        allies: Agent[];
        enemies: Agent[];
        maxTouchedAllies: number;
        minTouchedEnemies: number;
    }): Coordinates | undefined {
        const targetsInReach = [...this.grid.values()]
            .filter((targetPosition) => this.isBombTargetInReach({ throwerPosition: thrower.coordinates, targetPosition }));
            
        return targetsInReach
            .map((target) => {
                const splashZone = this.getSplashZone(target);

                // Count allies and enemies in splash zone
                let touchedAllies: Agent[] = [];
                let touchedEnemies: Agent[] = [];
                splashZone.forEach((tile) => {
                    allies.forEach((ally) => this.isSamePosition(ally.coordinates, tile) && touchedAllies.push(ally));
                    enemies.forEach((enemy) => this.isSamePosition(enemy.coordinates, tile) && touchedEnemies.push(enemy));
                });

                // Do not waste a bomb on a single enemy that can already be killed by a shot
                const willWasteBomb =
                    touchedEnemies.length === 1 &&
                    thrower.cooldown === 0 &&
                    this.canTargetBeKilledNow({
                        effectiveDamage: this.estimateEffectiveShotDamage({ shooter: thrower, shooterTarget: touchedEnemies[0] }),
                        wetness: touchedEnemies[0].wetness
                    });

                return {
                    target,
                    touchedAlliesCount: touchedAllies.length,
                    touchedEnemiesCount: touchedEnemies.length,
                    killableEnemiesCount: touchedEnemies.filter((e) => e.wetness >= 70).length,
                    willWasteBomb
                };
            })
            .filter(({ touchedAlliesCount, touchedEnemiesCount, willWasteBomb }) =>
                touchedAlliesCount <= maxTouchedAllies &&
                touchedEnemiesCount >= minTouchedEnemies &&
                !willWasteBomb
            )
            .sort((a, b) => {
                const touchedDiff = b.touchedEnemiesCount - a.touchedEnemiesCount;
                if (touchedDiff !== 0) return touchedDiff;
                const killDiff = b.killableEnemiesCount - a.killableEnemiesCount;
                if (killDiff !== 0) return killDiff;
                return a.touchedAlliesCount - b.touchedAlliesCount;
            })
            [0]?.target;
    }
}

class Agent {
    agentId: number;
    coordinates: Coordinates;
    cooldown: number;
    splashBombs: number;
    wetness: number;
    metaData: AgentMetaData;
    
    public actionService: AgentActionService;
    public behavior: AgentBehavior = AgentBehavior.ATTACK;

    constructor(props: AgentProps) {
        Object.assign(this, props);
        this.actionService = new AgentActionService(props.agentId);
    }

    public update(props: AgentProps) {
        Object.assign(this, props);
    }

    public decideActions({
        gameMap,
        allies,
        enemies,
        strategy,
        claimedPositions,
    }: {
        gameMap: GameMap;
        allies: Agent[];
        enemies: Agent[];
        strategy: GameStrategy;
        claimedPositions: Coordinates[]; // Positions already chosen by allies processed earlier this turn
    }): Coordinates /* returns the chosen nextMove so the caller can register it */ {
        const canShoot = this.cooldown === 0;
        const hasBombs = this.splashBombs > 0;
        let nextMove = this.coordinates;

        const averageEnemiesPosition = gameMap.getAveragePosition(enemies.map((e) => e.coordinates));
        // Blocked positions: enemies (walls) + ally destinations already registered this turn
        const occupiedByEnemies = enemies.map((e) => e.coordinates);
        const blockedThisTurn = [...occupiedByEnemies, ...claimedPositions];
        const allyOccupied = [...allies.filter((a) => a.agentId !== this.agentId).map((a) => a.coordinates), ...claimedPositions];

        // Assign a unique vertical slot among allies with the same behavior
        const getSpreadTarget = (origin: Coordinates, group: Agent[]): Coordinates => {
            const slots = gameMap.getVerticalSpreadPositions({ origin, count: Math.max(group.length, 1) });
            const myIndex = group.findIndex((a) => a.agentId === this.agentId);
            return slots[myIndex] ?? slots[0];
        };

        switch (this.behavior) {
            case AgentBehavior.ATTACK: {
                // === Tactical engage: move toward best shoot target, not blindly toward center ===
                this.actionService.message(`${strategy} | ATTACK`);
                const shootTarget = gameMap.getIdealShootTarget({ shooter: this, enemies });
                const engageTarget = shootTarget
                    ? shootTarget.coordinates
                    : getSpreadTarget(averageEnemiesPosition, allies.filter((a) => a.behavior === AgentBehavior.ATTACK));

                // Prefer cover along the approach if wetness is rising
                if (this.wetness >= 30) {
                    const coverApproach = gameMap.getIdealCoverNearby({
                        ally: this,
                        enemies,
                        occupiedPositions: allyOccupied,
                        maxDistance: 2,
                    });
                    nextMove = gameMap.getNextMoveToTargetFrom({
                        target: coverApproach,
                        origin: this.coordinates,
                        occupiedPositions: blockedThisTurn,
                    });
                } else {
                    nextMove = gameMap.getNextMoveToTargetFrom({
                        target: engageTarget,
                        origin: this.coordinates,
                        occupiedPositions: blockedThisTurn,
                    });
                }
                break;
            }

            case AgentBehavior.HOLD_COVER: {
                // === Hold cover, deny area, overwatch — zone control without over-committing ===
                this.actionService.message(`${strategy} | HOLD`);
                const coverTarget = gameMap.getIdealCoverNearby({
                    ally: this,
                    enemies,
                    occupiedPositions: allyOccupied,
                    maxDistance: 2,
                });
                const overwatchTarget = gameMap.getOptimalRangePosition({
                    from: this.coordinates,
                    enemies,
                    occupiedPositions: allyOccupied,
                    preferCover: true,
                });

                const target = gameMap.isInCover(this.coordinates)
                    ? (gameMap.scorePosition({ position: coverTarget, agent: this, enemies, allies }) >
                       gameMap.scorePosition({ position: this.coordinates, agent: this, enemies, allies })
                        ? coverTarget : this.coordinates)
                    : (coverTarget ?? overwatchTarget);

                nextMove = gameMap.getNextMoveToTargetFrom({
                    target,
                    origin: this.coordinates,
                    occupiedPositions: blockedThisTurn,
                });
                break;
            }

            case AgentBehavior.OVERWATCH: {
                // === Zone control at optimal range — threaten without committing ===
                this.actionService.message(`${strategy} | OW`);
                const overwatchTarget = gameMap.getOptimalRangePosition({
                    from: this.coordinates,
                    enemies,
                    occupiedPositions: allyOccupied,
                    preferCover: true,
                });

                nextMove = gameMap.getNextMoveToTargetFrom({
                    target: overwatchTarget,
                    origin: this.coordinates,
                    occupiedPositions: blockedThisTurn,
                });
                break;
            }

            case AgentBehavior.FLANK: {
                // === Flank exposed enemies — cover chain + optimal range awareness ===
                this.actionService.message(`${strategy} | FLANK`);
                const flankers = allies.filter((a) => a.behavior === AgentBehavior.FLANK);
                const myFlankerIndex = flankers.findIndex((a) => a.agentId === this.agentId);
                const flankFromTop = myFlankerIndex < Math.ceil(flankers.length / 2);

                const flankTarget = gameMap.getFlankTarget({
                    agent: this,
                    enemies,
                    allies,
                    flankFromTop,
                });

                // Step through cover when possible during flank approach
                const coverOnPath = gameMap.getIdealCoverNearby({
                    ally: this,
                    enemies,
                    occupiedPositions: allyOccupied,
                    maxDistance: 2,
                });

                const target = this.wetness >= 40 && gameMap.isInCover(coverOnPath)
                    ? coverOnPath
                    : flankTarget;

                nextMove = gameMap.getNextMoveToTargetFrom({
                    target,
                    origin: this.coordinates,
                    occupiedPositions: blockedThisTurn,
                });
                break;
            }

            case AgentBehavior.PIN: {
                // === Frontally pin enemies — only effective when flankers are active ===
                this.actionService.message(`${strategy} | PIN`);
                const hasFlankers = allies.some((a) => a.behavior === AgentBehavior.FLANK);
                const pinTarget = hasFlankers
                    ? averageEnemiesPosition
                    : gameMap.getOptimalRangePosition({
                        from: this.coordinates,
                        enemies,
                        occupiedPositions: allyOccupied,
                        preferCover: true,
                    });

                nextMove = gameMap.getNextMoveToTargetFrom({
                    target: pinTarget,
                    origin: this.coordinates,
                    occupiedPositions: blockedThisTurn,
                });
                break;
            }

            case AgentBehavior.PEEL: {
                // === Intercept flanker threatening our backline ===
                this.actionService.message(`${strategy} | PEEL`);
                const centerY = gameMap.getAveragePosition(allies.map((a) => a.coordinates)).y;
                const flanker = [...enemies]
                    .filter((e) => Math.abs(e.coordinates.y - centerY) > gameMap.height * 0.35)
                    .sort((a, b) =>
                        gameMap.getManhattanDistance(a.coordinates, this.coordinates) -
                        gameMap.getManhattanDistance(b.coordinates, this.coordinates)
                    )[0];

                const peelTarget = flanker
                    ? flanker.coordinates
                    : gameMap.getOptimalRangePosition({
                        from: this.coordinates,
                        enemies,
                        occupiedPositions: allyOccupied,
                    });

                nextMove = gameMap.getNextMoveToTargetFrom({
                    target: peelTarget,
                    origin: this.coordinates,
                    occupiedPositions: blockedThisTurn,
                });
                break;
            }

            case AgentBehavior.RETREAT: {
                // === Tactical retreat: cover + threat range + break LoS — not map edge flee ===
                this.actionService.message(`${strategy} | RETREAT`);
                const retreatTarget = gameMap.getTacticalRetreatPosition({
                    agent: this,
                    enemies,
                    occupiedPositions: allyOccupied,
                    maxDistance: 3,
                });
                nextMove = gameMap.getNextMoveToTargetFrom({
                    target: retreatTarget,
                    origin: this.coordinates,
                    occupiedPositions: occupiedByEnemies,
                });
                break;
            }
        }

        this.actionService.move({ currentPosition: this.coordinates, targetPosition: nextMove });

        // === Battle action ===
        const isAggressive = this.behavior === AgentBehavior.ATTACK ||
            this.behavior === AgentBehavior.PIN ||
            this.behavior === AgentBehavior.PEEL;
        const minEnemiesForBomb = isAggressive ? 1 : 2;
        const bombTarget = hasBombs ? gameMap.getIdealBombTarget({
            thrower: this,
            allies,
            enemies,
            maxTouchedAllies: 0,
            minTouchedEnemies: minEnemiesForBomb
        }) : undefined;

        if (hasBombs && bombTarget) {
            this.actionService.throw(bombTarget);
        } else if (canShoot) {
            const shootTarget = gameMap.getIdealShootTarget({ shooter: this, enemies });
            if (shootTarget) this.actionService.shoot(shootTarget.agentId);
            else this.actionService.hunkerDown();
        } else {
            this.actionService.hunkerDown();
        }

        this.actionService.executeActions();
        return nextMove; // Allow caller to register this position as claimed
    }
}

class AgentActionService {
    private readonly ACTION_TYPES: Record<AgentActionName, AgentAction['type']> = {
        [AgentActionName.MOVE]:        { name: AgentActionName.MOVE,        isBattleAction: false },
        [AgentActionName.MESSAGE]:     { name: AgentActionName.MESSAGE,     isBattleAction: false },
        [AgentActionName.HUNKER_DOWN]: { name: AgentActionName.HUNKER_DOWN, isBattleAction: true  },
        [AgentActionName.SHOOT]:       { name: AgentActionName.SHOOT,       isBattleAction: true  },
        [AgentActionName.THROW]:       { name: AgentActionName.THROW,       isBattleAction: true  }
    };
    private readonly actions: AgentAction[] = [];

    public get isAgentInMovement(): boolean {
        return Boolean(this.actions.find((action) => action.type.name === AgentActionName.MOVE));
    }

    constructor(private agentId: number) {}

    public move = ({ currentPosition, targetPosition }: { currentPosition: Coordinates; targetPosition: Coordinates; }) => {
        if (targetPosition.x === currentPosition.x && targetPosition.y === currentPosition.y) return this;
        this.actions.push({ type: this.ACTION_TYPES.MOVE, payload: `${targetPosition.x} ${targetPosition.y}` });
        return this;
    }

    public shoot = (id: number) => {
        this.actions.push({ type: this.ACTION_TYPES.SHOOT, payload: id.toString() });
        return this;
    }

    public throw = ({ x, y }: Coordinates) => {
        this.actions.push({ type: this.ACTION_TYPES.THROW, payload: `${x} ${y}` });
        return this;
    }

    public hunkerDown = () => {
        this.actions.push({ type: this.ACTION_TYPES.HUNKER_DOWN });
        return this;
    }

    public message = (text: string) => {
        this.actions.push({ type: this.ACTION_TYPES.MESSAGE, payload: text });
        return this;
    }

    public executeActions = () => {
        const moveAction   = [...this.actions].reverse().find((a) => a.type.name === AgentActionName.MOVE);
        const battleAction = [...this.actions].reverse().find((a) => a.type.isBattleAction);
        const messages     = this.actions.filter((a) => a.type.name === AgentActionName.MESSAGE);

        const filteredActions = [moveAction, battleAction, ...messages].filter(Boolean);

        if (!filteredActions.length) {
            console.log(`${this.agentId};HUNKER_DOWN`);
            return;
        }

        console.log(
            [this.agentId, ...filteredActions.map((action) =>
                [action?.type.name, action?.payload].filter(Boolean).join(' ')
            )].join(';')
        );

        this.actions.length = 0;
    }
}

const game = new Game();

// game loop
while (true) {
    game.readTurn();
    game.playTurn();
}
