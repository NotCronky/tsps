import { World } from "../../../World";
import { ItemOnGroundManager, OperationType } from "../grounditem/ItemOnGroundManager"
import { Player } from "../player/Player"
import { Item } from "../../../model/Item"
import { Location } from "../../../model/Location"
import { PrivateArea } from "../../../model/areas/impl/PrivateArea";

export class ItemOnGround {
    private static nextId = 1;
    private readonly id = ItemOnGround.nextId++;
    position: Location;
    state: State = State.SEEN_BY_PLAYER;
    owner: string | null;
    item: Item;
    tick: number;
    goesGlobal: boolean;
    pendingRemoval: boolean;
    respawnTimer: number = -1;
    /** World cycle in which this item last aged in {@link process}. */
    agedCycle: number = -1;
    oldAmount: number;
    privateArea: PrivateArea;
    /** A static world spawn: never despawns on its own and is visible to everyone.
     * Respawning after a pickup still comes from the respawn timer. */
    staticSpawn: boolean;
    /** Ticks this stack lasts on the floor; null keeps its area's, else {@link ItemOnGroundManager.DESPAWN_DELAY}. */
    despawnDelay: number | null = null;
    /** While set, the stack neither ages nor goes public (a mark of grace while its owner is logged out). */
    agingPaused: boolean = false;

    constructor(state: State, owner: string | undefined, position: Location, item: Item, goesGlobal: boolean, respawnTimer: number, privateArea: PrivateArea, staticSpawn: boolean = false) {
        this.state = state;
        this.owner = owner;
        this.position = position;
        this.item = item;
        this.goesGlobal = goesGlobal;
        this.tick = 0;
        this.pendingRemoval = false;
        this.respawnTimer = respawnTimer;
        this.oldAmount = item?.getAmount?.() ?? 0;
        this.privateArea = privateArea;
        this.staticSpawn = staticSpawn;
    }

    process() {
        this.agedCycle = World.getProcessCycle();
        if (this.agingPaused) {
            return;
        }
        this.incrementTick();
        switch (this.state) {
            case State.SEEN_BY_EVERYONE:
            case State.SEEN_BY_PLAYER:
                // Owner-only items reveal after 100 ticks, but all floor items should
                // persist for a full 300 ticks before removal.
                if (this.state == State.SEEN_BY_PLAYER
                    && this.getgoesGlobal()
                    && this.getTick() >= ItemOnGroundManager.PUBLIC_REVEAL_DELAY) {

                    // We make the item despawn for the owner before re-sending it as public.
                    if (this.getOwner() != null) {
                        let o = World.getPlayerByName(this.getOwner());
                        if (o) {
                            ItemOnGroundManager.performPlayer(o.getAsPlayer(), this, OperationType.DELETE);
                        }
                    }

                    // Check if we need to merge this ground item.
                    // This basically puts together two stackables that are on the same tile.
                    if (this.getItem().getDefinition().isStackable()) {
                        if (ItemOnGroundManager.merge(this)) {
                            this.setPendingRemoval(true);
                            return;
                        }
                    }

                    // Spawn the item globally.
                    this.setState(State.SEEN_BY_EVERYONE);
                    ItemOnGroundManager.perform(this, OperationType.CREATE);
                    return;
                }

                // Item needs to be deleted after its full lifetime expires.
                // However, there's no point in deleting items that will just respawn,
                // nor static world spawns that persist until picked up.
                if (this.getTick() >= this.getDespawnDelay() && !this.respawns() && !this.staticSpawn) {
                    ItemOnGroundManager.deregister(this);
                }
                break;
            default:
                break;
        }
    }

    public getAgedCycle(): number {
        return this.agedCycle;
    }

    public getTiming() {
        return ItemOnGroundManager.getTiming(this);
    }

    public getPosition(): Location {
        return this.position;
    }

    public getId(): number {
        return this.id;
    }

    public getOwner(): string | undefined {
        return this.owner;
    }

    public getItem(): Item {
        return this.item;
    }

    public getTick(): number {
        return this.tick;
    }

    public setTick(tick: number): ItemOnGround {
        this.tick = tick;
        return this;
    }

    public incrementTick(): void {
        this.tick++;
    }

    public getgoesGlobal(): boolean {
        return this.goesGlobal;
    }

    public getState(): State {
        return this.state;
    }

    public setState(state: State): ItemOnGround {
        this.state = state;
        return this;
    }

    public getRespawnTimer(): number {
        return this.respawnTimer;
    }

    public respawns(): boolean {
        return this.respawnTimer > 0;
    }

    public getDespawnDelay(): number {
        return this.despawnDelay ?? this.privateArea?.getGroundItemDespawnDelay?.() ?? ItemOnGroundManager.DESPAWN_DELAY;
    }

    public setDespawnDelay(ticks: number): ItemOnGround {
        this.despawnDelay = ticks;
        return this;
    }

    public isAgingPaused(): boolean {
        return this.agingPaused;
    }
    public setAgingPaused(paused: boolean): ItemOnGround {
        this.agingPaused = paused;
        return this;
    }
    public isStaticSpawn(): boolean {
        return this.staticSpawn;
    }

    public getPrivateArea(): PrivateArea {
        return this.privateArea;
    }

    public getOldAmount(): number {
        return this.oldAmount;
    }

    public setOldAmount(oldAmount: number): void {
        this.oldAmount = oldAmount;
    }

    public isPendingRemoval(): boolean {
        return this.pendingRemoval;
    }

    public setPendingRemoval(pendingRemoval: boolean): void {
        this.pendingRemoval = pendingRemoval;
    }
    public clone(): ItemOnGround {
        const copy = new ItemOnGround(this.state, this.owner, this.getPosition(), this.item.clone(), this.goesGlobal, this.respawnTimer, this.privateArea, this.staticSpawn);
        copy.despawnDelay = this.despawnDelay;
        return copy;
    }

    public equals(o: object): boolean {
        if (!(o instanceof ItemOnGround))
            return false;
        let item = o as ItemOnGround;
        if (item.getOwner() && this.getOwner()) {
            if (item.getOwner() !== this.getOwner()) {
                return false;
            }
        }
        return item.getItem().equals(this.getItem())
            && item.getPosition().equals(this.getPosition())
            && item.getState() == this.getState()
            && item.getTick() == this.getTick()
            && item.getPrivateArea() == this.getPrivateArea();
    }

    public toString(): string {
        return "GroundItem, id: " + this.item.getId() + ", amount: " + this.item.getAmount() + ", current state: " + this.state.toString() + ", goesGlobal: " + this.goesGlobal + ", tick: " + this.tick + ", respawns: " + this.respawns();
    }

}
/**
 * All the possible states a {@link ItemOnGround} can have.
 */

export enum State {
    SEEN_BY_PLAYER, SEEN_BY_EVERYONE
}
