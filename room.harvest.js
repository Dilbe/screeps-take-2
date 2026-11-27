class HarvestRoom {
	RoomName;
	ParentRoom;
	constructor(roomName, parentRoom){
		console.log('harvest room ' +roomName + ' created');
		this.RoomName = roomName;
		this.ParentRoom = parentRoom;
	}

    DoLogic(){
        console.log("harvest?");
return;
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
		switch(this.ParentRoom.GetLevel()){
			default: return { general: 1 };
		}
	}

	SpawnMissingCreeps(counts){
		// general creeps fill the extensions. without them only the spawn refills itself (up to 300),
		// so a body sized for the full capacity would never be affordable
		const energy = (counts.general || 0) > 0
			? this.ParentRoom.Room.energyCapacityAvailable
			: Math.min(this.ParentRoom.Room.energyCapacityAvailable, SPAWN_ENERGY_CAPACITY);

		const desired = this.DesiredCreeps();
		for(const cls in desired){
			if((counts[cls] || 0) < desired[cls]){
				if(BODY_BUILDERS[cls] == null){
					throw new Error(`creep class ${cls} doesn't have a BODY_BUILDERS entry!`);
				}
				// spawnCreep returns ERR_NOT_ENOUGH_ENERGY until the spawn and extensions hold enough; it's retried every tick
				this.ParentRoom.SpawnCreep(`${this.RoomName}_${cls}_${Game.time}`, BODY_BUILDERS[cls](energy), cls);
				return;   // a spawn can only make one creep at a time
			}
		}
	}
}

module.exports = { HarvestRoom };