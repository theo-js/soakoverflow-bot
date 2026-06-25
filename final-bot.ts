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
    /** Hold cover, deny area, overwatch at optimal range */
    HOLD_COVER = 'HOLD_COVER',
    /** Zone control at optimal range without over-committing */
    OVERWATCH = 'OVERWATCH',
    /** Tactical retreat: cover + threat range + break LoS */
    RETREAT = 'RETREAT',
};

/** Weights for the unified position evaluator — behavior only tunes priorities */
type EvalWeights = {
    damageOut: number;
    damageIn: number;
    voronoi: number;
    cover: number;
    bombThreat: number;
    allyCluster: number;
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

    private get totalEnemyBombs(): number {
        return this.aliveEnemies.reduce((sum, e) => sum + e.splashBombs, 0);
    }

    private get allyWithLowestStats (): Agent {
        return [...this.aliveAllies]
            .sort((a, b) => {
                const bombsDiff = a.splashBombs - b.splashBombs;
                if (bombsDiff !== 0) return bombsDiff;
                const soakingDiff = a.metaData.soakingPower - b.metaData.soakingPower;
                if (soakingDiff !== 0) return soakingDiff;
                const rangeDiff = a.metaData.optimalRange - b.metaData.optimalRange;
                if (rangeDiff !== 0) return rangeDiff;
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
    // STRATEGY SELECTION — lightweight modifiers, not roleplay
    // =============================================================================

    /**
     * Pick the best strategy given current game state.
     * Strategies only tune eval weights and one-off role assignments.
     */
    private selectStrategy(): GameStrategy {
        const allyCount = this.aliveAllies.length;
        const turnsLeft = 100 - this.turnCount;
        const alliesAverageWetness = allyCount > 0
            ? this.aliveAllies.reduce((sum, a) => sum + a.wetness, 0) / allyCount
            : 0;

        if (this.scoreAdvantage >= 300 && turnsLeft <= 30)
            return GameStrategy.VERROU;

        if (allyCount < this.aliveEnemies.length || alliesAverageWetness >= 70)
            return GameStrategy.REPLI;

        if (allyCount > this.aliveEnemies.length)
            return GameStrategy.FOCUS;

        if (this.totalEnemyBombs >= 3 && this.gameMap.obstaclesPercentage >= 10)
            return GameStrategy.BAIT;

        return GameStrategy.ETAU;
    }

    /**
     * Assign agent behaviors according to the active strategy.
     * Most agents use the same eval-based movement — behavior only tunes weights.
     */
    private assignBehaviorsForStrategy(strategy: GameStrategy): void {
        const allies = this.aliveAllies;
        if (!allies.length) return;

        switch (strategy) {
            case GameStrategy.FOCUS: {
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
            case GameStrategy.BAIT:
                allies.forEach((a) => {
                    if (a.behavior !== AgentBehavior.RETREAT) a.behavior = AgentBehavior.HOLD_COVER;
                });
                break;
            case GameStrategy.REPLI:
                allies.forEach((a) => { a.behavior = AgentBehavior.RETREAT; });
                break;
            default:
                allies.forEach((a) => {
                    if (a.behavior !== AgentBehavior.RETREAT) a.behavior = AgentBehavior.OVERWATCH;
                });
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
        const aliveAgentsCount: number = parseInt(readline());
        const aliveAgentIdsThisTurn = new Set<number>();
    
        for (let i = 0; i < aliveAgentsCount; i++) {
            var inputs: string[] = readline().split(' ');
            const agentId: number = parseInt(inputs[0]);
            aliveAgentIdsThisTurn.add(agentId);
            const x: number = parseInt(inputs[1]);
            const y: number = parseInt(inputs[2]);
            const cooldown: number = parseInt(inputs[3]);
            const splashBombs: number = parseInt(inputs[4]);
            const wetness: number = parseInt(inputs[5]);

            const metaData = this.allAgentsData.get(agentId);
            if (!metaData) throw new Error(`Unknown agent ${agentId}`);

            this.upsertAgent({ agentId, coordinates: { x, y }, cooldown, splashBombs, wetness, metaData });
        }
        const _myAgentCount: number = parseInt(readline());

        this.aliveAgents = this.aliveAgents.filter(({ agentId }) => aliveAgentIdsThisTurn.has(agentId));

        if (!this.behaviorsAssigned) {
            this.assignBehaviorsForStrategy(this.currentStrategy);
            this.behaviorsAssigned = true;
        }
    }

    public playTurn() {
        this.turnCount++;
        this.scoreAdvantage = this.gameMap.computeVoronoiDelta(this.aliveAllies, this.aliveEnemies);

        const retreatThreshold = this.computeRetreatThreshold();
        this.aliveAllies.forEach((ally) => {
            if (ally.wetness >= retreatThreshold && ally.behavior !== AgentBehavior.RETREAT) {
                ally.behavior = AgentBehavior.RETREAT;
            } else if (ally.behavior === AgentBehavior.RETREAT && ally.wetness < retreatThreshold * 0.5) {
                ally.behavior = AgentBehavior.HOLD_COVER;
            }
        });

        const newStrategy = this.selectStrategy();
        if (newStrategy !== this.currentStrategy) {
            console.error(`Strategy: ${this.currentStrategy} → ${newStrategy}`);
            this.currentStrategy = newStrategy;
            this.assignBehaviorsForStrategy(newStrategy);
        }

        const sortedAllies = [...this.aliveAllies].sort((a, b) => {
            const wetnessDiff = a.wetness - b.wetness;
            if (wetnessDiff !== 0) return wetnessDiff;
            const soakingDiff = b.metaData.soakingPower - a.metaData.soakingPower;
            if (soakingDiff !== 0) return soakingDiff;
            return b.metaData.optimalRange - a.metaData.optimalRange;
        });

        const claimedPositions: Coordinates[] = [];
        const totalEnemyBombs = this.totalEnemyBombs;

        sortedAllies.forEach((ally) => {
            const chosenPosition = ally.decideActions({
                allies: this.aliveAllies,
                enemies: this.aliveEnemies,
                gameMap: this.gameMap,
                strategy: this.currentStrategy,
                claimedPositions,
                scoreAdvantage: this.scoreAdvantage,
                totalEnemyBombs,
            });
            claimedPositions.push(chosenPosition);
        });
    }

    /** Retreat only when genuinely endangered — agents at 50+ wetness still fight for territory */
    private computeRetreatThreshold(): number {
        if (!this.aliveEnemies.length) return 80;
        const maxEnemySoaking = Math.max(...this.aliveEnemies.map((e) => e.metaData.soakingPower));
        return Math.min(80, Math.max(65, 100 - maxEnemySoaking));
    }
}

class GameMap {
    constructor() {
        var inputs: string[] = readline().split(' ');
        this.width = parseInt(inputs[0]);
        this.height = parseInt(inputs[1]);

        for (let i = 0; i < this.height; i++) {
            var inputs: string[] = readline().split(' ');
            for (let j = 0; j < this.width; j++) {
                const x: number = parseInt(inputs[3 * j]);
                const y: number = parseInt(inputs[3 * j + 1]);
                const tileType: number = parseInt(inputs[3 * j + 2]);
                this.grid.set(this.getCoordinatesKey({ x, y }), { x, y, tileType });
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
        ].filter(({ tile }) => Boolean(tile));
        return adjacent;
    }

    public isSamePosition (posA: Coordinates, posB: Coordinates): boolean {
        return posA.x === posB.x && posA.y === posB.y;
    }

    /** Agent standing on a cover tile (may or may not be protected from a given shooter) */
    public isOnCoverTile(position: Coordinates): boolean {
        return this.covers.some((cover) => this.isSamePosition(cover.tile, position));
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

    /** Hypothetical agent at a new position — for evaluation only */
    private agentAt(agent: Agent, position: Coordinates): Agent {
        return { ...agent, coordinates: position } as Agent;
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
            if (this.isSamePosition(position, target)) return true;
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
                let step = current;
                let prev = cameFrom.get(key(step));
                while (prev && !this.isSamePosition(prev, origin)) {
                    step = prev;
                    prev = cameFrom.get(key(step));
                }
                return step;
            }

            for (const neighbor of [
                { x: current.x - 1, y: current.y },
                { x: current.x + 1, y: current.y },
                { x: current.x,     y: current.y - 1 },
                { x: current.x,     y: current.y + 1 },
            ]) {
                const k = key(neighbor);
                if (!visited.has(k) && isWalkable(neighbor)) {
                    visited.add(k);
                    cameFrom.set(k, current);
                    queue.push(neighbor);
                }
            }
        }

        return origin;
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

    /** Walkable adjacent tiles + current position — all we can reach in one turn */
    public getAdjacentCandidates({
        origin,
        occupiedPositions,
    }: {
        origin: Coordinates;
        occupiedPositions: Coordinates[];
    }): Coordinates[] {
        const candidates: Coordinates[] = [origin];
        for (const { tile } of this.getAdjacentTilesOf(origin)) {
            if (
                tile.tileType === TileType.EMPTY &&
                !occupiedPositions.some((p) => this.isSamePosition(p, tile))
            ) {
                candidates.push(tile);
            }
        }
        return candidates;
    }

    public get obstaclesPercentage(): number {
        const obstaclesCount = [...this.grid.values()].filter((t) => t.tileType !== TileType.EMPTY).length;
        return obstaclesCount / [...this.grid.values()].length * 100;
    }

    // =============================================================================
    // VORONOI / TERRITORY
    // =============================================================================

    private getEffectiveDist(tile: Coordinates, agent: Agent): number {
        const d = this.getManhattanDistance(tile, agent.coordinates);
        return agent.wetness >= 50 ? d * 2 : d;
    }

    public computeVoronoiDelta(allies: Agent[], enemies: Agent[]): number {
        let allyTiles = 0;
        let enemyTiles = 0;

        for (const tile of this.grid.values()) {
            if (tile.tileType !== TileType.EMPTY) continue;

            const minAllyDist = allies.length
                ? Math.min(...allies.map((a) => this.getEffectiveDist(tile, a)))
                : Infinity;
            const minEnemyDist = enemies.length
                ? Math.min(...enemies.map((e) => this.getEffectiveDist(tile, e)))
                : Infinity;

            if (minAllyDist < minEnemyDist) allyTiles++;
            else if (minEnemyDist < minAllyDist) enemyTiles++;
        }

        return allyTiles - enemyTiles;
    }

    /** Voronoi delta if one ally moves to a new position */
    public computeVoronoiDeltaWithAllyAt({
        allies,
        enemies,
        allyId,
        position,
    }: {
        allies: Agent[];
        enemies: Agent[];
        allyId: number;
        position: Coordinates;
    }): number {
        const movedAllies = allies.map((a) =>
            a.agentId === allyId ? this.agentAt(a, position) : a
        );
        return this.computeVoronoiDelta(movedAllies, enemies);
    }

    /**
     * Tiles we would gain if this enemy crosses wetness 50 (distance doubles).
     * This is the single most valuable tactical event in the game.
     */
    public estimateVoronoiGainFromWet50Crossing({
        enemy,
        allies,
        enemies,
        damage,
    }: {
        enemy: Agent;
        allies: Agent[];
        enemies: Agent[];
        damage: number;
    }): number {
        if (enemy.wetness >= 50 || enemy.wetness + damage < 50) return 0;

        let gain = 0;
        for (const tile of this.grid.values()) {
            if (tile.tileType !== TileType.EMPTY) continue;

            const minAlly = allies.length
                ? Math.min(...allies.map((a) => this.getEffectiveDist(tile, a)))
                : Infinity;

            const enemyDistBefore = this.getEffectiveDist(tile, enemy);
            const enemyDistAfter = this.getManhattanDistance(tile, enemy.coordinates) * 2;

            const minEnemyBefore = Math.min(
                enemyDistBefore,
                ...enemies.filter((e) => e.agentId !== enemy.agentId).map((e) => this.getEffectiveDist(tile, e))
            );
            const minEnemyAfter = Math.min(
                enemyDistAfter,
                ...enemies.filter((e) => e.agentId !== enemy.agentId).map((e) => this.getEffectiveDist(tile, e))
            );

            // Enemy currently wins this tile; doubling their dist gives it to us
            if (minEnemyBefore < minAlly && minEnemyAfter >= minAlly) gain++;
        }
        return gain;
    }

    // =============================================================================
    // COVER SYSTEM
    // =============================================================================
    private covers: Cover[] = [];

    private buildCoverMap() {
        const obstacles = [...this.grid.values()].filter((tile) => tile.tileType !== TileType.EMPTY);
        const coverComponents: Cover[] = [];

        obstacles.forEach((obstacleTile) => {
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

    public calculateProtectionTypeAgainstShooter({ shooter, shooterTarget }: { shooter: Agent; shooterTarget: Agent; }): TileType {
        const targetCover = this.covers.find((cover) => this.isSamePosition(cover.tile, shooterTarget.coordinates));
        if (!targetCover) return TileType.EMPTY;

        const targetProtectionZone = this.getCoverTotalProtectionZone(targetCover);
        return targetProtectionZone.zone.some((tile) => this.isSamePosition(shooter.coordinates, tile))
            ? targetProtectionZone.protectionType
            : TileType.EMPTY;
    }

    /** Actual cover protection value at position against all enemies (direction-aware) */
    public getCoverProtectionScore({
        agent,
        position,
        enemies,
        totalEnemyBombs,
    }: {
        agent: Agent;
        position: Coordinates;
        enemies: Agent[];
        totalEnemyBombs: number;
    }): number {
        // Cover is nearly worthless against bombs — scale down when enemy still has bombs
        const bombFactor = totalEnemyBombs === 0 ? 1.5 : totalEnemyBombs <= 2 ? 0.6 : 0.3;
        const hypothetical = this.agentAt(agent, position);
        let score = 0;

        for (const enemy of enemies) {
            const protection = this.calculateProtectionTypeAgainstShooter({ shooter: enemy, shooterTarget: hypothetical });
            if (protection === TileType.HIGH_COVER) score += 18 * bombFactor;
            else if (protection === TileType.LOW_COVER) score += 10 * bombFactor;
        }

        return score;
    }

    // =============================================================================
    // COMBAT EVALUATION — E[damage out] - E[damage in] + voronoi
    // =============================================================================

    /** N.B.: the enemy can still hunker down, which seems to be unpredictable */
    public estimateEffectiveShotDamage({ shooter, shooterTarget, assumeHunker = false }: {
        shooter: Agent;
        shooterTarget: Agent;
        assumeHunker?: boolean;
    }): number {
        const distanceFromShooter = this.getManhattanDistance(shooterTarget.coordinates, shooter.coordinates);
        const baseDamage = (() => {
            if (distanceFromShooter <= shooter.metaData.optimalRange) return shooter.metaData.soakingPower;
            if (distanceFromShooter <= shooter.metaData.optimalRange * 2) return shooter.metaData.soakingPower / 2;
            return 0;
        })();

        const targetCover = this.calculateProtectionTypeAgainstShooter({ shooter, shooterTarget });
        let damage = baseDamage;
        switch (targetCover) {
            case TileType.HIGH_COVER: damage = baseDamage * 3 / 4; break;
            case TileType.LOW_COVER:  damage = baseDamage / 2; break;
        }
        if (assumeHunker) damage *= 0.75;
        return damage;
    }

    public canTargetBeKilledNow({ effectiveDamage, wetness }: { effectiveDamage: number; wetness: number; }): boolean {
        return wetness + effectiveDamage >= 100;
    }

    /** Best damage this agent can deal this turn from a given position */
    public estimateOutgoingDamage({
        agent,
        position,
        enemies,
    }: {
        agent: Agent;
        position: Coordinates;
        enemies: Agent[];
    }): number {
        if (agent.cooldown > 0) return 0;
        const hypothetical = this.agentAt(agent, position);
        let best = 0;
        for (const enemy of enemies) {
            const dmg = this.estimateEffectiveShotDamage({ shooter: hypothetical, shooterTarget: enemy });
            if (dmg > best) best = dmg;
        }
        return best;
    }

    /** Expected incoming shot damage — assume enemies hunker when they can shoot us hard */
    public estimateIncomingDamage({
        agent,
        position,
        enemies,
    }: {
        agent: Agent;
        position: Coordinates;
        enemies: Agent[];
    }): number {
        const hypothetical = this.agentAt(agent, position);
        let total = 0;
        for (const enemy of enemies) {
            if (enemy.cooldown > 0) continue;
            const dmg = this.estimateEffectiveShotDamage({
                shooter: enemy,
                shooterTarget: hypothetical,
                assumeHunker: false,
            });
            // Assume hunker when shot would hurt — conservative incoming estimate
            const hunkerDmg = this.estimateEffectiveShotDamage({
                shooter: enemy,
                shooterTarget: hypothetical,
                assumeHunker: true,
            });
            total += (dmg + hunkerDmg) / 2;
        }
        return total;
    }

    /** Penalty for standing where enemy bombs can splash us + nearby allies */
    public estimateBombThreatAt({
        position,
        agent,
        allies,
        enemies,
    }: {
        position: Coordinates;
        agent: Agent;
        allies: Agent[];
        enemies: Agent[];
    }): number {
        let threat = 0;
        for (const enemy of enemies) {
            if (enemy.splashBombs <= 0) continue;
            if (this.getManhattanDistance(position, enemy.coordinates) > 4) continue;

            // Enemy could throw at our position or adjacent — check splash overlap
            for (const tile of this.grid.values()) {
                if (this.getManhattanDistance(enemy.coordinates, tile) > 4) continue;
                const splashZone = this.getSplashZone(tile);
                const hitsUs = splashZone.some((t) => this.isSamePosition(t, position));
                if (!hitsUs) continue;

                const alliesHit = allies.filter((a) =>
                    splashZone.some((t) => this.isSamePosition(t, a.coordinates))
                ).length;
                threat += 30 + alliesHit * 20;
                break;
            }
        }
        return threat;
    }

    /** Penalty for clustering when enemy has many bombs remaining */
    public getAllyClusterPenalty({
        position,
        agent,
        allies,
        totalEnemyBombs,
    }: {
        position: Coordinates;
        agent: Agent;
        allies: Agent[];
        totalEnemyBombs: number;
    }): number {
        if (totalEnemyBombs === 0) return 0;
        const nearbyAllies = allies.filter((a) =>
            a.agentId !== agent.agentId &&
            this.getChebyshevDistance(position, a.coordinates) <= 1
        ).length;

        const spacingWeight = totalEnemyBombs >= 6 ? 30 : totalEnemyBombs >= 3 ? 18 : 8;
        return nearbyAllies * spacingWeight;
    }

    public getEvalWeights(behavior: AgentBehavior, totalEnemyBombs: number): EvalWeights {
        const base: EvalWeights = {
            damageOut: 1.2,
            damageIn: 1.0,
            voronoi: 2.0,
            cover: 1.0,
            bombThreat: 1.0,
            allyCluster: 1.0,
        };

        switch (behavior) {
            case AgentBehavior.ATTACK:
                return { ...base, damageOut: 1.8, damageIn: 0.7, voronoi: 1.5 };
            case AgentBehavior.HOLD_COVER:
                return { ...base, damageIn: 1.4, cover: totalEnemyBombs === 0 ? 2.0 : 1.2, voronoi: 2.2 };
            case AgentBehavior.RETREAT:
                return { ...base, damageOut: 0.5, damageIn: 2.0, cover: 1.5, bombThreat: 1.8, allyCluster: 1.5, voronoi: 1.0 };
            default:
                return base;
        }
    }

    /**
     * Unified position scorer: E[damage out] - E[damage in] + voronoi gain + cover - bomb threat.
     * This replaces roleplay behaviors for movement decisions.
     */
    public scorePositionFull({
        agent,
        position,
        allies,
        enemies,
        totalEnemyBombs,
        currentVoronoiDelta,
        weights,
    }: {
        agent: Agent;
        position: Coordinates;
        allies: Agent[];
        enemies: Agent[];
        totalEnemyBombs: number;
        currentVoronoiDelta: number;
        weights: EvalWeights;
    }): number {
        const outgoing = this.estimateOutgoingDamage({ agent, position, enemies });
        const incoming = this.estimateIncomingDamage({ agent, position, enemies });
        const voronoiAtPos = this.computeVoronoiDeltaWithAllyAt({
            allies, enemies, allyId: agent.agentId, position,
        });
        const voronoiGain = voronoiAtPos - currentVoronoiDelta;
        const coverScore = this.getCoverProtectionScore({ agent, position, enemies, totalEnemyBombs });
        const bombThreat = this.estimateBombThreatAt({ position, agent, allies, enemies });
        const clusterPenalty = this.getAllyClusterPenalty({ position, agent, allies, totalEnemyBombs });

        return (
            outgoing * weights.damageOut
            - incoming * weights.damageIn
            + voronoiGain * weights.voronoi
            + coverScore * weights.cover
            - bombThreat * weights.bombThreat * 0.05
            - clusterPenalty * weights.allyCluster
        );
    }

    /** Pick the best adjacent tile (or stay) using the unified evaluator */
    public getBestMovePosition({
        agent,
        allies,
        enemies,
        occupiedPositions,
        totalEnemyBombs,
        currentVoronoiDelta,
        weights,
    }: {
        agent: Agent;
        allies: Agent[];
        enemies: Agent[];
        occupiedPositions: Coordinates[];
        totalEnemyBombs: number;
        currentVoronoiDelta: number;
        weights: EvalWeights;
    }): Coordinates {
        const candidates = this.getAdjacentCandidates({ origin: agent.coordinates, occupiedPositions });

        return candidates
            .map((position) => ({
                position,
                score: this.scorePositionFull({
                    agent, position, allies, enemies, totalEnemyBombs, currentVoronoiDelta, weights,
                }),
            }))
            .sort((a, b) => b.score - a.score)[0]?.position ?? agent.coordinates;
    }

    // =============================================================================
    // TARGET SELECTION
    // =============================================================================

    /** Score an enemy as a shoot target — the highest-ROI function in the bot */
    public scoreShootTarget({
        shooter,
        enemy,
        allies,
        enemies,
    }: {
        shooter: Agent;
        enemy: Agent;
        allies: Agent[];
        enemies: Agent[];
    }): number {
        const dist = this.getManhattanDistance(shooter.coordinates, enemy.coordinates);
        if (dist > shooter.metaData.optimalRange * 2) return -Infinity;

        const effectiveDamage = this.estimateEffectiveShotDamage({ shooter, shooterTarget: enemy });
        if (effectiveDamage <= 0) return -Infinity;

        let score = effectiveDamage;

        // Kill this turn — top priority
        if (this.canTargetBeKilledNow({ effectiveDamage, wetness: enemy.wetness })) {
            score += 120;
            // Extra value for removing a bomb carrier before they spend bombs
            if (enemy.splashBombs > 0) score += 30 + enemy.splashBombs * 10;
        }

        // Wetness 50 crossing — massive Voronoi swing (far more important than +10)
        if (enemy.wetness < 50 && enemy.wetness + effectiveDamage >= 50) {
            const voronoiGain = this.estimateVoronoiGainFromWet50Crossing({
                enemy, allies, enemies, damage: effectiveDamage,
            });
            score += 40 + voronoiGain * 3;
        }

        // Already at 50+ — enemy is territorially weakened
        if (enemy.wetness >= 50) score += 25;

        // Bomb carriers are strategic threats — but don't override immediate kills
        score += enemy.splashBombs * 12 + enemy.splashBombs * enemy.splashBombs * 4;

        // Exposed to us (direction-aware, not just "on cover tile")
        const protection = this.calculateProtectionTypeAgainstShooter({ shooter, shooterTarget: enemy });
        if (protection === TileType.EMPTY) score += 15;

        if (enemy.cooldown > 0) score += 8;
        score += enemy.wetness * 0.4;
        if (dist <= shooter.metaData.optimalRange) score += 5;

        return score;
    }

    public getIdealShootTarget({
        enemies,
        shooter,
        allies,
    }: {
        enemies: Agent[];
        shooter: Agent;
        allies: Agent[];
    }): { enemy: Agent; score: number } | undefined {
        const scored = enemies
            .map((enemy) => ({
                enemy,
                score: this.scoreShootTarget({ shooter, enemy, allies, enemies }),
            }))
            .filter(({ score }) => score > -Infinity)
            .sort((a, b) => b.score - a.score);

        return scored[0];
    }

    // =============================================================================
    // SPLASH BOMBS — ignore cover/hunker, allow favorable trades
    // =============================================================================
    private getSplashZone(origin: Coordinates): Coordinates[] {
        return this.getTilesWithinChebyshevDistance({ origin, distance: 1 });
    }

    private isBombTargetInReach({ throwerPosition, targetPosition }: { throwerPosition: Coordinates; targetPosition: Coordinates; }): boolean {
        return this.getManhattanDistance(throwerPosition, targetPosition) <= 4;
    }

    /** Score a bomb throw — bombs break cover defenses that shots cannot */
    public scoreBombTarget({
        thrower,
        target,
        allies,
        enemies,
        acceptAllyDamage,
    }: {
        thrower: Agent;
        target: Coordinates;
        allies: Agent[];
        enemies: Agent[];
        acceptAllyDamage: boolean;
    }): number {
        const splashZone = this.getSplashZone(target);
        const touchedEnemies = enemies.filter((e) =>
            splashZone.some((t) => this.isSamePosition(t, e.coordinates))
        );
        const touchedAllies = allies.filter((a) =>
            a.agentId !== thrower.agentId &&
            splashZone.some((t) => this.isSamePosition(t, a.coordinates))
        );

        if (!touchedEnemies.length) return -Infinity;

        let score = 0;

        for (const enemy of touchedEnemies) {
            score += 30;

            if (enemy.wetness + 30 >= 100) score += 90;
            if (enemy.wetness < 50 && enemy.wetness + 30 >= 50) score += 35;

            // Bombs ignore cover — huge value vs covered targets shots can't finish
            const shotDamage = this.estimateEffectiveShotDamage({ shooter: thrower, shooterTarget: enemy });
            if (shotDamage < 15 && this.isOnCoverTile(enemy.coordinates)) score += 30;
            if (shotDamage < 30) score += 15;

            score += enemy.splashBombs * 12;
        }

        const allyDamage = touchedAllies.length * 30;
        const allyPenalty = acceptAllyDamage
            ? allyDamage * 0.35
            : allyDamage * 1.5;

        score -= allyPenalty;

        // Don't waste bomb on 1 enemy killable by shot UNLESS cover blocks the shot
        if (
            touchedEnemies.length === 1 &&
            thrower.cooldown === 0 &&
            this.canTargetBeKilledNow({
                effectiveDamage: this.estimateEffectiveShotDamage({ shooter: thrower, shooterTarget: touchedEnemies[0] }),
                wetness: touchedEnemies[0].wetness,
            }) &&
            this.estimateEffectiveShotDamage({ shooter: thrower, shooterTarget: touchedEnemies[0] }) >= 20
        ) {
            score -= 50;
        }

        return score;
    }

    public getIdealBombTarget({
        thrower,
        allies,
        enemies,
        acceptAllyDamage,
        minScore = 20,
    }: {
        thrower: Agent;
        allies: Agent[];
        enemies: Agent[];
        acceptAllyDamage: boolean;
        minScore?: number;
    }): { target: Coordinates; score: number } | undefined {
        const candidates = [...this.grid.values()]
            .filter((target) => this.isBombTargetInReach({ throwerPosition: thrower.coordinates, targetPosition: target }))
            .map((target) => ({
                target,
                score: this.scoreBombTarget({ thrower, target, allies, enemies, acceptAllyDamage }),
            }))
            .filter(({ score }) => score >= minScore)
            .sort((a, b) => b.score - a.score);

        return candidates[0];
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
    public behavior: AgentBehavior = AgentBehavior.OVERWATCH;

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
        scoreAdvantage,
        totalEnemyBombs,
    }: {
        gameMap: GameMap;
        allies: Agent[];
        enemies: Agent[];
        strategy: GameStrategy;
        claimedPositions: Coordinates[];
        scoreAdvantage: number;
        totalEnemyBombs: number;
    }): Coordinates {
        const canShoot = this.cooldown === 0;
        const hasBombs = this.splashBombs > 0;

        const occupiedByEnemies = enemies.map((e) => e.coordinates);
        const blockedThisTurn = [...occupiedByEnemies, ...claimedPositions];

        const weights = gameMap.getEvalWeights(this.behavior, totalEnemyBombs);

        // === Movement: unified eval — behavior only tunes weights ===
        const nextMove = gameMap.getBestMovePosition({
            agent: this,
            allies,
            enemies,
            occupiedPositions: blockedThisTurn,
            totalEnemyBombs,
            currentVoronoiDelta: scoreAdvantage,
            weights,
        });

        this.actionService.move({ currentPosition: this.coordinates, targetPosition: nextMove });

        // === Battle action: pick highest-scoring combat option ===
        // Dying agents should spend bombs — lower threshold, accept ally splash
        const isDying = this.wetness >= 60;
        const acceptAllyDamage = isDying || this.behavior === AgentBehavior.ATTACK;
        const bombMinScore = isDying ? 5 : 20;

        const bombResult = hasBombs
            ? gameMap.getIdealBombTarget({
                thrower: this,
                allies,
                enemies,
                acceptAllyDamage,
                minScore: bombMinScore,
            })
            : undefined;

        const shootResult = canShoot
            ? gameMap.getIdealShootTarget({ shooter: this, enemies, allies })
            : undefined;

        const bombScore = bombResult?.score ?? -Infinity;
        const shootScore = shootResult?.score ?? -Infinity;

        if (bombResult && bombScore >= shootScore && bombScore >= bombMinScore) {
            this.actionService.throw(bombResult.target);
        } else if (shootResult && shootScore > 0) {
            this.actionService.shoot(shootResult.enemy.agentId);
        } else {
            this.actionService.hunkerDown();
        }

        this.actionService.executeActions();
        return nextMove;
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
