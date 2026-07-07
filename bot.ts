/**
 * Win the water fight by controlling the most territory, or out-soak your opponent!
 **/


declare function readline(): string;

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

type AgentIntent = 'kill' | 'max-damage' | 'survive' | 'min-injuries' | 'territory';

type ThreatEvaluation = {
    agent: Agent;
    biggestPotentialDamage: number;
    canKill: boolean;
};
type TargetDamageEvaluation = {
    targetPosition: Coordinates;
    casualties: TargetDamageCasualty[];
};
type TargetDamageCasualty = {
    agent: Agent;
    isEnemy: boolean;
    isKill: boolean;
    effectiveDamage: number;
    ceiledResultingWetness: number;
    overkillWetness: number;
};
type TurnCandidateBase = {
    move: Coordinates;
    threatsEvaluation: ThreatEvaluation[];
};
type TurnCandidateHunkerDown = TurnCandidateBase & { actionType: AgentActionName.HUNKER_DOWN };
type TurnCandidateAttack = TurnCandidateBase & {
    actionType: AgentActionName.SHOOT | AgentActionName.THROW;
    targetDamageEvaluation: TargetDamageEvaluation;
};
type TurnCandidate = TurnCandidateHunkerDown | TurnCandidateAttack;

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
    private readonly allAgentsData = new Map<number, AgentMetaData>;
    private turnContext: TurnContext;
    private readonly gameMap: GameMap;
    
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

        // Instanciate turn context
        this.turnContext = new TurnContext({
            myId: this.myId,
            allAgentsData: this.allAgentsData
        });
    }

    public readTurn() {
        const aliveAgentsCount: number = parseInt(readline()); // Total number of agents still in the game
        const aliveAgentPropsThisTurn: AgentProps[] = []; 
    
        for (let i = 0; i < aliveAgentsCount; i++) {
            var inputs: string[] = readline().split(' ');
            const agentId: number = parseInt(inputs[0]);
            const x: number = parseInt(inputs[1]);
            const y: number = parseInt(inputs[2]);
            const cooldown: number = parseInt(inputs[3]); // Number of turns before this agent can shoot
            const splashBombs: number = parseInt(inputs[4]);
            const wetness: number = parseInt(inputs[5]); // Damage (0-100) this agent has taken

            const metaData = this.allAgentsData.get(agentId); // Bind agent metadata
            if (!metaData) throw new Error(`Unknown agent ${agentId}`);

            aliveAgentPropsThisTurn.push({
                agentId,
                coordinates: { x, y },
                cooldown,
                splashBombs,
                wetness,
                metaData,
            });
        }
        const _myAgentCount: number = parseInt(readline()); // Number of alive agents controlled by you

        // Initialize this turn's context w/ input data
        this.turnContext.initTurn({ aliveAgentPropsThisTurn });
    }

    public playTurn() {
        // Let each ally decide what to do according to their internal behavior policy state
        this.turnContext.aliveAllies.forEach((ally) => {
            ally.decideActions({
                // Pass game data
                allies: this.turnContext.aliveAllies,
                enemies: this.turnContext.aliveEnemies,
                gameMap: this.gameMap,
            });
        });
    }
}

class TurnContext {
    private readonly myId: number;
    private readonly allAgentsData: Map<number, AgentMetaData>;
    
    private currentGameTurn = 0;
    private aliveAgents: Agent[] = [];

    constructor(turnContextProps: {
        myId: number;
        allAgentsData: Map<number, AgentMetaData>;
    }) {
        Object.assign(this, turnContextProps);
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

    public get aliveAllies() {
        return this.aliveAgents.filter((agent) => agent.metaData?.playerId === this.myId);
    }

    public get aliveEnemies() {
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

    public initTurn({
        aliveAgentPropsThisTurn
    }: {
        aliveAgentPropsThisTurn: AgentProps[];

    }): void {
        this.currentGameTurn++;

        // Upsert each agent
        aliveAgentPropsThisTurn.forEach((agentProps) => this.upsertAgent(agentProps));

        // Remove eliminated agents
        this.aliveAgents = this.aliveAgents.filter(
            (aliveAgent) => 
                aliveAgentPropsThisTurn.some((agentProps) => agentProps.agentId === aliveAgent.agentId)
        );
    }

    public finishTurn():void {}
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

    public getMoveCandidates({
        origin,
        occupiedPositions
    }: {
        origin: Coordinates;
        occupiedPositions: Coordinates[];
    }): GameMapGridTile[] {
        return [
            // Move candidate must be orthogonally adjacent or same position
            this.getTileAt(origin)!,
            ...this.getAdjacentTilesOf(origin).map(({ tile }) => tile)
        ]
            .filter((tile) => (
                // Move candidate must be walkable
                tile?.tileType === TileType.EMPTY
                && !occupiedPositions.some((occupiedPosition) => this.isSamePosition(occupiedPosition, tile))
            ));
    }

    public isSamePosition (posA: Coordinates, posB: Coordinates): boolean {
        return posA.x === posB.x && posA.y === posB.y;
    }

    public getManhattanDistance(a: Coordinates, b: Coordinates): number {
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

    // public getAveragePosition(positions: Coordinates[]): Coordinates {
    //     const sum = positions.reduce<Coordinates>(
    //         (sum, position) => ({ x: sum.x + position.x, y: sum.y + position.y }),
    //         { x: 0, y: 0 }
    //     );
    //     return {
    //         x: Math.round(sum.x / positions.length),
    //         y: Math.round(sum.y / positions.length)
    //     };
    // }

    // public getCloserAgentTo({
    //     agents,
    //     closerTo
    // }: {
    //     agents: Agent[];
    //     closerTo: Coordinates[];
    // }): Agent {
    //     const closerToPosition = this.getAveragePosition(closerTo);
    //     return agents
    //         .map((agent) => ({
    //             agent,
    //             distanceFromOrigin: this.getManhattanDistance(agent.coordinates, closerToPosition)
    //         }))
    //         .sort((a, b) => a.distanceFromOrigin - b.distanceFromOrigin) // ASC
    //         [0].agent;
    // }

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

    public calculateProtectionTypeAgainstShooter({
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

    public getSplashZone(origin: Coordinates): Coordinates[] {
        return this.getTilesWithinChebyshevDistance({ origin, distance: 1 });
    }

    public isBombTargetInReach ({
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

    public getAreaReachableByBomb(throwerPosition: Coordinates): GameMapGridTile[] {
        return [...this.grid.values()]
            .filter((targetPosition) => this.isBombTargetInReach({ throwerPosition, targetPosition }));
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

    constructor(props: AgentProps) {
        Object.assign(this, props);
        this.actionService = new AgentActionService(props.agentId);
    }

    public update(props: AgentProps) {
        Object.assign(this, props);
    }

    private readonly intentPriorityHandlersRecord: Record<
        AgentIntent,
        (a: TurnCandidate, b: TurnCandidate) => number
    > = {
        kill: (a, b) => {
            // 1. Number of kills
            const getKills = (tc: TurnCandidate) => tc.targetDamageEvaluation?.casualties?.filter((c) => c.isKill)?.length ?? 0;
            const aKills = getKills(a);
            const bKills = getKills(b);
            const killDiff = bKills - aKills;
            if (killDiff !== 0)
                return killDiff;

            // Among killable targets
            if (aKills > 0 && bKills > 0) {
                // 2. Remove the biggest bomb threat first
                const countSplashBombs = (tc: TurnCandidate) => tc.targetDamageEvaluation!.casualties.reduce((bombs, c) => c.agent.splashBombs, 0);
                const bombDiff = countSplashBombs(b) - countSplashBombs(a);
                if (bombDiff !== 0)
                    return bombDiff;

                // 3. Prefer killing w/ a shot to spare bombs
                const getActionScore = (tc: TurnCandidate) => tc.actionType === AgentActionName.SHOOT ? 1 : 0;
                const actionDiff = getActionScore(b) - getActionScore(a);
                if (actionDiff !== 0)
                    return actionDiff;
            }

            return 0;
        },
        'max-damage': (a, b) => {
            // 1. Highest damage output
            const getTotalDamageOutput = (tc: TurnCandidate) => tc.targetDamageEvaluation?.casualties?.reduce((damage, c) => damage + c.effectiveDamage, 0) ?? 0;
            const damageOutputDiff = getTotalDamageOutput(b) - getTotalDamageOutput(a)
            if (damageOutputDiff !== 0)
                return damageOutputDiff;

            // 2. Reduce overkill
            const getTotalOverkillOutput = (tc: TurnCandidate) => tc.targetDamageEvaluation?.casualties?.reduce((damage, c) => damage + c.overkillWetness, 0) ?? 0;
            const overkillOutputDiff = getTotalOverkillOutput(a) - getTotalOverkillOutput(b)
            if (overkillOutputDiff !== 0)
                return overkillOutputDiff;


            // 3. Bomb carriers
            const countSplashBombs = (tc: TurnCandidate) => tc.targetDamageEvaluation!.casualties.reduce((bombs, c) => c.agent.splashBombs, 0);
                const bombDiff = countSplashBombs(b) - countSplashBombs(a);
                if (bombDiff !== 0)
                    return bombDiff;

            return 0;
        },
        survive: (a, b) => {
            // Avoid deathly threats
            const countDeathlyThreats = (tc: TurnCandidate) => tc.threatsEvaluation.filter((t) => t.canKill).length;
            return countDeathlyThreats(a) - countDeathlyThreats(b);
        },
        'min-injuries': (a, b) => {
            // Reduce damage risk
            const calculateTotalDamageRisk = (tc: TurnCandidate) => tc.threatsEvaluation.reduce((total, threat) => total + threat.biggestPotentialDamage, 0);
            return calculateTotalDamageRisk(a) - calculateTotalDamageRisk(b);
        },
        territory: (a, b) => 0 // TODO: implement this
    };

    // private getAgentVerticalSpreadPosition({
    //     origin,
    //     gameMap,
    //     alliesCount
    // }: {
    //     origin: Coordinates;
    //     gameMap: GameMap;
    //     alliesCount: number;
    // }): Coordinates {
    //     // Make n vertical groups
    //     const verticalSpreadPositions = gameMap.getVerticalSpreadPositions({ origin, count: alliesCount });

    //     // Distribute the allies in the groups by vertical proximity
    //     return verticalSpreadPositions.sort((a, b) =>
    //         Math.abs(this.coordinates.y - a.y) -
    //         Math.abs(this.coordinates.y - b.y)
    //     )[0];
    // }

    /** Get the next move coordinates */
    // private getAgentNextMove({
    //     gameMap,
    //     allies,
    //     enemies,
    // }: {
    //     gameMap: GameMap;
    //     allies: Agent[];
    //     enemies: Agent[];
    // }): Coordinates {
    //     let nextMove: Coordinates;
        
    //     const averageEnemiesPosition = gameMap.getAveragePosition(
    //         enemies.map((enemy) => enemy.coordinates)
    //     );
    //     const occupiedPositions = [...allies, ...enemies].map((agent) => agent.coordinates);

    //     // Create vertical ally groups to minimize splash damage impact
    //     const verticalSpread = this.getAgentVerticalSpreadPosition({
    //         origin: nextMove,
    //         alliesCount: allies.length,
    //         gameMap
    //     });

    //     // Look for closest cover around target position
    //     const MAX_COVER_DISTANCE_FROM_TARGET_POSITION = 3;
    //     const closestCoverAroundTargetPosition = gameMap.evaluateCoverPosition({
    //         maxDistance: MAX_COVER_DISTANCE_FROM_TARGET_POSITION,
    //         position: verticalSpread,
    //         enemies,
    //         occupiedPositions
    //     });

    //     return gameMap.findNextStepOnShortestPath({
    //         target: closestCoverAroundTargetPosition,
    //         origin: this.coordinates,
    //         occupiedPositions
    //     });
    // }

    /**
     * Determine agent's intent priority for this turn.
     * The intent relies on both the global tactical context and this agent's local situation
     */
    private computeIntentPriority(): AgentIntent[] {
        return ['kill', 'max-damage', 'territory', 'survive']; // TODO: implement method
    }

    /** Choose what to do and execute actions */
    public decideActions({
        gameMap,
        allies,
        enemies,
    }: {
        gameMap: GameMap;
        allies: Agent[];
        enemies: Agent[];
    }): void {
        // Compute intent
        const agentIntentPriority = this.computeIntentPriority();

        // === SEARCH FOR IMMEDIATE OPPORTUNITIES  ===
        const moveCandidates = gameMap.getMoveCandidates({
            origin: this.coordinates,
            occupiedPositions: [...allies, ...enemies].map(({ coordinates }) => coordinates) // TODO: take into account pending ally moves
        });

        // Generate move/action candidates for this turn
        const turnCandidates: TurnCandidate[] = moveCandidates.flatMap((move) => {
            const movedAgent = { ...this, coordinates: move };
            const threatsEvaluation = this.evaluateThreats({ ally: movedAgent, enemies, gameMap })
            const turnCandidateBase: TurnCandidateBase = { move, threatsEvaluation };

            const turnCandidatesForThisMove: TurnCandidate[] = [
                // Simulate throw actions
                ...(
                    this.evaluateBombTargets({
                        thrower: movedAgent,
                        allies,
                        enemies,
                        gameMap,
                        minTouchedEnemies: 1, // TODO: use dynamic parameters ?
                        maxTouchedAllies: 0
                    })
                        .map((targetDamageEvaluation): TurnCandidateAttack => ({
                            ...turnCandidateBase,
                            actionType: AgentActionName.THROW,
                            targetDamageEvaluation,
                        }))
                ),

                // Simulate shooting actions
                ...(
                    this.evaluateShootingTargets({
                        shooter: movedAgent,
                        enemies, gameMap
                    })
                        .map((targetDamageEvaluation): TurnCandidateAttack => ({
                            ...turnCandidateBase,
                            actionType: AgentActionName.SHOOT,
                            targetDamageEvaluation
                        }))
                ),

                // Hunker down
                { ...turnCandidateBase, actionType: AgentActionName.HUNKER_DOWN }
            ];
            return turnCandidatesForThisMove;
        });

        // Find most relevant opportunity to the current intent
        const intentPriorityHandlers = agentIntentPriority.map((intent) => this.intentPriorityHandlersRecord[intent]);
        const bestImmediateOpportunity = turnCandidates.sort((a, b) => {
            for (const intentPriorityHandler of intentPriorityHandlers) {
                const result = intentPriorityHandler(a, b);
                if (result !== 0) return result;
            }

            return 0;
        })[0];
        
        // No immediate opportunity found => search for an ideal destination

        // Execute actions
        this.actionService.move({ currentPosition: this.coordinates, targetPosition: bestImmediateOpportunity.move });
        switch(bestImmediateOpportunity.actionType) {
            case AgentActionName.SHOOT:
                this.actionService.shoot(bestImmediateOpportunity.targetDamageEvaluation.casualties[0]!.agent.agentId);
            case AgentActionName.THROW:
                this.actionService.throw(bestImmediateOpportunity.targetDamageEvaluation.targetPosition);
            case AgentActionName.HUNKER_DOWN:
                this.actionService.hunkerDown();
        }

        this.actionService.executeActions();
    }

    private evaluateCasualty({
        agent,
        isEnemy,
        effectiveDamage
    }: {
        agent: Agent;
        isEnemy: boolean;
        effectiveDamage: number;
    }): TargetDamageCasualty {
        const AGENT_FULL_HEALTH = 100;
        const resultingWetness = agent.wetness + effectiveDamage;
        return {
            agent,
            isEnemy,
            effectiveDamage,
            ceiledResultingWetness: Math.min(AGENT_FULL_HEALTH, resultingWetness),
            isKill: resultingWetness >= AGENT_FULL_HEALTH,
            overkillWetness: Math.max(0, resultingWetness - AGENT_FULL_HEALTH)
        }
    }

    // ======================================================================
    // BOMBS
    // ======================================================================
    private evaluateBombTargets({
        gameMap,
        thrower,
        allies,
        enemies,
        minTouchedEnemies,
        maxTouchedAllies
    }: {
        gameMap: GameMap;
        thrower: Agent;
        allies: Agent[];
        enemies: Agent[];
        minTouchedEnemies: number;
        maxTouchedAllies:  number;
    }): TargetDamageEvaluation[] {
        if (this.splashBombs === 0) return []; // Thrower does not carry any bombs

        return gameMap.getAreaReachableByBomb(thrower.coordinates).map((target) => {
            // Look for casualties within the splash zone and evaluate damage
            const casualties: TargetDamageCasualty[] = [];
            const agentLists = [
                { isEnemy: false, agents: allies }, 
                { isEnemy: true, agents: enemies }
            ];
            const splashZone = gameMap.getSplashZone(target);

            splashZone.forEach((tile) => {
                agentLists.forEach(({ isEnemy, agents }) => {
                    agents.forEach((agent) => {
                        if (!gameMap.isSamePosition(agent.coordinates, tile)) return;

                        // Agent is within splashzone
                        const BOMB_DAMAGE = 30; // should be defined in the Game class, but we'll simplify
                        casualties.push(this.evaluateCasualty({
                            agent,
                            isEnemy,
                            effectiveDamage: BOMB_DAMAGE
                        }));
                    });
                });
            });

            const damageEvaluation: TargetDamageEvaluation = {
                targetPosition: target,
                casualties
            };
            return damageEvaluation;
        })
        .filter(({ casualties }) =>
            // Skip bomb targets that would affect more than 1 ally
            casualties.filter(({ isEnemy }) => !isEnemy).length <= maxTouchedAllies &&
            // 'Touch 1 or more enemies' requirement
            casualties.filter(({ isEnemy }) => isEnemy).length >= minTouchedEnemies
        )
        // .sort((a, b) => {
        //     // Priority 1: hit the most enemies
        //     const touchedDiff = b.touchedEnemiesCount - a.touchedEnemiesCount;
        //     if (touchedDiff !== 0)
        //         return touchedDiff;

        //     // Priority 2: kill enemies
        //     const killDiff = b.killableEnemiesCount - a.killableEnemiesCount;
        //     if (killDiff !== 0)
        //         return killDiff; 
            
        //     // Priority 3: remove the highest bomb threat
        //     const bombDiff = b.touchedEnemyBombs - a.touchedEnemyBombs;
        //     if (bombDiff !== 0)
        //         return bombDiff;

        //     // Minimize number of touched allies
        //     return a.touchedAlliesCount - b.touchedAlliesCount;
        // })
        // [0];
    }

    // ======================================================================
    // SHOOTING
    // ======================================================================
    /**
     * N.B.: the enemy can still hunker down, which seems to be unpredictable.
     * TODO: most enemies are likely hunker down if they are under cooldown and don't have a throw opportunity ?
     * */
    private estimateEffectiveShootingDamage ({
        shooter,
        shooterTarget,
        gameMap
    }: {
        shooter: Agent;
        shooterTarget: Agent;
        gameMap: GameMap;
    }): number {
        const distanceFromShooter = gameMap.getManhattanDistance(shooterTarget.coordinates, shooter.coordinates);
        const baseDamage = (() => {
            if (distanceFromShooter <= shooter.metaData.optimalRange) return shooter.metaData.soakingPower;
            if (distanceFromShooter <= shooter.metaData.optimalRange * 2) return shooter.metaData.soakingPower / 2;
            return 0;
        })();

        const targetCover = gameMap.calculateProtectionTypeAgainstShooter({ shooter, shooterTarget });
        switch (targetCover) {
            case TileType.HIGH_COVER: return baseDamage * 3/4;
            case TileType.LOW_COVER: return baseDamage / 2;
            default: return baseDamage;
        }
    }

    private evaluateShootingTargets({
        enemies,
        shooter,
        gameMap
    }: {
        enemies: Agent[];
        shooter: Agent;
        gameMap: GameMap;
    }): TargetDamageEvaluation[] {
        if (this.cooldown > 0) return []; // Shooter is not ready to shoot now

        return enemies
            .filter((enemy) => {
                // Do not consider targets that are out of range
                const maxRange = shooter.metaData.optimalRange * 2;
                return gameMap.getManhattanDistance(shooter.coordinates, enemy.coordinates) <= maxRange;
            })
            .map((enemy) => {
                const effectiveDamage = this.estimateEffectiveShootingDamage({ shooter, shooterTarget: enemy, gameMap });
                return {
                    targetPosition: enemy.coordinates,
                    casualties: [this.evaluateCasualty({ agent: enemy, isEnemy: true, effectiveDamage })]
                }
            })
            // .sort((a, b) => {
            //     // 1. Kill priority
            //     const killDiff = Number(b.canKill) - Number(a.canKill);
            //     if (killDiff !== 0)
            //         return killDiff;

            //     // 2. Among killable targets, remove the biggest bomb threat first
            //     if (a.canKill && b.canKill) {
            //         const bombDiff = b.enemy.splashBombs - a.enemy.splashBombs;
            //         if (bombDiff !== 0)
            //             return bombDiff;
            //     }

            //     // 3. Highest damage output
            //     const damageOutputDiff =
            //         (b.enemy.wetness + b.effectiveDamage) -
            //         (a.enemy.wetness + a.effectiveDamage);
            //     if (damageOutputDiff !== 0)
            //         return damageOutputDiff;

            //     // 4. Remaining tie-breaker: bomb carriers
            //     return b.enemy.splashBombs - a.enemy.splashBombs;
            // })
    }

    // ======================================================================
    // THREATS
    // ======================================================================
    private evaluateThreats({
        ally,
        enemies,
        gameMap
    }: {
        ally: Agent;
        enemies: Agent[];
        gameMap: GameMap;
    }): ThreatEvaluation[] {
        return enemies.map((enemy) => {
            const BOMB_DAMAGE = 30;
            const AGENT_FULL_HEALTH = 100;

            const canEnemyThrowBomb = enemy.splashBombs > 0 && gameMap.isBombTargetInReach({ throwerPosition: enemy.coordinates, targetPosition: ally.coordinates });

            const biggestPotentialDamage = Math.max(
                this.estimateEffectiveShootingDamage({ shooter: enemy, shooterTarget: ally, gameMap }),
                canEnemyThrowBomb ? BOMB_DAMAGE : 0
            );
            const canKill = ally.wetness + biggestPotentialDamage >= AGENT_FULL_HEALTH;

            return { agent: enemy, biggestPotentialDamage, canKill };
        });
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