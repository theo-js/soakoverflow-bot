/**
 * Win the water fight by controlling the most territory, or out-soak your opponent!
 *
 * === CHANGELOG (version "Gold") ===
 * - FIX: bug de tri dans getIdealCoverNearby (protectionDiff jamais utilisé)
 * - FIX: off-by-one sur la borne width dans le positionnement "follower"
 * - NEW: rôle "controller" -> des agents dédiés au contrôle de territoire
 *   (se placent sur la ligne de front médiane, étalés verticalement, au lieu
 *   de foncer sur l'ennemi ou de reculer bêtement)
 * - NEW: "frontline" s'arrête à optimalRange de la cible au lieu de foncer
 *   jusqu'à la position moyenne ennemie (évite de s'exposer inutilement)
 * - NEW: si un agent est déjà idéalement placé (à portée + sous couverture),
 *   il ne bouge plus (évite de perdre le bonus de couverture pour rien)
 * - NEW: meilleure priorisation des cibles de tir (ratio dégâts/cooldown,
 *   évite l'overkill sur une cible déjà condamnée par un allié)
 */

enum GameStrategy {
    /** Throw weak ally at enemies to lure them & make them waste bombs */
    BAIT = 'bait',
    /** Focus on killing enemies as quick as possible */
    FOCUS_FIRE = 'focus-fire'
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
type AgentMetaData = AgentIdentity & AgentStats;

type AgentBehaviorPolicyType = 'riskSeeker' | 'conservativeFollower' | 'conservativeAttacker' | 'territoryController';
type AgentFormationRole = 'frontline' | 'follower' | 'harass-bomb-owners' | 'controller';
type AgentBehaviorPolicy = {
    type: AgentBehaviorPolicyType;
    formationRole: AgentFormationRole;
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

type Cover = {
    tile: GameMapGridTile;
    obstacles: CoverObstacle[];
};
type CoverObstacle = {
    coverAt: Direction;
    tile: GameMapGridTile;
    protectedAgainst: Coordinates[]
}

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
            formationRole: 'harass-bomb-owners',
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
        },
        territoryController: {
            type: 'territoryController',
            formationRole: 'controller',
            bombPolicy: { allowFriendlyFire: false, requireEnemyCluster: true },
            coverPolicy: { shouldSearchCover: true, coverSearchRadius: 3 }
        }
    };

    constructor() {
        this.myId = parseInt(readline());

        (() => {
            const agentsDataCount: number = parseInt(readline());
            for (let i = 0; i < agentsDataCount; i++) {
                var inputs: string[] = readline().split(' ');
                const agentId: number = parseInt(inputs[0]);
                const playerId: number = parseInt(inputs[1]);
                const shootCooldown: number = parseInt(inputs[2]);
                const optimalRange: number = parseInt(inputs[3]);
                const soakingPower: number = parseInt(inputs[4]);
                const splashBombs: number = parseInt(inputs[5]);

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
                const bombsDiff = a.splashBombs - b.splashBombs;
                if (bombsDiff !== 0) return bombsDiff;

                const soakingDiff = a.metaData.soakingPower - b.metaData.soakingPower;
                if (soakingDiff !== 0) return soakingDiff;

                const rangeDiff = a.metaData.optimalRange - b.metaData.optimalRange;
                if (rangeDiff !== 0) return rangeDiff;

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

        if (existingAgent) return existingAgent.update(agentProps);

        const newAgent = new Agent(agentProps);
        this.aliveAgents.push(newAgent);
    }

    private selectStrategy(): GameStrategy {
        if (
            this.totalEnemyBombs >= 3 &&
            this.gameMap.obstaclesPercentage < 10 &&
            this.aliveAlliesPercentage > 2 / 3 * 100
        )
            return GameStrategy.BAIT;

        return GameStrategy.FOCUS_FIRE;
    }

    /**
     * Assigne les rôles en tenant compte du contrôle de territoire :
     * on garde toujours 1 à 2 agents dédiés à tenir la ligne médiane
     * (rôle "controller") plutôt que de tout jeter dans le combat frontal.
     */
    private assignBehaviorsForStrategy(strategy: GameStrategy): void {
        const allies = this.aliveAllies;

        switch (strategy) {
            case GameStrategy.BAIT:
            case GameStrategy.FOCUS_FIRE: {
                allies.forEach((ally, index) => {
                    // Sur 3 agents ou plus, on garde ~1/3 de l'équipe sur le contrôle
                    // de territoire pour ne pas sacrifier les points de zone.
                    const shouldControlTerritory = allies.length >= 3 && index % 3 === 2;
                    ally.behaviorPolicy = shouldControlTerritory
                        ? this.AGENT_BEHAVIOR_POLICIES.territoryController
                        : this.AGENT_BEHAVIOR_POLICIES.conservativeAttacker;
                });
                break;
            }
            // case GameStrategy.BAIT: {
            //     allies.forEach((ally) => {
            //         if (ally.agentId === this.allyWithLowestStats.agentId) ally.behaviorPolicy = this.AGENT_BEHAVIOR_POLICIES.riskSeeker;
            //         else ally.behaviorPolicy = this.AGENT_BEHAVIOR_POLICIES.conservativeFollower;
            //     });
            // }
        }
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

            const agentProps: Omit<AgentProps, 'behavior'> = {
                agentId,
                coordinates: { x, y },
                cooldown,
                splashBombs,
                wetness,
                metaData,
            };

            this.upsertAgent(agentProps);
        }
        const _myAgentCount: number = parseInt(readline());

        this.aliveAgents = this.aliveAgents.filter(({ agentId }) => aliveAgentIdsThisTurn.has(agentId));
    }

    public playTurn() {
        this.currentGameTurn++;

        // On réévalue les rôles à CHAQUE tour (pas seulement au changement de
        // stratégie) car le nombre d'agents vivants change au fil des combats,
        // et donc l'équilibre attaque/contrôle-territoire doit suivre.
        const strategy = this.selectStrategy();
        this.currentStrategy = strategy;
        this.assignBehaviorsForStrategy(strategy);

        this.aliveAllies.forEach((ally) => {
            ally.decideActions({
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
        this.width = parseInt(inputs[0]);
        this.height = parseInt(inputs[1]);

        for (let i = 0; i < this.height; i++) {
            var inputs: string[] = readline().split(' ');
            for (let j = 0; j < this.width; j++) {
                const x: number = parseInt(inputs[3 * j]);
                const y: number = parseInt(inputs[3 * j + 1]);
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
        ].filter(({ tile }) => Boolean(tile));
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
            .sort((a, b) => a.distanceFromOrigin - b.distanceFromOrigin)
            [0].agent;
    }

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

    /**
     * Position "de contrôle de territoire" : sur la ligne verticale médiane
     * entre le barycentre des alliés et celui des ennemis, clampée pour
     * rester dans la grille. Tenir cette ligne maximise le nombre de cases
     * plus proches de nous que de l'adversaire (le vrai critère de score).
     */
    public getFrontierX(myAveragePosition: Coordinates, enemyAveragePosition: Coordinates): number {
        const midX = Math.round((myAveragePosition.x + enemyAveragePosition.x) / 2);
        return Math.max(0, Math.min(this.width - 1, midX));
    }

    public get obstaclesPercentage() {
        const tiles = [...this.grid.values()];
        const obstacles = tiles.filter(({ tileType }) => tileType !== TileType.EMPTY);
        return obstacles.length / tiles.length * 100;
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
                const hasDuplicate = Boolean(duplicate);
                if (!hasDuplicate) {
                    covers.set(coordinatesKey, cover);
                    return covers;
                }

                const mergedDuplicates: Cover = {
                    tile: cover.tile,
                    obstacles: [...duplicate?.obstacles ?? [], ...cover.obstacles]
                }
                covers.set(coordinatesKey, mergedDuplicates);
                return covers
            },
            new Map()
        );

        this.covers = [...coversMap.values()];
    }

    public isTileCover(position: Coordinates): boolean {
        return this.covers.some((cover) => this.isSamePosition(cover.tile, position));
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
        const moveCandidates = this.getTilesWithinChebyshevDistance({ origin, distance: maxDistance })
            .filter((moveCandidate) => (
                !occupiedPositions.some((occupiedPosition) =>
                    this.isSamePosition(moveCandidate, occupiedPosition)
                )
                && moveCandidate.tileType === TileType.EMPTY
            ));

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

                // 2nd priority: highest protection level (FIX: comparait la mauvaise variable avant)
                const protectionDiff = (b.protectionType ?? TileType.EMPTY) - (a.protectionType ?? TileType.EMPTY);
                if (protectionDiff !== 0) return protectionDiff;

                // 3rd priority: blocks the most enemies
                const blockedDiff = (b.blockedEnemiesCount ?? 0) - (a.blockedEnemiesCount ?? 0);
                return blockedDiff;
            })
            [0]?.moveCandidate ?? origin;
    }

    private getCoverTotalProtectionZone(cover: Cover): ProtectionZone {
        if (cover.obstacles.length === 1) return {
            zone: cover.obstacles[0].protectedAgainst,
            protectionType: cover.obstacles[0].tile.tileType
        };

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
        const cover = this.covers.find((cover) => this.isSamePosition(cover.tile, position));
        if (!cover) return 0;

        const protectionZone = this.getCoverTotalProtectionZone(cover);

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

        const obstacleNeighbors = this.getTilesWithinChebyshevDistance({
            origin: obstaclePosition,
            distance: 1
        });

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
        if (!targetCover) return TileType.EMPTY;

        const targetProtectionZone = this.getCoverTotalProtectionZone(targetCover);
        return targetProtectionZone.zone.some((tile) => this.isSamePosition(shooter.coordinates, tile))
            ? targetProtectionZone.protectionType
            : TileType.EMPTY
    }

    // =============================================================================
    // SHOOTING
    // =============================================================================
    public estimateEffectiveShotDamage({
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
            case TileType.HIGH_COVER: return baseDamage * 3 / 4;
            case TileType.LOW_COVER: return baseDamage / 2;
            default: return baseDamage;
        }
    }

    private canTargetBeKilledNow(params: { effectiveDamage: number; wetness: number; }): boolean {
        return params.wetness + params.effectiveDamage >= 100;
    }

    /**
     * Choix de cible amélioré :
     * - priorité aux kills (et parmi les kills, celui qui porte le plus de bombes)
     * - sinon, on privilégie le ratio dégâts/cooldown (efficacité du tir)
     * - on évite le sur-kill : si un allié peut déjà tuer la cible, on ne
     *   "gaspille" pas un second agent dessus s'il existe une autre cible utile
     */
    public getIdealShootTarget({
        enemies,
        shooter,
        alreadyLethalTargets = new Set<number>()
    }: {
        enemies: Agent[];
        shooter: Agent;
        alreadyLethalTargets?: Set<number>;
    }): Agent {
        const candidates = enemies
            .filter((enemy) => {
                const maxRange = shooter.metaData.optimalRange * 2;
                return this.getManhattanDistance(shooter.coordinates, enemy.coordinates) <= maxRange;
            })
            .map((enemy) => {
                const effectiveDamage = this.estimateEffectiveShotDamage({ shooter, shooterTarget: enemy });
                const canKill = this.canTargetBeKilledNow({ effectiveDamage, wetness: enemy.wetness });
                const alreadyDoomed = alreadyLethalTargets.has(enemy.agentId);
                return { enemy, effectiveDamage, canKill, alreadyDoomed };
            });

        const sorted = candidates.sort((a, b) => {
            // 1. Ne pas gaspiller un tir sur une cible déjà condamnée par un allié,
            //    sauf s'il n'y a rien de mieux à faire
            const wasteDiff = Number(a.alreadyDoomed) - Number(b.alreadyDoomed);
            if (wasteDiff !== 0) return wasteDiff;

            // 2. Priorité aux kills
            const killDiff = Number(b.canKill) - Number(a.canKill);
            if (killDiff !== 0) return killDiff;

            // 3. Parmi les kills, celui qui porte le plus de bombes
            if (a.canKill && b.canKill) {
                const bombDiff = b.enemy.splashBombs - a.enemy.splashBombs;
                if (bombDiff !== 0) return bombDiff;
            }

            // 4. Dégâts effectifs les plus élevés (rapproche le plus une cible de la mort)
            const damageDiff = b.effectiveDamage - a.effectiveDamage;
            if (damageDiff !== 0) return damageDiff;

            // 5. Tie-breaker : porteurs de bombes
            return b.enemy.splashBombs - a.enemy.splashBombs;
        });

        return sorted[0]?.enemy;
    }

    // =============================================================================
    // SPLASH BOMBS
    // =============================================================================
    private getSplashZone(origin: Coordinates): Coordinates[] {
        return this.getTilesWithinChebyshevDistance({ origin, distance: 1 });
    }

    private isBombTargetInReach({
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
                    touchedEnemies.length === 1 &&
                    this.canTargetBeKilledNow({
                        effectiveDamage: this.estimateEffectiveShotDamage({ shooter: thrower, shooterTarget: touchedEnemies[0] }),
                        wetness: touchedEnemies[0].wetness
                    })
                );

                return {
                    target,
                    touchedAllies,
                    touchedAlliesCount: touchedAllies.length,
                    touchedEnemiesCount: touchedEnemies.length,
                    touchedEnemyBombs,
                    killableEnemiesCount: touchedEnemies.filter((enemy) => enemy.wetness >= 70).length,
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

                const bombDiff = b.touchedEnemyBombs - a.touchedEnemyBombs;
                if (bombDiff !== 0) return bombDiff;

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
        const verticalSpreadPositions = gameMap.getVerticalSpreadPositions({ origin, count: alliesCount });

        return verticalSpreadPositions.sort((a, b) =>
            Math.abs(this.coordinates.y - a.y) -
            Math.abs(this.coordinates.y - b.y)
        )[0];
    }

    /**
     * Cherche l'ennemi le plus proche (menace la plus immédiate / cible la
     * plus facile à engager) pour éviter de foncer vers un barycentre qui
     * peut être un point vide entre deux ennemis éloignés.
     */
    private getClosestEnemy(enemies: Agent[], gameMap: GameMap): Agent {
        return [...enemies].sort(
            (a, b) => gameMap.getManhattanDistance(this.coordinates, a.coordinates)
                - gameMap.getManhattanDistance(this.coordinates, b.coordinates)
        )[0];
    }

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
        const averageAlliesPosition = gameMap.getAveragePosition(
            allies.map((ally) => ally.coordinates)
        );
        const occupiedPositions = [...allies, ...enemies].map((agent) => agent.coordinates);

        switch (formationRole) {
            case 'frontline': {
                // === On avance vers l'ennemi le plus proche, mais on s'arrête
                //     dès qu'on est à portée optimale au lieu de foncer dessus ===
                this.actionService.message(`${gameStrategy} - Engaging`);

                const target = this.getClosestEnemy(enemies, gameMap) ?? { coordinates: averageEnemiesPosition };
                const distanceToTarget = gameMap.getManhattanDistance(this.coordinates, target.coordinates);

                if (distanceToTarget <= this.metaData.optimalRange) {
                    // Déjà à portée idéale : pas besoin d'avancer plus, on va
                    // simplement chercher la meilleure couverture sur place.
                    nextMove = this.coordinates;
                } else {
                    nextMove = target.coordinates;
                }
                break;
            } case 'harass-bomb-owners':
                this.actionService.message(`${gameStrategy} - Give me your bombs`);
                return enemies.reduce((max, enemy) => enemy.splashBombs > max.splashBombs ? enemy : max, enemies[0])?.coordinates;
            case 'controller': {
                // === Tient la ligne médiane pour maximiser le contrôle de
                //     territoire, indépendamment de l'engagement direct ===
                this.actionService.message(`${gameStrategy} - Holding the line`);

                const frontierX = gameMap.getFrontierX(averageAlliesPosition, averageEnemiesPosition);
                nextMove = { x: frontierX, y: this.coordinates.y };
                break;
            }
            case 'follower': {
                this.actionService.message(`${gameStrategy} - Watching your back`);

                const MIN_DISTANCE_FROM_ATTACKERS = 2;
                const frontliners = allies.filter((ally) => ally.behaviorPolicy.formationRole === 'frontline');
                const averageFrontlinePosition = (() => {
                    if (frontliners.length === 0) return this.coordinates;
                    if (frontliners.length === 1) return frontliners[0].coordinates;
                    return gameMap.getAveragePosition(frontliners.map((attacker) => attacker.coordinates));
                })();
                const areEnemiesGroupAtRightOfAllies = averageFrontlinePosition.x < averageEnemiesPosition.x;
                const behindAttackers = {
                    x: areEnemiesGroupAtRightOfAllies ?
                        Math.max(0, averageFrontlinePosition.x - MIN_DISTANCE_FROM_ATTACKERS) :
                        // FIX: off-by-one, la coordonnée max valide est width - 1
                        Math.min(gameMap.width - 1, averageFrontlinePosition.x + MIN_DISTANCE_FROM_ATTACKERS),
                    y: averageEnemiesPosition.y
                };

                nextMove = behindAttackers;
                break;
            }
        }

        const verticalSpread = this.getAgentVerticalSpreadPosition({
            origin: nextMove,
            alliesCount: allies.length,
            gameMap
        });

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
        this.actionService.hunkerDown();

        const canShoot = this.cooldown === 0;
        if (canShoot) {
            const idealShootTarget = gameMap.getIdealShootTarget({
                shooter: this,
                enemies: enemies,
            });
            if (idealShootTarget) this.actionService.shoot(idealShootTarget.agentId);
        }

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

    constructor(private agentId: number) { }

    public move = ({ currentPosition, targetPosition }: { currentPosition: Coordinates; targetPosition: Coordinates; }) => {
        if (targetPosition.x === currentPosition.x && targetPosition.y === currentPosition.y) return this;

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

    public executeActions = () => {
        const moveAction = [...this.actions]
            .reverse()
            .find(action => action.type.name === AgentActionName.MOVE);

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
            console.log(`${this.agentId}; HUNKER_DOWN`);
            return;
        }

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

declare function readline(): string;

const game = new Game();

// game loop
while (true) {
    game.readTurn();
    game.playTurn();
}