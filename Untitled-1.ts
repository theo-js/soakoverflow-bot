/**
 * Win the water fight by controlling the most territory, or out-soak your opponent!
 *
 * === CHANGELOG ===
 *
 * NOUVEAUTÉS (suite à ta demande) :
 * - Intent 'territory' implémenté (GameMap.computeControlledTilesCount, la
 *   vraie règle du jeu avec doublement de distance à wetness >= 50).
 * - Vérification de pertinence de `bestImmediateOpportunity` par rapport au
 *   PREMIER intent de la liste ordonnée (`isIntentSatisfied`). Si non
 *   pertinente : recherche d'une destination sur toute la carte adaptée à cet
 *   intent (`findBestDestinationForIntent`, scan complet de la grille), puis
 *   déplacement d'un pas vers elle (BFS existant), en ré-évaluant la
 *   meilleure action de combat depuis cette nouvelle case.
 * - `TurnContext` maintient deux listes simulées mutables (`simulatedAllies`,
 *   `simulatedEnemies`, type `AgentLike`), réinitialisées depuis les données
 *   réelles à chaque tour, et mises à jour par chaque agent après sa
 *   décision (nouvelle position, wetness des cibles touchées) afin que les
 *   agents suivants du même tour décident en connaissance de cause.
 * - `Game.playTurn` trie les agents avant de les faire décider : priorité à
 *   ceux ayant une opportunité de kill immédiate, puis aux plus proches d'un
 *   ennemi (`Agent.hasImmediateKillOpportunity`).
 * - `computeIntentPriority` calcule dynamiquement l'ordre des intents à
 *   partir du contexte local (propre wetness, engageabilité) et global
 *   (rapport de force en nombre d'agents vivants).
 */

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

/** 
 * Minimal data required for tactical evaluation.
 * Actual Agent instances satisfy its structure, so do "simulated" snapshots (mutable and methodless data objects).
 * This allows passing whether one or the other where only the data counts.
 */
type AgentLike = {
    agentId: number;
    coordinates: Coordinates;
    wetness: number;
    splashBombs: number;
    cooldown: number;
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
    agent: AgentLike;
    biggestPotentialDamage: number;
    canKill: boolean;
};
type TargetDamageEvaluation = {
    targetPosition: Coordinates;
    casualties: TargetDamageCasualty[];
};
type TargetDamageCasualty = {
    agent: AgentLike;
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
type TurnCandidateHunkerDown = TurnCandidateBase & {
    actionType: AgentActionName.HUNKER_DOWN;
    targetDamageEvaluation: undefined;
};
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

/** Gives info about which agent currently controls this tile */
type TileTerritoryControlSnapshot = {
    tile: GameMapGridTile;
    controlDistance: number;
    controlledBy: {
        agent: AgentLike;
        isEnemy: boolean;
    };
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

    /** Most tactically relevant allies should decide 1st */
    private getAlliesDecisionOrder(allies: Agent[], enemies: AgentLike[]): Agent[] {
        return [...allies].sort((a, b) => {
            // 1. Can kill immediately
            const aCanKill = Number(a.hasImmediateKillOpportunity({ enemies, gameMap: this.gameMap }));
            const bCanKill = Number(b.hasImmediateKillOpportunity({ enemies, gameMap: this.gameMap }));
            if (aCanKill !== bCanKill) return bCanKill - aCanKill;

            // 2. Closest to enemy
            const getClosestEnemyDistance = (agent: Agent) => enemies.length === 0
                ? Infinity
                : Math.min(...enemies.map((enemy) => this.gameMap.getManhattanDistance(agent.coordinates, enemy.coordinates)));
            const distanceDiff = getClosestEnemyDistance(a) - getClosestEnemyDistance(b);
            if (distanceDiff !== 0) return distanceDiff;

            return a.agentId - b.agentId; // tie-break stable
        });
    }

    public playTurn() {
        const allies = this.turnContext.aliveAllies;
        const decisionOrder = this.getAlliesDecisionOrder(allies, this.turnContext.enemiesSnapshot);

        // Let each ally decide what to do according to their internal decision engine
        decisionOrder.forEach((ally, index) => {
            ally.decideActions({
                /*
                    alliesSnapshot / enemiesSnapshot are mutated by each agent after their
                    decision, so subsequent agents in the same turn can anticipate the
                    updated positions/wetness of their teammates and the targets hit.
                */
                alliesSnapshot: this.turnContext.alliesSnapshot,
                enemiesSnapshot: this.turnContext.enemiesSnapshot,
                territoryControlSnapshot: this.turnContext.territoryControlSnapshot,
                gameMap: this.gameMap,
            });

            // Update territory control snapshot after each decision (except for the last one, as we want to avoid unnecessary expensive costs)
            const isLastToDecide = index === decisionOrder.length - 1;
            if (!isLastToDecide) this.turnContext.updateTerritoryControlSnapshot(this.gameMap);
        });
    }
}

class TurnContext {
    private readonly myId: number;
    private readonly allAgentsData: Map<number, AgentMetaData>;

    private currentGameTurn = 0;
    private aliveAgents: Agent[] = [];

    public get aliveAllies() {
        return this.aliveAgents.filter((agent) => agent.metaData?.playerId === this.myId);
    }

    public get aliveEnemies() {
        return this.aliveAgents.filter((agent) => agent.metaData?.playerId !== this.myId);
    }

    /**
     * Mutable allies snapshot, reset from the actual data at the start of each turn
     * and updated based on the decisions made by allies during that turn.
     */
    public alliesSnapshot: AgentLike[] = [];
    /**
     * Mutable enemies snapshot, reset from the actual data at the start of each turn
     * and updated based on the decisions made by allies during that turn.
     */
    public enemiesSnapshot: AgentLike[] = [];

    private _territoryControlSnapshot: TileTerritoryControlSnapshot[] = [];
    /**
     * Mutable territory control snapshot, updated based on :
     * - actual agents at the start of each turn
     * - new agent snapshots after every decision made by allies during that turn.
     */
    public get territoryControlSnapshot() {
        return this._territoryControlSnapshot;
    }

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

    private toAgentLike(agent: Agent): AgentLike {
        return {
            agentId: agent.agentId,
            coordinates: agent.coordinates,
            wetness: agent.wetness,
            splashBombs: agent.splashBombs,
            cooldown: agent.cooldown,
            metaData: agent.metaData
        };
    }

    public updateTerritoryControlSnapshot(gameMap: GameMap): void {
        this._territoryControlSnapshot = gameMap.buildTerritoryControlSnapshot({
            allies: this.alliesSnapshot,
            enemies: this.enemiesSnapshot
        });
    }

    public initTurn({
        aliveAgentPropsThisTurn,
        gameMap
    }: {
        aliveAgentPropsThisTurn: AgentProps[];
        gameMap: GameMap;
    }): void {
        this.currentGameTurn++;

        // Upsert each agent
        aliveAgentPropsThisTurn.forEach((agentProps) => this.upsertAgent(agentProps));

        // Remove eliminated agents
        this.aliveAgents = this.aliveAgents.filter(
            (aliveAgent) =>
                aliveAgentPropsThisTurn.some((agentProps) => agentProps.agentId === aliveAgent.agentId)
        );

        // Reset simulated state from real data at the start of each turn
        this.alliesSnapshot = this.aliveAllies.map((a) => this.toAgentLike(a));
        this.enemiesSnapshot = this.aliveEnemies.map((a) => this.toAgentLike(a));

        // Update territory control map and scores based on reliable agents positions
        this.updateTerritoryControlSnapshot(gameMap);
        this.updateScores();
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

    private getAdjacentTilesOf({ x, y }: Coordinates): { tile: GameMapGridTile; direction: Direction }[] {
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
                
                // and not already occupied by ANOTHER agent
                && !occupiedPositions
                    .filter((occupiedPosition) => !this.isSamePosition(occupiedPosition, origin)) // NB: caller must exclude their own position from occupiedPositions, otherwise 'stay on place' would always be rejected as 'occupied by self'
                    .some((occupiedPosByOther) => this.isSamePosition(occupiedPosByOther, tile))
            ));
    }

    public getAllWalkableTiles(): GameMapGridTile[] {
        return [...this.grid.values()].filter((tile) => tile.tileType === TileType.EMPTY);
    }

    public isSamePosition(posA: Coordinates, posB: Coordinates): boolean {
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

    // =============================================================================
    // TERRITORY CONTROL
    // =============================================================================
    /** 
     * Get the effective distance for tile control calculation.
     * According to the rules, it is doubled if the agent wetness >= 50
     */
    public getControlDistance({ agent, position }: { agent: AgentLike; position: Coordinates; }): number {
        const distance = this.getManhattanDistance(agent.coordinates, position);
        return agent.wetness >= 50 ? distance * 2 : distance;
    }

    /**
     * Builds a snapshot of territory control for given set of ally and enemy positions,
     * indicating for each tile which agent currently controls it and why.
     */
    public buildTerritoryControlSnapshot({ allies, enemies }: { allies: AgentLike[]; enemies: AgentLike[]; }) {
        return [...this.grid.values()].map((tile) =>
            [
                ...allies.map(agent => ({ agent, isEnemy: false })),
                ...enemies.map(agent => ({ agent, isEnemy: true }))
            ]
                .map(({ agent, isEnemy }) => ({
                    tile,
                    controlDistance: this.getControlDistance({ agent, position: tile }),
                    controlledBy: { agent, isEnemy }
                }))
                // Agent w/ shortest control distance owns the position
                .sort((a, b) => a.controlDistance - b.controlDistance)
                [0]
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
        shooter: { coordinates: Coordinates };
        shooterTarget: { coordinates: Coordinates };
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

    public isBombTargetInReach({
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
                const getKills = (tc: TurnCandidate) => tc.targetDamageEvaluation?.casualties.filter((c) => c.isKill)?.length ?? 0;
                const aKills = getKills(a);
                const bKills = getKills(b);
                const killDiff = bKills - aKills;
                if (killDiff !== 0)
                    return killDiff;

                // Among killable targets
                if (aKills > 0 && bKills > 0) {
                    // 2. Remove the biggest bomb threat first
                    const countSplashBombs = (tc: TurnCandidate) => tc.targetDamageEvaluation!.casualties
                        .filter((c) => c.isEnemy)
                        .reduce((bombs, c) => bombs + c.agent.splashBombs, 0);
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
                const getTotalDamageOutput = (tc: TurnCandidate) => tc.targetDamageEvaluation?.casualties.reduce((damage, c) => damage + c.effectiveDamage, 0) ?? 0;
                const damageOutputDiff = getTotalDamageOutput(b) - getTotalDamageOutput(a)
                if (damageOutputDiff !== 0)
                    return damageOutputDiff;

                // 2. Reduce overkill
                const getTotalOverkillOutput = (tc: TurnCandidate) => tc.targetDamageEvaluation?.casualties.reduce((damage, c) => damage + c.overkillWetness, 0) ?? 0;
                const overkillOutputDiff = getTotalOverkillOutput(a) - getTotalOverkillOutput(b)
                if (overkillOutputDiff !== 0)
                    return overkillOutputDiff;

                // 3. Bomb carriers
                const countSplashBombs = (tc: TurnCandidate) => tc.targetDamageEvaluation?.casualties
                    .filter((c) => c.isEnemy)
                    .reduce((bombs, c) => bombs + c.agent.splashBombs, 0) ?? 0; // FIX: idem, accumulateur ignoré avant
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
            territory: (a, b) => b.territoryCount - a.territoryCount
        };

    /**
     * Détermine l'ordre de priorité des intents pour ce tour, à partir du
     * contexte LOCAL (propre wetness, capacité à engager un ennemi) et GLOBAL
     * (rapport de force en nombre d'agents vivants). Heuristique de départ,
     * simple à retoucher (juste réordonner les tableaux retournés).
     */
    private computeIntentPriority({
        allies,
        enemies,
        gameMap
    }: {
        allies: AgentLike[];
        enemies: AgentLike[];
        gameMap: GameMap;
    }): AgentIntent[] {
        // --- Contexte local ---
        const isCriticallyWounded = this.wetness >= 50; // seuil de doublement de distance des règles ; aussi un bon cutoff de fragilité
        const closestEnemyDistance = enemies.length > 0
            ? Math.min(...enemies.map((enemy) => gameMap.getManhattanDistance(this.coordinates, enemy.coordinates)))
            : Infinity;
        const maxEngageableRange = this.metaData.optimalRange * 2;
        const isEnemyEngageable =
            closestEnemyDistance <= maxEngageableRange ||
            (this.splashBombs > 0 && closestEnemyDistance <= 5); // 4 (portée max) + 1 (rayon de la zone d'effet)

        // --- Contexte global ---
        const isOutnumbered = allies.length < enemies.length;

        // 1. Ne jamais ignorer une menace mortelle : la survie prime toujours en danger.
        if (isCriticallyWounded) {
            return ['survive', 'min-injuries', 'kill', 'max-damage', 'territory'];
        }

        // 2. En infériorité numérique, jouer prudent tout en restant utile au
        //    combat prime sur la contestation de territoire (difficile à tenir
        //    avec moins d'agents de toute façon).
        if (isOutnumbered) {
            return ['kill', 'survive', 'max-damage', 'min-injuries', 'territory'];
        }

        // 3. Aucun ennemi à portée : rien à tirer, le territoire est le seul
        //    levier que cet agent peut actionner utilement ce tour-ci.
        if (!isEnemyEngageable) {
            return ['territory', 'survive', 'min-injuries', 'max-damage', 'kill'];
        }

        // 4. Cas par défaut : priorité combat classique, le territoire vient
        //    en objectif secondaire une fois menaces/opportunités couvertes.
        return ['kill', 'max-damage', 'territory', 'survive', 'min-injuries'];
    }

    /**
     * Est-ce que ce candidat satisfait réellement le PREMIER intent de la
     * liste (l'objectif prioritaire de l'agent ce tour-ci) ? Si non, ce n'est
     * qu'un choix "par défaut" tie-breaké entre options équivalentes -- il
     * vaut mieux chercher une vraie destination ailleurs sur la carte plutôt
     * que d'exécuter ce choix arbitraire (c'est ce qui causait les
     * allers-retours : sans ce filtre, un choix creux était exécuté comme
     * s'il était pertinent).
     */
    private isIntentSatisfiedByBestImmediateOpportunity({
        intent,
        bestImmediateOpportunity: candidate,
    }: {
        intent: AgentIntent;
        bestImmediateOpportunity: TurnCandidate | undefined;
    }): boolean {
        if (!candidate) return false;
        switch (intent) {
            case 'kill':
                return (candidate.targetDamageEvaluation?.casualties.filter((c) => c.isKill).length ?? 0) > 0;
            case 'max-damage':
                return (candidate.targetDamageEvaluation?.casualties.reduce((sum, c) => sum + c.effectiveDamage, 0) ?? 0) > 0;
            case 'territory':
                return false;
            case 'survive':
                return !candidate.threatsEvaluation.some((t) => t.canKill);
            case 'min-injuries':
                return candidate.threatsEvaluation.reduce((sum, t) => sum + t.biggestPotentialDamage, 0) === 0;
        }
    }

    /** Valeur d'une position hypothétique (n'importe où sur la carte, pas
     * nécessairement adjacente) pour un intent donné. Réutilise les mêmes
     * briques que l'évaluation des combos immédiats. */
    private evaluatePositionForIntent({
        intent,
        position,
        allies,
        enemies,
        gameMap
    }: {
        intent: AgentIntent;
        position: Coordinates;
        allies: AgentLike[];
        enemies: AgentLike[];
        gameMap: GameMap;
        territor: TileTerritoryControlSnapshot[]
    }): number {
        const hypotheticalSelf: AgentLike = { ...this, coordinates: position };

        switch (intent) {
            case 'territory': {
                const projectedAllies = allies.map((ally) =>
                    ally.agentId === this.agentId ? { ...ally, coordinates: position } : ally
                );
                return gameMap.buildTerritoryControlSnapshot({ allies: projectedAllies, enemies: enemies });
            }
            case 'kill':
            case 'max-damage': {
                const shootEvaluations = this.evaluateShootingTargets({ shooter: hypotheticalSelf, enemies, gameMap });
                if (intent === 'kill') {
                    return shootEvaluations.some((evaluation) => evaluation.casualties.some((c) => c.isKill)) ? 1 : 0;
                }
                return Math.max(0, ...shootEvaluations.map((evaluation) =>
                    evaluation.casualties.reduce((sum, c) => sum + c.effectiveDamage, 0)
                ));
            }
            case 'survive':
            case 'min-injuries': {
                const threats = this.evaluateThreats({ ally: hypotheticalSelf, enemies, gameMap });
                if (intent === 'survive') {
                    return threats.some((t) => t.canKill) ? 0 : 1;
                }
                return -threats.reduce((sum, t) => sum + t.biggestPotentialDamage, 0);
            }
        }
    }

    /**
     * Search the whole map for the best destination, for a given intent.
     * Only used when no immediate combo really satisfies the 1st intent.
     */
    private findBestDestinationForIntent({
        intent,
        allies,
        enemies,
        gameMap
    }: {
        intent: AgentIntent;
        allies: AgentLike[];
        enemies: AgentLike[];
        gameMap: GameMap;
    }): Coordinates {
        let best: Coordinates = this.coordinates;
        let bestValue = -Infinity;

        gameMap.getAllWalkableTiles().forEach((tile) => {
            const value = this.evaluatePositionForIntent({ intent, position: tile, allies, enemies, gameMap });
            const isBetter = value > bestValue ||
                // Égalité stricte : préférer la case la plus proche (limite les trajets inutiles)
                (value === bestValue && gameMap.getManhattanDistance(this.coordinates, tile) < gameMap.getManhattanDistance(this.coordinates, best));

            if (isBetter) {
                bestValue = value;
                best = tile;
            }
        });

        return best;
    }

    /** Estimation rapide (utilisée uniquement pour ordonner la prise de
     * décision des agents en début de tour) : cet agent peut-il tuer un
     * ennemi dès ce tour, sans bouger ? */
    public hasImmediateKillOpportunity({
        enemies,
        gameMap
    }: {
        enemies: AgentLike[];
        gameMap: GameMap;
    }): boolean {
        const canShootKill = this.evaluateShootingTargets({ shooter: this, enemies, gameMap })
            .some((evaluation) => evaluation.casualties.some((c) => c.isKill));
        if (canShootKill) return true;

        return this.evaluateBombTargets({
            thrower: this,
            allies: [],
            enemies,
            gameMap,
            minTouchedEnemies: 1,
            maxTouchedAllies: Infinity
        }).some((evaluation) => evaluation.casualties.some((c) => c.isEnemy && c.isKill));
    }

    /** Decide what to do and execute actions */
    public decideActions({
        gameMap,
        alliesSnapshot: allies,
        enemiesSnapshot: enemies,
        territoryControlSnapshot
    }: {
        gameMap: GameMap;
        alliesSnapshot: AgentLike[];
        enemiesSnapshot: AgentLike[];
        territoryControlSnapshot: TileTerritoryControlSnapshot[];
    }): void {
        // Compute intents for the current turn
        const agentIntentPriority = this.computeIntentPriority({ allies, enemies, gameMap });
        const agentTopIntent = agentIntentPriority[0];

        let bestImmediateOpportunity: TurnCandidate | undefined;

        if (agentTopIntent !== 'territory') {
            // Search for immediate opportunities
            const moveCandidates = gameMap.getMoveCandidates({
                origin: this.coordinates,
                occupiedPositions: [...allies, ...enemies].map((agent) => agent.coordinates)
            });

            // Generate move/action candidates for this turn
            const turnCandidates: TurnCandidate[] = moveCandidates.flatMap((move) => {
                const movedAgent: AgentLike = { ...this, coordinates: move };
                const threatsEvaluation = this.evaluateThreats({ ally: movedAgent, enemies, gameMap });
                const projectedAllies = allies.map((ally) => ally.agentId === this.agentId ? movedAgent : ally);
                const territoryCount = gameMap.buildTerritoryControlSnapshot({ allies: projectedAllies, enemies: enemies });
                const turnCandidateBase: TurnCandidateBase = { move, threatsEvaluation, territoryCount };

                const turnCandidatesForThisMove: TurnCandidate[] = [
                    // Simulate throw actions
                    ...(
                        this.evaluateBombTargets({
                            thrower: movedAgent,
                            allies: projectedAllies,
                            enemies,
                            gameMap,
                            minTouchedEnemies: 1,
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
                    { ...turnCandidateBase, actionType: AgentActionName.HUNKER_DOWN, targetDamageEvaluation: undefined }
                ];
                return turnCandidatesForThisMove;
            });

            const intentPriorityHandlers = agentIntentPriority.map((intent) => this.intentPriorityHandlersRecord[intent]);
            const sortByIntentPriority = (candidates: TurnCandidate[]): TurnCandidate[] =>
                [...candidates].sort((a, b) => {
                    for (const intentPriorityHandler of intentPriorityHandlers) {
                        const result = intentPriorityHandler(a, b);
                        if (result !== 0) return result;
                    }
                    return 0;
                });

            // Find most relevant opportunity to the current intent
            bestImmediateOpportunity = sortByIntentPriority(turnCandidates)[0];
        }

        // Check relevance of bestImmediateOpportunity in regards to the FIRST intent
        // Si aucun combo immédiat (adjacent) ne satisfait vraiment l'objectif
        // prioritaire, chercher une destination sur toute la carte adaptée à
        // cet intent, et s'y diriger d'un pas (BFS), en ré-évaluant la
        // meilleure action de combat possible depuis cette nouvelle case.
        let chosenTurnCandidate: TurnCandidate = bestImmediateOpportunity;

        if (!this.isIntentSatisfiedByBestImmediateOpportunity({ intent: agentTopIntent, bestImmediateOpportunity })) {
            const idealDestination = this.findBestDestinationForIntent({ intent: agentTopIntent, allies, enemies, gameMap });
            const pathMove = gameMap.findNextStepOnShortestPath({
                origin: this.coordinates,
                target: idealDestination,
                occupiedPositions
            });

            const candidatesForPathMove = turnCandidates.filter((tc) => gameMap.isSamePosition(tc.move, pathMove));
            if (candidatesForPathMove.length > 0) {
                chosenTurnCandidate = sortByIntentPriority(candidatesForPathMove)[0];
            }
        }

        // Execute actions
        this.actionService.move({ currentPosition: this.coordinates, targetPosition: chosenTurnCandidate.move });
        switch (chosenTurnCandidate.actionType) {
            case AgentActionName.SHOOT:
                this.actionService.shoot(chosenTurnCandidate.targetDamageEvaluation.casualties[0]!.agent.agentId);
                break;
            case AgentActionName.THROW:
                this.actionService.throw(chosenTurnCandidate.targetDamageEvaluation.targetPosition);
                break;
            case AgentActionName.HUNKER_DOWN:
                this.actionService.hunkerDown();
                break;
        }

        this.actionService.executeActions();

        // Update allies/enemies turn state for allies deciding after me
        const mySimulatedEntry = allies.find((a) => a.agentId === this.agentId);
        if (mySimulatedEntry) mySimulatedEntry.coordinates = chosenTurnCandidate.move;

        chosenTurnCandidate.targetDamageEvaluation?.casualties.forEach((casualty) => {
            const list = casualty.isEnemy ? enemies : allies;
            const entry = list.find((a) => a.agentId === casualty.agent.agentId);
            if (entry) entry.wetness = casualty.ceiledResultingWetness;
        });
    }

    private evaluateCasualty({
        agent,
        isEnemy,
        effectiveDamage
    }: {
        agent: AgentLike;
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
        thrower: AgentLike;
        allies: AgentLike[];
        enemies: AgentLike[];
        minTouchedEnemies: number;
        maxTouchedAllies: number;
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
                // Skip bomb targets that would affect too many allies
                casualties.filter(({ isEnemy }) => !isEnemy).length <= maxTouchedAllies &&
                // Skip bomb target that would not affect enough enemies
                casualties.filter(({ isEnemy }) => isEnemy).length >= minTouchedEnemies
            );
    }

    // ======================================================================
    // SHOOTING
    // ======================================================================
    /**
     * N.B.: the enemy can still hunker down, which seems to be unpredictable.
     * TODO: most enemies are likely hunker down if they are under cooldown and don't have a throw opportunity ?
     * */
    private estimateEffectiveShootingDamage({
        shooter,
        shooterTarget,
        gameMap
    }: {
        shooter: AgentLike;
        shooterTarget: AgentLike;
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
            case TileType.HIGH_COVER: return baseDamage * 3 / 4;
            case TileType.LOW_COVER: return baseDamage / 2;
            default: return baseDamage;
        }
    }

    private evaluateShootingTargets({
        enemies,
        shooter,
        gameMap
    }: {
        enemies: AgentLike[];
        shooter: AgentLike;
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
            });
    }

    // ======================================================================
    // THREATS
    // ======================================================================
    private evaluateThreats({
        ally,
        enemies,
        gameMap
    }: {
        ally: AgentLike;
        enemies: AgentLike[];
        gameMap: GameMap;
    }): ThreatEvaluation[] {
        return enemies.map((enemy) => {
            const BOMB_DAMAGE = 30;
            const AGENT_FULL_HEALTH = 100;

            const canEnemyShoot = enemy.cooldown === 0;
            const shootingThreat = canEnemyShoot
                ? this.estimateEffectiveShootingDamage({ shooter: enemy, shooterTarget: ally, gameMap })
                : 0;

            const canEnemyThrowBomb = enemy.splashBombs > 0 && gameMap.isBombTargetInReach({ throwerPosition: enemy.coordinates, targetPosition: ally.coordinates });

            const biggestPotentialDamage = Math.max(
                shootingThreat,
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

    constructor(private agentId: number) { }

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