/**
 * Win the water fight by controlling the most territory, or out-soak your opponent!
 **/

/**
 * High-level behavioral strategies used by the bot to adapt its global team behavior
 * depending on the current game state and opponent dynamics.
 */
enum GameStrategy {
    /** Throw weak ally at enemies to lure them & make them waste bombs */
    BAIT = 'bait',
    /** Focus on killing enemies as quick as possible */
    FOCUS_FIRE = 'focus-fire'

    // Add more strategies to adjust behavior to other bots
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

type AgentBehaviorPolicyType = 'riskSeeker' | 'conservativeFollower' | 'conservativeAttacker';
type AgentBehaviorPolicy = {
    type: AgentBehaviorPolicyType;
    formationRole: 'frontline' | 'follower';
    bombPolicy: {
        allowFriendlyFire: boolean;
        requireEnemyCluster: boolean;
    },
    coverPolicy: {
        shouldSearchCover: false;
    } | {
        shouldSearchCover: true;
        coverSearchRadius: number;
    }
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
    private currentGameTurn = 0;
    private readonly gameMap: GameMap;
    private readonly allAgentsData = new Map<number, AgentMetaData>;
    private aliveAgents: Agent[] = [];
    private currentStrategy: GameStrategy | undefined;

    private readonly AGENT_BEHAVIOR_POLICIES: Record<AgentBehaviorPolicyType, AgentBehaviorPolicy> = {
        riskSeeker: {
            type: 'riskSeeker',
            formationRole: 'frontline',
            bombPolicy: { allowFriendlyFire: true, requireEnemyCluster: false },
            coverPolicy: { shouldSearchCover: false }
        },
        conservativeFollower: {
            type: 'conservativeFollower',
            formationRole: 'follower',
            bombPolicy: { allowFriendlyFire: false, requireEnemyCluster: true },
            coverPolicy: { shouldSearchCover: true, coverSearchRadius: 3 }
        },
        conservativeAttacker: {
            type: 'conservativeAttacker',
            formationRole: 'frontline',
            bombPolicy: { allowFriendlyFire: false, requireEnemyCluster: false },
            coverPolicy: { shouldSearchCover: true, coverSearchRadius: 3 }
        }
    };

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
    }

    private get aliveAllies() {
        return this.aliveAgents.filter((agent) => agent.metaData?.playerId === this.myId);
    }

    private get aliveEnemies() {
        return this.aliveAgents.filter((agent) => agent.metaData?.playerId !== this.myId);
    }

    private get aliveAlliesPercentage(): number {
        const originalAlliesCount = [...this.allAgentsData.values()].filter(({ playerId }) => playerId === this.myId).length;
        return this.aliveAllies.length / originalAlliesCount * 100;
    }

    private get allyWithLowestStats(): Agent {
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

    private get totalEnemyBombs(): number {
        return this.aliveEnemies.reduce((count, { splashBombs }) => count + splashBombs, 0);
    }
    
    private upsertAgent(agentProps: AgentProps): void {
        const existingAgent = this.aliveAgents.find(
            (agent) => agent.agentId === agentProps.agentId
        );

        // Update state of existing agent
        if (existingAgent) return existingAgent.update(agentProps);

        // Create agent instance
        const newAgent = new Agent(agentProps);
        this.aliveAgents.push(newAgent);
    }

    /** Pick the best strategy given current game state */
    private selectStrategy(): GameStrategy {
        if (
            this.totalEnemyBombs >= 3 && // Baiting only pays off if enemies still have bombs to waste
            this.gameMap.obstaclesPercentage < 10 && // Current version of baiting is risky on fields filled with obstacles
            this.aliveAlliesPercentage > 2/3 * 100 // Avoid sacrificing too much of the team
        )
            return GameStrategy.BAIT;

        return GameStrategy.FOCUS_FIRE;
    }

    /** Assign agent behaviors according to the active strategy */
    private assignBehaviorsForStrategy(strategy: GameStrategy): void {
        switch (strategy) {
            case GameStrategy.FOCUS_FIRE: {
                this.aliveAllies.forEach((ally) => ally.behaviorPolicy = this.AGENT_BEHAVIOR_POLICIES.conservativeAttacker);
                break;
            }
            case GameStrategy.BAIT: {
                this.aliveAllies.forEach((ally) => {
                    if (ally.agentId === this.allyWithLowestStats.agentId) ally.behaviorPolicy = this.AGENT_BEHAVIOR_POLICIES.riskSeeker;
                    else ally.behaviorPolicy = this.AGENT_BEHAVIOR_POLICIES.conservativeFollower; // Other allies follow in support
                });
            }
        }
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

            const agentProps: Omit<AgentProps, 'behavior'> = {
                agentId,
                coordinates: { x, y },
                cooldown,
                splashBombs,
                wetness,
                metaData,
            };
            
            // Use singleton agents
            this.upsertAgent(agentProps);
        }
        const _myAgentCount: number = parseInt(readline()); // Number of alive agents controlled by you

        // Remove eliminated agents
        this.aliveAgents = this.aliveAgents.filter(({ agentId }) => aliveAgentIdsThisTurn.has(agentId));
    }

    public playTurn() {
        this.currentGameTurn++;

        // Reevaluate the game strategy on each turn
        const strategy = this.selectStrategy();
        if (strategy !== this.currentStrategy) {
            this.currentStrategy = strategy;
            // Assign agent behaviors
            this.assignBehaviorsForStrategy(strategy);
        }

        // Let each ally decide what to do according to their internal behavior policy state
        this.aliveAllies.forEach((ally) => {
            ally.decideActions({
                // Pass game data
                allies: this.aliveAllies,
                enemies: this.aliveEnemies,
                gameMap: this.gameMap,
                gameStrategy: this.currentStrategy!
            });
        });
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
        return [
            { tile: this.getTileAt({ x: x - 1, y })!, direction: Direction.LEFT },
            { tile: this.getTileAt({ x: x + 1, y })!, direction: Direction.RIGHT },
            { tile: this.getTileAt({ x, y: y - 1 })!, direction: Direction.TOP },
            { tile: this.getTileAt({ x, y: y + 1 })!, direction: Direction.BOTTOM },
        ].filter(({ tile }) => Boolean(tile)); // getTileAt returns undefined when tile is out of bounds
    }

    public isSamePosition (posA: Coordinates, posB: Coordinates): boolean {
        return posA.x === posB.x && posA.y === posB.y;
    }

    private getManhattanDistance(a: Coordinates, b: Coordinates): number {
        return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    }

    private getChebyshevDistance(
        a: Coordinates,
        b: Coordinates
    ): number {
        return Math.max(
            Math.abs(a.x - b.x),
            Math.abs(a.y - b.y)
        );
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

    /** Finds the first step on the shortest path from origin to target using a BFS search */
    public findNextStepOnShortestPath({
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
                tile?.tileType === TileType.EMPTY &&
                !occupiedPositions.some((occ) => this.isSamePosition(occ, position))
            );
        };

        const queue: Coordinates[] = [origin];
        const visited = new Set<string>([this.getCoordinatesKey(origin)]);
        const cameFrom = new Map<string, Coordinates>();

        while (queue.length > 0) {
            const current = queue.shift()!;

            if (this.isSamePosition(current, target)) {
                let step = current;
                let prev = cameFrom.get(this.getCoordinatesKey(step));
                while (prev && !this.isSamePosition(prev, origin)) {
                    step = prev;
                    prev = cameFrom.get(this.getCoordinatesKey(step));
                }
                return step;
            }

            for (const { tile: neighbor } of this.getAdjacentTilesOf(current)) {
                const k = this.getCoordinatesKey(neighbor);
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
            .sort((a, b) => a.distanceFromOrigin - b.distanceFromOrigin) // ASC
            [0].agent;
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
        if (count === 1)
            return [{
                x: origin.x,
                y: Math.floor(this.height / 2)
            }];

        const step = (this.height - 1) / (count - 1);
        return Array.from(
            { length: count },
            (_, index) => ({
                x: origin.x,
                y: Math.round(index * step)
            })
        );
    }

    public get obstaclesPercentage () {
        const tiles = [...this.grid.values()];
        const obstacles = tiles.filter(({ tileType }) => tileType !== TileType.EMPTY);
        return obstacles.length / tiles.length * 100;
    }

    // =============================================================================
    // COVER SYSTEM
    // =============================================================================
    private covers: Cover[] = [];

    /** Build a map of all existing covers and the total area they protect from */
    private buildCoverMap() {
        // Find all obstacles
        const obstacles = [...this.grid.values()].filter((tile) => tile.tileType !== TileType.EMPTY);

        // Calculate protection zone for each cover tile
        // Duplicate tiles should be kept for further calculation of total protection area
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
                const hasDuplicate = Boolean(duplicate);
                if (!hasDuplicate) {
                    // Keep cover as is
                    covers.set(coordinatesKey, cover);
                    return covers;
                }

                // Merge duplicates
                const mergedDuplicates: Cover = {
                    tile: cover.tile, // both duplicates logically have the same tile
                    obstacles: [...duplicate?.obstacles ?? [], ...cover.obstacles] // merge obstacles
                }
                covers.set(coordinatesKey, mergedDuplicates);
                return covers
            },
            new Map()
        );

        this.covers = [...coversMap.values()];
    }

    public getIdealCoverNearby({
        origin,
        occupiedPositions,
        enemies,
        maxDistance
    }: {
        origin: Coordinates;
        occupiedPositions: Coordinates[];
        enemies: Agent[];
        maxDistance: number
    }): Coordinates {
        // Collect all tiles within maxDistance
        const moveCandidates = this.getTilesWithinChebyshevDistance({ origin, distance: maxDistance })
            .filter((moveCandidate) => (
                // that are not already occupied by an agent
                !occupiedPositions.some((occupiedPosition) =>
                    this.isSamePosition(moveCandidate, occupiedPosition)
                )
                // or by an obstacle
                && moveCandidate.tileType === TileType.EMPTY
            ));

        // Find nearest move candidate that blocks the most enemies and w/ highest protection lvl
        return moveCandidates
            .map((moveCandidate) => ({
                moveCandidate,
                distanceFromOrigin: this.getManhattanDistance(origin, moveCandidate),
                ...this.getBlockedEnemiesCountAt({
                    position: moveCandidate,
                    enemies,
                })
            }))
            .sort((a, b) => {
                // 1st priority: shortest distance
                const distanceDiff = a.distanceFromOrigin - b.distanceFromOrigin;
                if (distanceDiff !== 0) return distanceDiff; 

                // Protection type
                const protectionDiff = (b.protectionType ?? TileType.EMPTY) - (a.protectionType ?? TileType.EMPTY);
                if (distanceDiff !== 0) return distanceDiff; 

                // Blocked enemies count
                const blockedDiff = (b.blockedEnemiesCount ?? 0) - (a.blockedEnemiesCount ?? 0);
                return blockedDiff;
            })
            [0]?.moveCandidate ?? origin; // If no move candidate found, do not move
    }

    private getCoverTotalProtectionZone(cover: Cover): ProtectionZone {
        if (cover.obstacles.length === 1) return {
            zone: cover.obstacles[0].protectedAgainst,
            protectionType: cover.obstacles[0].tile.tileType
        }; // Skip if merging is not needed

        // Merge protection zone of each obstacle (use Map to avoid duplicates)
        const mergedProtectionZonesMap = cover.obstacles.reduce<Map<string, Coordinates>>(
            (positionsMap, coverObstacle) => {
                coverObstacle.protectedAgainst.forEach((position) => {
                    const coordinatesKey = this.getCoordinatesKey(position);
                    positionsMap.set(coordinatesKey, position)
                });
                return positionsMap;
            }, 
            new Map()
        );

        // Use obstacle w/ the highest tileType 
        const protectionType: TileType = cover.obstacles.reduce(
            (highest, obstacle) => Math.max(highest, obstacle.tile.tileType),
            TileType.EMPTY
        );

        return {
            zone: [...mergedProtectionZonesMap.values()],
            protectionType 
        };
    }

    private getBlockedEnemiesCountAt({
        position,
        enemies
    }: {
        position: Coordinates;
        enemies: Agent[];
    }) {
        // Check if the selected position is a cover
        const cover = this.covers.find((cover) => this.isSamePosition(cover.tile, position));
        if (!cover) return 0; // if not, the selected position does not offer any protection

        // Check the total protection zone 
        const protectionZone = this.getCoverTotalProtectionZone(cover);

        // Check how many enemies are within the zone
        return {
            blockedEnemiesCount: protectionZone.zone.reduce<number>(
                (count, position) => {
                    if (enemies.some((enemy) => this.isSamePosition(enemy.coordinates, position)))
                        count++
                    return count;
                }, 0
            ),
            protectionType: protectionZone.protectionType
        }
    }

    private getProtectedZoneBehindObstacle({
        obstaclePosition,
        coverAt
    }: {
        obstaclePosition: Coordinates;
        coverAt: Direction;
    }): GameMapGridTile[] {
        // Get all tiles beyond obstacle
        const tilesBeyondObstacle = (() => 
            [...this.grid.values()].filter((tile) => {
                switch (coverAt) {
                    case Direction.TOP:
                        return tile.y > obstaclePosition.y;
                    case Direction.RIGHT:
                        return tile.x < obstaclePosition.x;
                    case Direction.BOTTOM:
                        return tile.y < obstaclePosition.y;
                    case Direction.LEFT:
                        return tile.x > obstaclePosition.x;
                }
            })
        )();

        // Get all tiles within 1 tile of chebyshev distance
        const obstacleNeighbors = this.getTilesWithinChebyshevDistance({
            origin: obstaclePosition,
            distance: 1
        });

        // Substracts obstacle neighbors from protection zone
        return tilesBeyondObstacle.filter((tileBeyondObstacle) => 
            !obstacleNeighbors.some((obstacleNeighbor) => this.isSamePosition(tileBeyondObstacle, obstacleNeighbor))
        );
    }

    private calculateProtectionTypeAgainstShooter({
        shooter,
        shooterTarget
    }: {
        shooter: Agent;
        shooterTarget: Agent;
    }): TileType {
        const targetCover = this.covers.find((cover) => this.isSamePosition(cover.tile, shooterTarget.coordinates));
        if (!targetCover) return TileType.EMPTY; // Target does not have cover

        // Check whether shooter is within its target's protection zone
        const targetProtectionZone = this.getCoverTotalProtectionZone(targetCover);
        return targetProtectionZone.zone.some((tile) => this.isSamePosition(shooter.coordinates, tile))
            ? targetProtectionZone.protectionType
            : TileType.EMPTY // Shooter is outside protecion zone
    }

    // =============================================================================
    // SHOOTING
    // =============================================================================
    /** N.B.: the enemy can still hunker down, which seems to be unpredictable */
    private estimateEffectiveShotDamage ({
        shooter,
        shooterTarget
    }: {
        shooter: Agent;
        shooterTarget: Agent;
    }): number {
        const distanceFromShooter = this.getManhattanDistance(shooterTarget.coordinates, shooter.coordinates);
        const baseDamage = (() => {
            if (distanceFromShooter <= shooter.metaData.optimalRange) return shooter.metaData.soakingPower;
            if (distanceFromShooter <= shooter.metaData.optimalRange * 2) return shooter.metaData.soakingPower / 2;
            return 0;
        })();

        const targetCover = this.calculateProtectionTypeAgainstShooter({ shooter, shooterTarget });
        switch (targetCover) {
            case TileType.HIGH_COVER: return baseDamage * 3/4;
            case TileType.LOW_COVER: return baseDamage / 2;
            default: return baseDamage;
        }
    }

    private canTargetBeKilledNow(params: { effectiveDamage: number; wetness: number; }): boolean {
        return params.wetness + params.effectiveDamage >= 100;
    }

    /** Find closest enemy whose protection zone does not contain shooter */
    public getIdealShootTarget({
        enemies,
        shooter,
    }: {
        enemies: Agent[];
        shooter: Agent;
    }): Agent {
        return enemies
            .filter((enemy) => {
                const maxRange = shooter.metaData.optimalRange * 2;
                return this.getManhattanDistance(shooter.coordinates, enemy.coordinates) <= maxRange;
            })
            .map((enemy) => {
                const effectiveDamage = this.estimateEffectiveShotDamage({ shooter, shooterTarget: enemy });
                const canKill = this.canTargetBeKilledNow({ effectiveDamage, wetness: enemy.wetness });
                return { enemy, effectiveDamage, canKill };
            })
            .sort((a, b) => {
                // 1. Kill priority
                const killDiff = Number(b.canKill) - Number(a.canKill);
                if (killDiff !== 0)
                    return killDiff;

                // 2. Among killable targets, remove the biggest bomb threat first
                if (a.canKill && b.canKill) {
                    const bombDiff = b.enemy.splashBombs - a.enemy.splashBombs;
                    if (bombDiff !== 0)
                        return bombDiff;
                }

                // 3. Highest damage output
                const damageOutputDiff =
                    (b.enemy.wetness + b.effectiveDamage) -
                    (a.enemy.wetness + a.effectiveDamage);
                if (damageOutputDiff !== 0)
                    return damageOutputDiff;

                // 4. Remaining tie-breaker: bomb carriers
                return b.enemy.splashBombs - a.enemy.splashBombs;
            })
            [0]?.enemy;
    }

    // =============================================================================
    // SPLASH BOMBS
    // =============================================================================
    private getSplashZone(origin: Coordinates): Coordinates[] {
        return this.getTilesWithinChebyshevDistance({ origin, distance: 1 });
    }

    private isBombTargetInReach ({
        throwerPosition,
        targetPosition
    }: {
        throwerPosition: Coordinates;
        targetPosition: Coordinates;
    }): boolean {
        const MAX_DISTANCE = 4;
        const distance = this.getManhattanDistance(throwerPosition, targetPosition);
        return distance <= MAX_DISTANCE;
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
                let touchedEnemyBombs = 0;
                splashZone.forEach((tile) => {
                    allies.forEach((ally) => this.isSamePosition(ally.coordinates, tile) && touchedAllies.push(ally));
                    enemies.forEach((enemy) => {
                        if (this.isSamePosition(enemy.coordinates, tile)) {
                            touchedEnemies.push(enemy);
                            touchedEnemyBombs += enemy.splashBombs;
                        }
                    });
                });

                const willWasteBomb = (
                    // Do not throw bomb if there's only 1 enemy and they can be killed by shot
                    touchedEnemies.length === 1 && 
                    this.canTargetBeKilledNow({
                        effectiveDamage: this.estimateEffectiveShotDamage({ shooter: thrower, shooterTarget: touchedEnemies[0]}),
                        wetness: touchedEnemies[0].wetness
                    })
                );

                return {
                    target,
                    touchedAllies,
                    touchedAlliesCount: touchedAllies.length,
                    touchedEnemies: touchedEnemies.map((enemy) => `#${enemy.agentId}; ${enemy.coordinates.x}, ${enemy.coordinates.y}`),
                    touchedEnemiesCount: touchedEnemies.length,
                    touchedEnemyBombs,
                    killableEnemiesCount: touchedEnemies.filter((enemy) => enemy.wetness >= 70).length,
                    willWasteBomb
                };
            })
            .filter(({ touchedAlliesCount, touchedEnemiesCount, willWasteBomb }) =>
                // Skip bomb targets that would affect more than 1 ally
                touchedAlliesCount <= maxTouchedAllies &&
                // 'Touch 1 or more enemies' requirement
                touchedEnemiesCount >= minTouchedEnemies &&
                // Avoid wasting bombs
                !willWasteBomb
            )
            .sort((a, b) => {
                // Priority 1: hit the most enemies
                const touchedDiff = b.touchedEnemiesCount - a.touchedEnemiesCount;
                if (touchedDiff !== 0)
                    return touchedDiff;

                // Priority 2: kill enemies
                const killDiff = b.killableEnemiesCount - a.killableEnemiesCount;
                if (killDiff !== 0)
                    return killDiff; 
                
                // Priority 3: remove the highest bomb threat
                const bombDiff = b.touchedEnemyBombs - a.touchedEnemyBombs;
                if (bombDiff !== 0)
                    return bombDiff;

                // Minimize number of touched allies
                return a.touchedAlliesCount - b.touchedAlliesCount;
            })
            [0]?.target;
    }
}

class Agent {
    readonly agentId: number;
    readonly coordinates: Coordinates;
    readonly cooldown: number;
    readonly splashBombs: number;
    readonly wetness: number;
    readonly metaData: AgentMetaData;
    public actionService: AgentActionService;
    public behaviorPolicy: AgentBehaviorPolicy;

    constructor(props: AgentProps) {
        Object.assign(this, props);
        this.actionService = new AgentActionService(props.agentId);
    }

    public update(props: AgentProps) {
        Object.assign(this, props);
    }

    private getAgentVerticalSpreadPosition({
        origin,
        gameMap,
        alliesCount
    }: {
        origin: Coordinates;
        gameMap: GameMap;
        alliesCount: number;
    }): Coordinates {
        // Make n vertical groups
        const verticalSpreadPositions = gameMap.getVerticalSpreadPositions({ origin, count: alliesCount });

        // Distribute the allies in the groups by vertical proximity
        return verticalSpreadPositions.sort((a, b) =>
            Math.abs(this.coordinates.y - a.y) -
            Math.abs(this.coordinates.y - b.y)
        )[0];
    }

    /** Get the next move coordinates */
    private getAgentNextMove({
        formationRole,
        gameMap,
        allies,
        enemies,
        gameStrategy
    }: {
        formationRole: AgentBehaviorPolicy['formationRole'];
        gameMap: GameMap;
        allies: Agent[];
        enemies: Agent[];
        gameStrategy: GameStrategy
    }): Coordinates {
        let nextMove: Coordinates;
        
        const averageEnemiesPosition = gameMap.getAveragePosition(
            enemies.map((enemy) => enemy.coordinates)
        );
        const occupiedPositions = [...allies, ...enemies].map((agent) => agent.coordinates);

        switch (formationRole) {
            case 'frontline': {
                // === FRONTLINERS MOVE TOWARDS ENEMIES ===
                this.actionService.message(`${gameStrategy} - Pressing forward`);

                nextMove = averageEnemiesPosition;
                break;
            } case 'follower': {
                // === FOLLOWERS STAY BEHIND FRONTLINE ===
                this.actionService.message(`${gameStrategy} - Watching your back`);

                // Find next move
                // Add distance behind attackers
                const MIN_DISTANCE_FROM_ATTACKERS = 2;
                const frontliners = allies.filter((ally) => ally.behaviorPolicy.formationRole === 'frontline');
                const averageFrontlinePosition = (() => {
                    if (frontliners.length === 0) return this.coordinates; // N.B.: should not happen, there should always be at least 1 frontliner for an ally to have the follower role
                    if (frontliners.length === 1) return frontliners[0].coordinates;
                    return gameMap.getAveragePosition(frontliners.map((attacker) => attacker.coordinates));
                })();
                const areEnemiesGroupAtRightOfAllies = averageFrontlinePosition.x < averageEnemiesPosition.x;
                const behindAttackers = {
                    x: areEnemiesGroupAtRightOfAllies ?
                        // Add distance while keeping value in bounds
                        Math.max(0, averageFrontlinePosition.x - MIN_DISTANCE_FROM_ATTACKERS) :
                        Math.min(gameMap.width, averageFrontlinePosition.x + MIN_DISTANCE_FROM_ATTACKERS),
                    y: averageEnemiesPosition.y
                };

                nextMove = behindAttackers;
                break;
            }
        }

        // Create vertical ally groups to minimize splash damage impact
        const verticalSpread = this.getAgentVerticalSpreadPosition({
            origin: nextMove,
            alliesCount: allies.length,
            gameMap
        });

        // Look for closest cover around target position
        const MAX_COVER_DISTANCE_FROM_TARGET_POSITION = 3;
        const closestCoverAroundTargetPosition = gameMap.getIdealCoverNearby({
            maxDistance: MAX_COVER_DISTANCE_FROM_TARGET_POSITION,
            origin: verticalSpread,
            enemies,
            occupiedPositions
        });

        return gameMap.findNextStepOnShortestPath({
            target: closestCoverAroundTargetPosition,
            origin: this.coordinates,
            occupiedPositions
        });
    }

    /**
     * Choose what to do depending on the current agent behavior state
     * and execute actions
     */
    public decideActions({
        gameMap,
        allies,
        enemies,
        gameStrategy
    }: {
        gameMap: GameMap;
        allies: Agent[];
        enemies: Agent[];
        gameStrategy: GameStrategy;
    }): void {
        // === MOVE ACTION ===
        const nextMove = this.getAgentNextMove({
            formationRole: this.behaviorPolicy.formationRole,
            gameMap,
            allies,
            enemies,
            gameStrategy
        });
        this.actionService.move({
            currentPosition: this.coordinates,
            targetPosition: nextMove
        });

        // === BATTLE ACTION ===
        // Register battle actions from lowest to highest priority.
        // ActionService keeps only the last registered battle action.

        // 3rd priority: hunker down by default (potentially overridden by further action via actionService)
        this.actionService.hunkerDown();

        // 2nd priority: try to shoot
        const canShoot = this.cooldown === 0;
        if (canShoot) {
            const idealShootTarget = gameMap.getIdealShootTarget({
                shooter: this,
                enemies: enemies,
            });
            if (idealShootTarget) this.actionService.shoot(idealShootTarget.agentId);
        }

        // 1st priority: try to throw a bomb
        const hasBombs = this.splashBombs > 0;
        if (hasBombs) {
            const idealBombTarget = gameMap.getIdealBombTarget({
                thrower: this,
                allies: allies,
                enemies: enemies,
                maxTouchedAllies: this.behaviorPolicy.bombPolicy.allowFriendlyFire ? 1 : 0,
                minTouchedEnemies: this.behaviorPolicy.bombPolicy.requireEnemyCluster ? 2 : 1
            });
            if (idealBombTarget) this.actionService.throw(idealBombTarget);
        }

        // Execute actions
        this.actionService.executeActions();
    }
};

class AgentActionService {
    private readonly ACTION_TYPES: Record<AgentActionName, AgentAction['type']> = {
        [AgentActionName.MOVE]: { name: AgentActionName.MOVE, isBattleAction: false },
        [AgentActionName.MESSAGE]: { name: AgentActionName.MESSAGE, isBattleAction: false },
        [AgentActionName.HUNKER_DOWN]: { name: AgentActionName.HUNKER_DOWN, isBattleAction: true },
        [AgentActionName.SHOOT]: { name: AgentActionName.SHOOT, isBattleAction: true },
        [AgentActionName.THROW]: { name: AgentActionName.THROW, isBattleAction: true }
    };
    private readonly actions: AgentAction[] = [];

    constructor(private agentId: number) {}

    public move = ({ currentPosition, targetPosition }: { currentPosition: Coordinates; targetPosition: Coordinates; }) => {
        if (targetPosition.x === currentPosition.x && targetPosition.y === currentPosition.y) return this; // do not register any action if destination equals origin

        this.actions.push({
            type: this.ACTION_TYPES.MOVE,
            payload: `${targetPosition.x} ${targetPosition.y}`
        });
        return this;
    }

    public shoot = (id: number) => {
        this.actions.push({
            type: this.ACTION_TYPES.SHOOT,
            payload: id.toString()
        });
        return this;
    }

    public throw = ({ x, y }: Coordinates) => {
        this.actions.push({
            type: this.ACTION_TYPES.THROW,
            payload: `${x} ${y}`
        });
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

    /**
     * Battle actions are priority-ordered by registration.
     * The last registered battle action wins.
     */
    public executeActions = () => {
        // If multiple move actions have been registered, only use the latest one
        const moveAction = [...this.actions]
            .reverse()
            .find(action => action.type.name === AgentActionName.MOVE);

        // If multiple battle actions have been registered, only use the latest one
        const battleAction = [...this.actions]
            .reverse()
            .find(action => action.type.isBattleAction);

        const messages = this.actions.filter(
            action => action.type.name === AgentActionName.MESSAGE
        );

        const filteredActions = [
            moveAction,
            battleAction,
            ...messages
        ].filter(Boolean);

        if (!filteredActions.length) {
            // Always output a command to avoid forfeiting the turn
            console.log(`${this.agentId}; HUNKER_DOWN`);
            return;
        }

        // Execute registered actions then flush

        console.log(
            [
                this.agentId,
                ...filteredActions.map(action =>
                    [action?.type.name, action?.payload]
                        .filter(Boolean)
                        .join(' ')
                )
            ].join(';')
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