const { codeToString, sayReturnCode } = require('util');

class State {
    NextState;

    constructor(nextState) {
        if (new.target === State) {
            throw new Error('State is abstract, create a subclass instead');
        }
        this.NextState = nextState;
    }

    run(creep, originRoom) {
        throw new Error(`${this.constructor.name} must implement run()`);
    }
}

class NewState extends State {
	run(creep, originRoom) {
		return this.NextState;
	}
}

class HarvestState extends State {
    run(creep, originRoom) {
		if(creep.store[RESOURCE_ENERGY] < creep.store.getCapacity()){
			// not full. from level 2 the miner fills the source container, so take energy from there.
			// if the container is empty, fall back to harvesting the source ourselves
			if(originRoom.GetLevel() >= 2){
				const container = originRoom.GetSourceContainer();
				if(container && container.store[RESOURCE_ENERGY] > 0){
					// withdraw only takes effect after the tick; the full check above catches it next tick
					const result = creep.withdraw(container, RESOURCE_ENERGY);
					if(result == ERR_NOT_IN_RANGE){
						creep.moveTo(container, { reusePath: 50 });
					}
					return;
				}
			}

			// harvest some more
			const source = originRoom.GetSource();
			let result = creep.harvest(source);
			if(result == ERR_NOT_IN_RANGE){
				// walk to a free tile next to the source; if all are taken, get close and wait
				const spots = originRoom.GetHarvestSpots(source);
				const free = spots.find(s => originRoom.Room.lookForAt(LOOK_CREEPS, s.x, s.y).length === 0);
				let moveResult = OK;
				if(free){
					moveResult = creep.moveTo(free.x, free.y, { reusePath: 50 });
				}else if(creep.pos.getRangeTo(source) > 2){
					moveResult = creep.moveTo(source, { range: 2, reusePath: 50 });
				}
				sayReturnCode(creep, moveResult);
			}
		}else{
			return this.NextState;
		}
    }
}

// picks up dropped energy in the creep's current room; goes to NextState when full or when there is nothing left to pick up
class PickupState extends State {
	run(creep, originRoom) {
		// store reflects the start of this tick; pickup() only takes effect after the tick
		if(creep.store.getFreeCapacity(RESOURCE_ENERGY) == 0){
			delete creep.memory.pickupTargetId;
			return this.NextState;
		}

		// remember the target, so findClosestByPath isn't needed every tick
		let target = Game.getObjectById(creep.memory.pickupTargetId);
		if(target == null){
			target = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
				filter: r => r.resourceType == RESOURCE_ENERGY
			});
			if(target == null){
				delete creep.memory.pickupTargetId;
				return this.NextState;
			}
			creep.memory.pickupTargetId = target.id;
		}

		const result = creep.pickup(target);
		if(result == ERR_NOT_IN_RANGE){
			creep.moveTo(target, { reusePath: 10 });
		}else if(result == OK){
			// the pile may be gone next tick; search again then
			delete creep.memory.pickupTargetId;
		}
	}
}

// dedicated harvester: stays next to the source and puts its energy in the source container.
// it stands on the tile next to the source that is closest to the container, so once the
// container is next to the source, the miner stands on top of it.
class MinerState extends State {
	run(creep, originRoom) {
		const source = originRoom.GetSource();
		const container = originRoom.GetSourceContainer();

		const spot = this.GetSpot(creep, source, container, originRoom);
		if(spot && !creep.pos.isEqualTo(spot.x, spot.y)){
			// same costs as GetMinerLeadTime() uses (roads 1, plain 2, swamp 10), so the miner prefers roads and
			// walks the route that the lead time was calculated for
			creep.moveTo(spot.x, spot.y, { reusePath: 50, plainCost: 2, swampCost: 10 });
		}

		// harvest uses the position at the start of the tick, so this already works while walking past the source
		creep.harvest(source);

		// only transfer when (almost) full: one transfer moves everything, which saves the 0.2 CPU of transferring every tick.
		// store doesn't include this tick's harvest yet, so check if the next harvest would overflow
		const harvestPerTick = creep.getActiveBodyparts(WORK) * HARVEST_POWER;
		if(container && creep.store.getFreeCapacity(RESOURCE_ENERGY) < harvestPerTick && creep.pos.isNearTo(container)){
			creep.transfer(container, RESOURCE_ENERGY);
		}
	}

	// tile next to the source, closest to the container and not taken by another creep
	GetSpot(creep, source, container, originRoom){
		let best = null;
		let bestRange = Infinity;
		for(const s of originRoom.GetHarvestSpots(source)){
			const creeps = originRoom.Room.lookForAt(LOOK_CREEPS, s.x, s.y);
			if(creeps.length > 0 && creeps[0].id !== creep.id) continue;
			const range = container ? container.pos.getRangeTo(s.x, s.y) : 0;
			if(range < bestRange){
				best = s;
				bestRange = range;
			}
		}
		return best;
	}
}

// brings energy to spawns and extensions that aren't full; goes to NextState when the creep is empty or everything is full
class FillState extends State {
	run(creep, originRoom) {
		// store reflects the start of this tick; transfer() only takes effect after the tick
		if(creep.store[RESOURCE_ENERGY] == 0){
			delete creep.memory.fillTargetId;
			return this.NextState;
		}

		// remember the target, so findClosestByPath isn't needed every tick
		let target = Game.getObjectById(creep.memory.fillTargetId);
		if(target == null || target.store.getFreeCapacity(RESOURCE_ENERGY) == 0){
			target = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
				filter: s => (s.structureType == STRUCTURE_SPAWN || s.structureType == STRUCTURE_EXTENSION)
					&& s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
			});
			if(target == null){
				delete creep.memory.fillTargetId;
				return this.NextState;
			}
			creep.memory.fillTargetId = target.id;
		}

		const result = creep.transfer(target, RESOURCE_ENERGY);
		if(result == ERR_NOT_IN_RANGE){
			creep.moveTo(target, { reusePath: 10 });
		}else if(result == OK){
			// the target is probably full next tick; search again then
			delete creep.memory.fillTargetId;
		}
	}
}

// repairs damaged structures; goes to NextState when the creep is empty or nothing needs repairing.
// a structure needs repairing when it's below 80% hits, or missing more hits than the creep's energy can repair.
// once started, it keeps repairing that structure until it's at full hits.
class RepairState extends State {
	run(creep, originRoom) {
		// store reflects the start of this tick; repair() only takes effect after the tick
		const energy = creep.store[RESOURCE_ENERGY];
		if(energy == 0){
			delete creep.memory.repairTargetId;
			return this.NextState;
		}

		// remember the target, so findClosestByPath isn't needed every tick
		let target = Game.getObjectById(creep.memory.repairTargetId);
		if(target == null || target.hits >= target.hitsMax){
			// 1 energy repairs 1 / REPAIR_COST = 100 hits
			const repairableHits = energy / REPAIR_COST;
			target = creep.pos.findClosestByPath(FIND_STRUCTURES, {
				filter: s => s.hits < s.hitsMax
					// walls and ramparts have millions of hits and would never be done; leave those for later
					&& s.structureType != STRUCTURE_WALL && s.structureType != STRUCTURE_RAMPART
					&& (s.hits < s.hitsMax * 0.8 || s.hitsMax - s.hits > repairableHits)
			});
			if(target == null){
				delete creep.memory.repairTargetId;
				return this.NextState;
			}
			creep.memory.repairTargetId = target.id;
		}

		const result = creep.repair(target);
		if(result == ERR_NOT_IN_RANGE){
			creep.moveTo(target, { reusePath: 10 });
		}
	}
}

// keeps the room from being lost: upgrades the controller when it's close to downgrading.
// once started, it spends all the creep's energy on it; goes to NextState when the creep is empty or the controller is safe
const CONTROLLER_DOWNGRADE_THRESHOLD = 1000;
class KeepControllerState extends State {
	run(creep, originRoom) {
		const controller = originRoom.Room.controller;
		// store reflects the start of this tick; upgradeController() only takes effect after the tick
		if(creep.store[RESOURCE_ENERGY] == 0 || controller == null || !controller.my){
			delete creep.memory.keepingController;
			return this.NextState;
		}
		if(!creep.memory.keepingController){
			if(controller.ticksToDowngrade >= CONTROLLER_DOWNGRADE_THRESHOLD){
				return this.NextState;
			}
			creep.memory.keepingController = true;
		}

		const result = creep.upgradeController(controller);
		if(result == ERR_NOT_IN_RANGE){
			creep.moveTo(controller, { range: 3, reusePath: 50 });
		}
	}
}

class UpgradeState extends State {
    run(creep, originRoom) {
		// if empty. then go to next state
		if(creep.store[RESOURCE_ENERGY] == 0){
			return this.NextState;
		}	

		const controller = originRoom.Room.controller;
		const result = creep.upgradeController(controller);
		if(result == ERR_NOT_IN_RANGE){
			creep.moveTo(controller);
		}		
    }
}

class BuildState extends State {
    run(creep, originRoom) {
		// if empty. then harvest go to next state
		if(creep.store[RESOURCE_ENERGY] == 0){
			return this.NextState;
		}

		const site = creep.pos.findClosestByPath(FIND_CONSTRUCTION_SITES);
		//const constructionSites = originRoom.Room.find(FIND_CONSTRUCTION_SITES);
		// nothing to build, move on (e.g. to upgrading) instead of standing around with energy
		if(site == null)
			return this.NextState;
		
		const result = creep.build(site);
		if(result == ERR_NOT_IN_RANGE){
			creep.moveTo(site);
		}
    }
}

const UPGRADER_STATES = {
    new: new NewState('harvest'),
    harvest: new HarvestState('upgrade'),
    upgrade: new UpgradeState('harvest'),
};

const BUILDER_STATES = {
    new: new NewState('harvest'),
    harvest: new HarvestState('build'),
    build: new BuildState('harvest'),
};

const GENERAL_STATES = {
    new: new NewState('pickup'),
    pickup: new PickupState('harvest'),
    harvest: new HarvestState('keepController'),
    keepController: new KeepControllerState('fill'),
    fill: new FillState('repair'),
    repair: new RepairState('build'),
    build: new BuildState('upgrade'),
    upgrade: new UpgradeState('pickup'),
};

const MINER_STATES = {
    new: new NewState('mine'),
    mine: new MinerState(null),
};

const CREEP_CLASSES = {
	miner : MINER_STATES,
	upgrader : UPGRADER_STATES,
	builder : BUILDER_STATES,
	general : GENERAL_STATES
};

function runStateMachine(creep, originRoom) {
	// run the state logic. Max of 5 times, in case of a stupid infiniate loop bug
	let i = 0;
	let startState = creep.memory.state
	let states = CREEP_CLASSES[creep.memory.class];
	do
	{
		let newState = states[creep.memory.state].run(creep, originRoom);
		if(newState != null){
			creep.memory.state = newState;
		}
		i++;
	}while((i < 5) && (startState != creep.memory.state));
}

module.exports = { runStateMachine };