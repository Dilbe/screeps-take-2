const { runStateMachine } = require('creep.states');
const { codeToString } = require('util');

function bodyCost(body){
	return body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
}

// repeats pattern as often as the energy allows, then spends what's left on filler
// e.g. 300 energy: [WORK,CARRY,MOVE] + [CARRY,MOVE]; 400 energy: 2x [WORK,CARRY,MOVE]
function scaledBody(energy, pattern, filler){
	const body = [];
	while(body.length + pattern.length <= MAX_CREEP_SIZE && bodyCost(body) + bodyCost(pattern) <= energy){
		body.push(...pattern);
	}
	while(filler && body.length + filler.length <= MAX_CREEP_SIZE && bodyCost(body) + bodyCost(filler) <= energy){
		body.push(...filler);
	}
	return body;
}

// body per creep class, scaled to the energy the room can spend on it
const BODY_BUILDERS = {
	general: energy => scaledBody(energy, [WORK,CARRY,MOVE], [CARRY,MOVE]),
	hauler: energy => scaledBody(energy, [CARRY,MOVE], [CARRY,MOVE]),
	builder: energy => scaledBody(energy, [WORK,CARRY,MOVE], [CARRY,MOVE]),
	// a source gives 10 energy/tick, which 5 WORK parts fully harvest; more WORK is wasted.
	// one MOVE is enough, the miner only walks to the source once
	miner: energy => {
		const work = Math.max(1, Math.min(6, Math.floor((energy - bodyCost([CARRY,MOVE])) / BODYPART_COST[WORK])));
		return [...Array(work).fill(WORK), CARRY, MOVE];
	},
	upgrader: energy => {
		const work = Math.max(1, Math.min(4, Math.floor((energy - bodyCost([CARRY,MOVE])) / BODYPART_COST[WORK])));
		return [...Array(work).fill(WORK), CARRY, MOVE];
	},
};

// rough estimate of how many ticks a new creep needs to walk to its work area.
// a replacement is spawned when the old creep has (spawn time + travel time) ticks left.
// the miner's walk is calculated instead, see GetMinerLeadTime()
const TRAVEL_TICKS = {
	upgrader: 20,
	builder: 20,
};

// how many ticks a body needs to walk a path.
// each step adds fatigue: (parts that aren't MOVE or empty CARRY) x terrain cost (road 1, plain 2, swamp 10).
// each MOVE part removes 2 fatigue per tick, and the creep can only step again at 0 fatigue.
// assumes the CARRY parts are empty, which is true for a freshly spawned creep
function ticksToWalk(body, path, room){
	const weight = body.filter(part => part !== MOVE && part !== CARRY).length;
	const moveParts = body.filter(part => part === MOVE).length;
	if(moveParts == 0) return Infinity;
	const terrain = room.getTerrain();
	let ticks = 0;
	for(const pos of path){
		let cost = 2;
		if(room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y).some(s => s.structureType === STRUCTURE_ROAD)){
			cost = 1;
		}else if(terrain.get(pos.x, pos.y) & TERRAIN_MASK_SWAMP){
			cost = 10;
		}
		ticks += Math.max(1, Math.ceil(weight * cost / (2 * moveParts)));
	}
	return ticks;
}

// cost matrix for PathFinder: roads are cheap, buildings creeps can't walk through are blocked
function roomCostMatrix(room){
	const costs = new PathFinder.CostMatrix();
	for(const s of room.find(FIND_STRUCTURES)){
		if(s.structureType === STRUCTURE_ROAD){
			costs.set(s.pos.x, s.pos.y, 1);
		}else if(OBSTACLE_OBJECT_TYPES.includes(s.structureType)){
			costs.set(s.pos.x, s.pos.y, 0xff);
		}
	}
	return costs;
}

class MyRoom {
	RoomName;
	Room;
	Source;

	constructor(roomName){
		console.log(roomName + ' room created');
		this.RoomName = roomName;
	}

	Reset(){
		this.Room = null;
		this.Source = null;
		this.SourceContainer = undefined;
		this.ControllerContainer = undefined;
	}

	getRoom(){
		if(this.Room == null){
			this.Room = Game.rooms[this.RoomName];
			if(this.Room == null){
				throw new Error(`Room ${this.RoomName} doesnt exist`);
			}
		}
		return this.Room;
	}

	// creeps: all creeps whose home is this room (grouped in main.js)
	DoLogic(creeps){
		this.Reset();
		this.getRoom();
		this.GetLevel();

		// no need to check the buildings every tick
		if(Game.time % 10 === 0){
			this.PlaceConstructionSites();
		}

		// run every creep, whatever its name; creeps of classes that are no longer wanted keep working until they expire
		const counts = {};
		for(const creep of creeps){
			const cls = creep.memory.class;
			if(!this.IsAboutToExpire(creep)){
				counts[cls] = (counts[cls] || 0) + 1;
			}
			if(!creep.spawning){
				runStateMachine(creep, this);
			}
		}

		this.SpawnMissingCreeps(counts);
	}

	// how many creeps of each class this room wants
	DesiredCreeps(){
		switch(this.GetLevel()){
			case 0: return {};
			case 1: return { general: 2 };
			case 2: return { general: 3, miner: 1 };
			case 3: return { general: 1, miner: 1, hauler: 4, upgrader: 2 };
			default: return { general: 4, miner: 1 };
		}
	}

	// true when it's time to spawn this creep's replacement, so the replacement arrives at the work area when this one dies
	IsAboutToExpire(creep){
		if(creep.spawning) return false;   // ticksToLive is undefined while spawning
		// the miner's spawn and walk time are calculated; for the others, this creep's size is a good enough
		// estimate of the replacement's spawn time, plus a guessed walk time
		const leadTime = creep.memory.class === 'miner'
			? this.GetMinerLeadTime()
			: creep.body.length * CREEP_SPAWN_TIME + (TRAVEL_TICKS[creep.memory.class] || 0);
		return creep.ticksToLive <= leadTime;
	}

	SpawnMissingCreeps(counts){
		// general creeps fill the extensions. without them only the spawn refills itself (up to 300),
		// so a body sized for the full capacity would never be affordable
		const energy = (counts.general || 0) > 0
			? this.Room.energyCapacityAvailable
			: Math.min(this.Room.energyCapacityAvailable, SPAWN_ENERGY_CAPACITY);

		const desired = this.DesiredCreeps();
		for(const cls in desired){
			if((counts[cls] || 0) < desired[cls]){
				if(BODY_BUILDERS[cls] == null){
					throw new Error(`creep class ${cls} doesn't have a BODY_BUILDERS entry!`);
				}
				// spawnCreep returns ERR_NOT_ENOUGH_ENERGY until the spawn and extensions hold enough; it's retried every tick
				this.SpawnCreep(`${this.RoomName}_${cls}_${Game.time}`, BODY_BUILDERS[cls](energy), cls);
				return;   // a spawn can only make one creep at a time
			}
		}
	}

	MyLevel;
	GetLevel(){
		// returns an integer with the following meanings:
		//  0: not captured yet.
		//  1: no buildings built.
		//  2: built the planned container next to the source.
		//  3: also built the container near the controller.
		//  4+: ???
		if(this.Room.controller.level === 0){
			this.MyLevel = 0;
		}else if(this.GetSourceContainer() == null){
			this.MyLevel = 1;
		}else if(this.GetControllerContainer() == null){
			this.MyLevel = 2;
		}else{
			this.MyLevel = 3;
		}
		//console.log("level = " + this.MyLevel);
		return this.MyLevel;
	}

	SpawnCreep(creepName, thingies, creepsClass){
		if(creepsClass == null){
			throw new Error("class has to be set!");
		}
		const spawn = this.GetSpawn();
		if(spawn == null || spawn.spawning) return;
		// memory.room is the creep's home room, so it stays tied to this room even when it walks elsewhere
		const result = spawn.spawnCreep(thingies, creepName, { memory: { state: 'new', class: creepsClass, room: this.RoomName } });
		console.log(`spawning ${creepName}: ${codeToString(result)}`);
		if(result == OK){
			return Game.creeps[creepName];
		}
	}

	GetSpawn(){
		return this.Room.find(FIND_MY_STRUCTURES, {
			filter: { structureType: STRUCTURE_SPAWN }
		})[0] || null;
	}

	// ticks a new miner needs to be spawned and walk from the spawn to its tile next to the source.
	// uses the body a new miner would get now. cached, and recalculated every 1000 ticks so new roads and
	// extensions (bigger body) are taken into account
	MinerLeadTime;
	GetMinerLeadTime(){
		if(this.MinerLeadTime == null || Game.time >= this.MinerLeadTime.recalculateAt){
			const spawn = this.GetSpawn();
			if(spawn == null) return 0;
			const target = this.GetPlan().sourceContainer;
			const body = BODY_BUILDERS.miner(this.Room.energyCapacityAvailable);
			const search = PathFinder.search(spawn.pos, { pos: new RoomPosition(target.x, target.y, this.RoomName), range: 0 }, {
				plainCost: 2,
				swampCost: 10,
				maxRooms: 1,
				roomCallback: roomName => roomName === this.RoomName ? roomCostMatrix(this.Room) : false,
			});
			const spawnTicks = body.length * CREEP_SPAWN_TIME;
			const walkTicks = ticksToWalk(body, search.path, this.Room);
			this.MinerLeadTime = { ticks: spawnTicks + walkTicks, recalculateAt: Game.time + 1000 };
			console.log(`Room ${this.RoomName}: miner lead time ${spawnTicks} spawn + ${walkTicks} walk (${search.path.length} tiles) = ${spawnTicks + walkTicks} ticks`);
		}
		return this.MinerLeadTime.ticks;
	}

	SourceId;
	GetSource(){
		if(this.Source == null){
			if(this.SourceId == null){
				this.Source = this.Room.find(FIND_SOURCES)[0];
				if(this.Source == null){
					throw new Error(`Room ${this.RoomName} doesn't have a source?!`);
				}
				this.SourceId = this.Source.id
				console.log("Lookup new sourceId " + this.Source.id);
			}else{
				this.Source = Game.getObjectById(this.SourceId);
			}
		}
		return this.Source;
	}

	// building plan, based on the path from the source to the controller:
	//  sourceContainer:     the first tile of the path, next to the source
	//  controllerContainer: the tile of the path at range 4 of the controller
	//  road:                the tiles of the path between both containers
	// stored in room memory, so it's only calculated once. delete Memory.rooms[name].plan to recalculate it
	GetPlan(){
		const memory = this.Room.memory;
		if(!memory.plan){
			const source = this.GetSource();
			const controller = this.Room.controller;
			const path = this.Room.findPath(source.pos, controller.pos, { ignoreCreeps: true, range: 1 });
			if(path.length == 0){
				throw new Error(`Room ${this.RoomName}: no path from the source to the controller`);
			}
			const controllerIndex = path.findIndex(step => controller.pos.getRangeTo(step.x, step.y) === 4);
			if(controllerIndex <= 0){
				console.log(`Room ${this.RoomName}: the source is too close to the controller for a separate controller container`);
			}
			memory.plan = {
				sourceContainer: { x: path[0].x, y: path[0].y },
				controllerContainer: controllerIndex > 0 ? { x: path[controllerIndex].x, y: path[controllerIndex].y } : null,
				road: controllerIndex > 0 ? path.slice(1, controllerIndex).map(step => ({ x: step.x, y: step.y })) : [],
			};
			console.log(`Room ${this.RoomName}: building plan ${JSON.stringify(memory.plan)}`);
		}
		return memory.plan;
	}

	// structure of the given type at a plan position, or null
	GetStructureAt(pos, structureType){
		if(pos == null) return null;
		return this.Room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y).find(s => s.structureType === structureType) || null;
	}

	// creates a construction site, unless the structure or a site for it is already there
	EnsureConstructionSite(pos, structureType){
		if(pos == null) return;
		if(this.GetStructureAt(pos, structureType) != null) return;
		const sites = this.Room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y);
		if(sites.some(s => s.structureType === structureType)) return;
		const result = this.Room.createConstructionSite(pos.x, pos.y, structureType);
		console.log(`Room ${this.RoomName}: construction site ${structureType} at ${pos.x},${pos.y}: ${codeToString(result)}`);
	}

	// places the construction sites for the current level; buildings of lower levels are placed again when they're destroyed,
	// because the level drops then
	PlaceConstructionSites(){
		const plan = this.GetPlan();
		switch(this.GetLevel()){
			case 1:
				this.EnsureConstructionSite(plan.sourceContainer, STRUCTURE_CONTAINER);
				break;
			case 2:
				for(const pos of plan.road){
					this.EnsureConstructionSite(pos, STRUCTURE_ROAD);
				}
				this.EnsureConstructionSite(plan.controllerContainer, STRUCTURE_CONTAINER);
				break;
			case 3:
				break;
		}
	}

	// the planned container next to the source, or null when it isn't built (yet); looked up once per tick
	SourceContainer;
	GetSourceContainer(){
		if(this.SourceContainer === undefined){
			this.SourceContainer = this.GetStructureAt(this.GetPlan().sourceContainer, STRUCTURE_CONTAINER);
		}
		return this.SourceContainer;
	}

	// the planned container near the controller, or null when it isn't built (yet); looked up once per tick
	ControllerContainer;
	GetControllerContainer(){
		if(this.ControllerContainer === undefined){
			this.ControllerContainer = this.GetStructureAt(this.GetPlan().controllerContainer, STRUCTURE_CONTAINER);
		}
		return this.ControllerContainer;
	}

	// walkable tiles around a source; terrain never changes, so this is calculated once per global reset
	HarvestSpots = {};
	GetHarvestSpots(source){
		if(!this.HarvestSpots[source.id]){
			const terrain = this.Room.getTerrain();
			const spots = [];
			for(let dx = -1; dx <= 1; dx++){
				for(let dy = -1; dy <= 1; dy++){
					if(dx === 0 && dy === 0) continue;
					const x = source.pos.x + dx;
					const y = source.pos.y + dy;
					if(terrain.get(x, y) !== TERRAIN_MASK_WALL){
						spots.push({ x, y });
					}
				}
			}
			this.HarvestSpots[source.id] = spots;
		}
		return this.HarvestSpots[source.id];
	}
	
	MinerExists(){
		return true;
	}
}

module.exports = { MyRoom };
