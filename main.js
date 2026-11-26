const { MyRoom } = require('myroom');

console.log(Game.time);

Memory.drawPaths = false;
let mycache = {};   // runs once per global reset, then stays

module.exports.loop = function () {
const before = Game.cpu.getUsed();
Memory;
    if (mycache.lastProcessedTick !== Game.time - 1)
	{
		console.log('cache reset');
		mycache.rooms = {};
		//mycache.room = new MyRoom("W8N5");
	}
    mycache.lastProcessedTick = Game.time;

	if(!Array.isArray(Memory.myRooms)){
		console.log('Memory.myRooms is not set, e.g. Memory.myRooms = ["W8N5"]');
		return;
	}

	// pick up rooms added to / removed from Memory.myRooms without needing a global reset
	for(const roomName of Memory.myRooms){
		if(!mycache.rooms[roomName]){
			mycache.rooms[roomName] = new MyRoom(roomName);
		}
	}
	for(const roomName in mycache.rooms){
		if(!Memory.myRooms.includes(roomName)){
			delete mycache.rooms[roomName];
		}
	}

	// Screeps doesn't remove the memory of dead creeps itself
	for(const name in Memory.creeps){
		if(!Game.creeps[name]) delete Memory.creeps[name];
	}

	// group creeps by home room, so rooms don't need to know creep names
	const creepsByRoom = {};
	for(const name in Game.creeps){
		const creep = Game.creeps[name];
		const home = creep.memory.room || creep.room.name;   // fallback for creeps spawned before memory.room existed
		if(!creepsByRoom[home]) creepsByRoom[home] = [];
		creepsByRoom[home].push(creep);
	}

	for(const roomName in mycache.rooms){
		mycache.rooms[roomName].DoLogic(creepsByRoom[roomName] || []);
	}
	//mycache.room.DoLogic();

	console.log(`ticks cpu usage parse (${Game.time}): ${(Game.cpu.getUsed() - before).toFixed(3)} CPU`);
};
